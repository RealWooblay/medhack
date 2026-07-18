import { describe, expect, it, vi } from 'vitest'

import {
  handlePharmCATGateway,
  PharmCATRunReadError,
  readCompletedPharmCATRun,
  readPharmCATGatewayConfig,
} from '../../../api/pharmcat/[...path]'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = 'A'.repeat(43)
const SERVICE_URL = 'https://pgx-control-abc-a1.a.run.app'
const LOCAL_ENV = {
  PHARMCAT_SERVICE_URL: SERVICE_URL,
  PHARMCAT_SERVICE_AUDIENCE: SERVICE_URL,
  PHARMCAT_SESSION_SECRET: 's'.repeat(64),
}

function input() {
  return {
    fileName: 'genome.vcf',
    format: 'vcf',
    sizeBytes: 123,
    browserSha256: '0'.repeat(64),
    genomeBuild: 'GRCh38',
  }
}

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    runId: RUN_ID,
    status,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:01.000Z',
    expiresAt: '2026-07-18T00:15:00.000Z',
    input: input(),
    ...extra,
  }
}

function createRequest(body: Record<string, unknown> = {}) {
  return new Request('https://app.example/api/pharmcat/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: 'genome.vcf',
      inputFormat: 'vcf',
      sizeBytes: 123,
      sha256: '0'.repeat(64),
      genomeBuild: 'GRCh38',
      ...body,
    }),
  })
}

function uploadRun(url = 'https://storage.googleapis.com/upload/storage/v1/b/pgx-runs/o?uploadType=resumable&name=runs%2Fx&upload_id=opaque') {
  return run('awaiting_upload', {
    upload: {
      protocol: 'gcs-resumable',
      url,
      method: 'PUT',
      headers: { 'Content-Type': 'text/vcf' },
      chunkSizeBytes: 8 * 1024 * 1024,
      expiresAt: '2026-07-18T00:15:00.000Z',
    },
  })
}

describe('PharmCAT Vercel gateway', () => {
  it('forwards metadata only and returns an object-scoped resumable session', async () => {
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => Response.json(uploadRun(), { status: 201 }))
    const response = await handlePharmCATGateway(createRequest(), {
      env: LOCAL_ENV,
      fetchImpl: fetchImpl as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
      randomSessionId: () => SESSION_ID,
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, options] = fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit?]
    expect(url).toBe(`${SERVICE_URL}/v1/runs`)
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer cloud-run-id-token',
      'X-PGX-Tenant': expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(JSON.parse(String(options?.body))).toEqual({
      fileName: 'genome.vcf',
      inputFormat: 'vcf',
      sizeBytes: 123,
      sha256: '0'.repeat(64),
      genomeBuild: 'GRCh38',
    })
    expect(String(options?.body)).not.toContain('##fileformat')
  })

  it('rejects any client-supplied object destination or raw bytes', async () => {
    const fetchImpl = vi.fn()
    const response = await handlePharmCATGateway(createRequest({
      uploadUrl: 'https://attacker.example/input',
      contents: '##fileformat=VCFv4.2',
    }), {
      env: LOCAL_ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getIdToken: async () => 'unused',
      randomSessionId: () => SESSION_ID,
    })
    expect(response.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a create request without an exact source digest', async () => {
    const fetchImpl = vi.fn()
    const response = await handlePharmCATGateway(createRequest({ sha256: undefined }), {
      env: LOCAL_ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getIdToken: async () => 'unused',
      randomSessionId: () => SESSION_ID,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a control service that returns a non-GCS upload destination', async () => {
    const response = await handlePharmCATGateway(createRequest(), {
      env: LOCAL_ENV,
      fetchImpl: (async () => Response.json(uploadRun('https://attacker.example/upload?upload_id=x'), { status: 201 })) as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
      randomSessionId: () => SESSION_ID,
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_service_response' } })
  })

  it('does not reveal a run without its signed private session', async () => {
    const fetchImpl = vi.fn()
    const response = await handlePharmCATGateway(
      new Request(`https://app.example/api/pharmcat/runs/${RUN_ID}`),
      {
        env: LOCAL_ENV,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getIdToken: async () => 'unused',
      },
    )
    expect(response.status).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not reveal a run with a forged or tampered session cookie', async () => {
    const create = await handlePharmCATGateway(createRequest(), {
      env: LOCAL_ENV,
      fetchImpl: (async () => Response.json(uploadRun(), { status: 201 })) as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
      randomSessionId: () => SESSION_ID,
    })
    const validCookie = create.headers.get('set-cookie')?.split(';', 1)[0]
    expect(validCookie).toBeTruthy()
    const last = validCookie!.at(-1)
    const tamperedCookie = `${validCookie!.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
    const forgedCookie = `pgx_session=${SESSION_ID}.${'A'.repeat(43)}`
    const fetchImpl = vi.fn()

    for (const cookie of [forgedCookie, tamperedCookie]) {
      const response = await handlePharmCATGateway(
        new Request(`https://app.example/api/pharmcat/runs/${RUN_ID}`, {
          headers: { Cookie: cookie },
        }),
        {
          env: LOCAL_ENV,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          getIdToken: async () => 'unused',
        },
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: { code: 'run_not_found', message: 'The genome-analysis run was not found.' },
      })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rehydrates a completed run server-side using the same tenant-bound cookie', async () => {
    const create = await handlePharmCATGateway(createRequest(), {
      env: LOCAL_ENV,
      fetchImpl: (async () => Response.json(uploadRun(), { status: 201 })) as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
      randomSessionId: () => SESSION_ID,
    })
    const cookie = create.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()
    const completed = run('complete', {
      manifest: { schemaVersion: '1.0', runId: RUN_ID, status: 'complete' },
      report: { pharmcatVersion: '3.3.0' },
    })
    const request = new Request('https://app.example/api/clinical-review', {
      method: 'POST',
      headers: { Cookie: cookie! },
    })
    const result = await readCompletedPharmCATRun(request, RUN_ID, {
      env: LOCAL_ENV,
      fetchImpl: (async () => Response.json(completed)) as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
    })
    expect(result.status).toBe('complete')
    expect(result.report).toEqual({ pharmcatVersion: '3.3.0' })
  })

  it('will not rehydrate a queued run as authoritative AI context', async () => {
    const create = await handlePharmCATGateway(createRequest(), {
      env: LOCAL_ENV,
      fetchImpl: (async () => Response.json(uploadRun(), { status: 201 })) as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
      randomSessionId: () => SESSION_ID,
    })
    const cookie = create.headers.get('set-cookie')?.split(';', 1)[0]
    const request = new Request('https://app.example/api/clinical-review', {
      method: 'POST',
      headers: { Cookie: cookie! },
    })
    await expect(readCompletedPharmCATRun(request, RUN_ID, {
      env: LOCAL_ENV,
      fetchImpl: (async () => Response.json(run('queued'))) as typeof fetch,
      getIdToken: async () => 'cloud-run-id-token',
    })).rejects.toMatchObject({ code: 'run_not_complete', status: 409 } satisfies Partial<PharmCATRunReadError>)
  })

  it('requires a controlled Cloud Run URL and matching ID-token audience', () => {
    expect(() => readPharmCATGatewayConfig({
      ...LOCAL_ENV,
      PHARMCAT_SERVICE_URL: 'https://attacker.example',
      PHARMCAT_SERVICE_AUDIENCE: 'https://attacker.example',
    })).toThrow()
    expect(() => readPharmCATGatewayConfig({
      ...LOCAL_ENV,
      PHARMCAT_SERVICE_AUDIENCE: 'https://different.run.app',
    })).toThrow()
  })
})
