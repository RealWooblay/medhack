import { afterEach, describe, expect, it, vi } from 'vitest'

import { PharmCATServiceError, runGenome } from '../client'
import type { PharmCATRunResponse } from '../types'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const UPLOAD_URL = 'https://storage.googleapis.com/upload/storage/v1/b/pgx/o?uploadType=resumable&upload_id=opaque'
const ZERO_FILE_SHA256 = '886715e4051e827f4fe215df3053af3f85ad0d352db2c829c7487af6d78efe30'
const CONSUMER_SHA256 = '5297b45d6d3b87136ece083681111d9914b464f93e30da5ae6ce3d8d6416f205'

function baseRun(status: PharmCATRunResponse['status']): PharmCATRunResponse {
  return {
    schemaVersion: '1.0',
    runId: RUN_ID,
    status,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:01.000Z',
    expiresAt: '2026-07-18T00:15:00.000Z',
    input: {
      fileName: 'genome.vcf',
      format: 'vcf',
      sizeBytes: 300_000,
      browserSha256: ZERO_FILE_SHA256,
      genomeBuild: 'GRCh38',
    },
  }
}

function createdRun(): PharmCATRunResponse {
  return {
    ...baseRun('awaiting_upload'),
    upload: {
      protocol: 'gcs-resumable',
      url: UPLOAD_URL,
      method: 'PUT',
      headers: { 'Content-Type': 'text/vcf' },
      chunkSizeBytes: 256 * 1024,
      expiresAt: '2026-07-18T00:15:00.000Z',
    },
  }
}

function completedRun(): PharmCATRunResponse {
  return {
    ...baseRun('complete'),
    manifest: {
      schemaVersion: '1.0',
      runId: RUN_ID,
      status: 'complete',
      createdAt: '2026-07-18T00:00:00.000Z',
      startedAt: '2026-07-18T00:00:01.000Z',
      completedAt: '2026-07-18T00:00:02.000Z',
      input: {
        format: 'vcf',
        sizeBytes: 300_000,
        sha256: ZERO_FILE_SHA256,
        objectGeneration: '1',
        genomeBuild: 'GRCh38',
        sampleCount: 1,
        recordCount: 1,
        uncompressedSizeBytes: 300_000,
      },
      caller: {
        image: 'pgkb/pharmcat:3.3.0@sha256:' + 'b'.repeat(64),
        imageDigest: 'sha256:' + 'b'.repeat(64),
        workerImageDigest: 'sha256:' + 'c'.repeat(64),
        command: ['pharmcat_pipeline'],
        pharmcatVersion: '3.3.0',
        pharmcatDataVersion: null,
        cloudRunExecution: 'execution',
        cyp2d6OutsideCall: false,
      },
      outputs: {
        reporterSha256: 'd'.repeat(64),
        restrictedReporterSha256: 'e'.repeat(64),
        missingPositionsSha256: 'f'.repeat(64),
        coverageSha256: '1'.repeat(64),
        missingPositionCount: 0,
      },
      coverage: {
        CYP2C19: { status: 'measured', positionsCalled: 1, positionsMissing: 0, missingPositionLabels: [] },
        CYP2B6: { status: 'measured', positionsCalled: 1, positionsMissing: 0, missingPositionLabels: [] },
      },
      exclusions: [{ gene: 'CYP2D6', reason: 'No outside call.' }],
    },
    report: { pharmcatVersion: '3.3.0' },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('raw-genome PharmCAT client', () => {
  it('sends raw bytes only to the object-scoped resumable session and returns a sealed result', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === '/api/pharmcat/runs') return Response.json(createdRun(), { status: 201 })
      if (url === UPLOAD_URL) {
        const range = new Headers(init?.headers).get('Content-Range')
        if (range === 'bytes 0-262143/300000') {
          return new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } })
        }
        expect(range).toBe('bytes 262144-299999/300000')
        return new Response(null, { status: 200 })
      }
      if (url === `/api/pharmcat/runs/${RUN_ID}/submit`) return Response.json(completedRun())
      throw new Error(`unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchImpl)
    const phases: string[] = []
    const file = new File([new Uint8Array(300_000)], 'genome.vcf', { type: 'text/vcf' })
    const result = await runGenome(file, {
      inputFormat: 'vcf',
      genomeBuild: 'GRCh38',
      onStatus: ({ phase }) => phases.push(phase),
    })

    expect(result.status).toBe('complete')
    expect(phases).toEqual(['uploading', 'analysing', 'complete'])
    const apiCreate = calls.find((call) => call.url === '/api/pharmcat/runs')!
    expect(apiCreate.init?.body).toBe(JSON.stringify({
      fileName: 'genome.vcf',
      inputFormat: 'vcf',
      sizeBytes: 300_000,
      sha256: ZERO_FILE_SHA256,
      genomeBuild: 'GRCh38',
    }))
    const rawBodies = calls.filter((call) => call.url === UPLOAD_URL).map((call) => call.init?.body)
    expect(rawBodies).toHaveLength(2)
    expect(rawBodies.every((body) => body instanceof Blob)).toBe(true)
    expect(calls.filter((call) => call.url.startsWith('/api/')).every((call) => !(call.init?.body instanceof Blob))).toBe(true)
  })

  it('stops before upload when the service rejects unsupported consumer data', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      error: {
        code: 'unsupported_input',
        message: 'Consumer conversion is not enabled.',
      },
    }, { status: 422 }))
    vi.stubGlobal('fetch', fetchImpl)
    const file = new File(['rs1\t1\t100\tAA\n'], 'consumer.txt', { type: 'text/plain' })
    await expect(runGenome(file, { inputFormat: 'consumer-genotype' }))
      .rejects.toMatchObject({ code: 'unsupported_input' } satisfies Partial<PharmCATServiceError>)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0][0])).toBe('/api/pharmcat/runs')
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ sha256: CONSUMER_SHA256 })
  })

  it('fails closed before creating a run when browser hashing is unavailable', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    vi.stubGlobal('crypto', undefined)
    const file = new File(['##fileformat=VCFv4.2\n'], 'genome.vcf', { type: 'text/vcf' })

    await expect(runGenome(file, { inputFormat: 'vcf', genomeBuild: 'GRCh38' }))
      .rejects.toMatchObject({ code: 'integrity_check_unavailable' } satisfies Partial<PharmCATServiceError>)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not let a caller override the digest of the selected source bytes', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const file = new File([new Uint8Array(300_000)], 'genome.vcf', { type: 'text/vcf' })

    await expect(runGenome(file, {
      inputFormat: 'vcf',
      genomeBuild: 'GRCh38',
      sha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'integrity_check_failed' } satisfies Partial<PharmCATServiceError>)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('queries the committed offset before retrying a transient storage failure', async () => {
    let firstChunkAttempts = 0
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === '/api/pharmcat/runs') return Response.json(createdRun(), { status: 201 })
      if (url === UPLOAD_URL) {
        const range = new Headers(init?.headers).get('Content-Range')
        if (range === 'bytes */300000') return new Response(null, { status: 308 })
        if (range === 'bytes 0-262143/300000') {
          firstChunkAttempts += 1
          if (firstChunkAttempts === 1) return new Response(null, { status: 503 })
          return new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } })
        }
        expect(range).toBe('bytes 262144-299999/300000')
        return new Response(null, { status: 200 })
      }
      if (url === `/api/pharmcat/runs/${RUN_ID}/submit`) return Response.json(completedRun())
      throw new Error(`unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchImpl)
    const file = new File([new Uint8Array(300_000)], 'genome.vcf', { type: 'text/vcf' })

    await expect(runGenome(file, { inputFormat: 'vcf', genomeBuild: 'GRCh38' }))
      .resolves.toMatchObject({ status: 'complete' })
    expect(calls.filter((call) => (
      call.url === UPLOAD_URL && new Headers(call.init?.headers).get('Content-Range') === 'bytes */300000'
    ))).toHaveLength(1)
    expect(firstChunkAttempts).toBe(2)
  })

  it('does not retry or submit after a permanent storage rejection', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === '/api/pharmcat/runs') return Response.json(createdRun(), { status: 201 })
      if (url === UPLOAD_URL) return new Response(null, { status: 400 })
      throw new Error(`unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchImpl)
    const file = new File([new Uint8Array(300_000)], 'genome.vcf', { type: 'text/vcf' })

    await expect(runGenome(file, { inputFormat: 'vcf', genomeBuild: 'GRCh38' }))
      .rejects.toMatchObject({ code: 'upload_failed', status: 400 } satisfies Partial<PharmCATServiceError>)
    expect(calls.filter((url) => url === UPLOAD_URL)).toHaveLength(1)
    expect(calls.some((url) => url.endsWith('/submit'))).toBe(false)
  })
})
