import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { createControlHandler } from '../src/control.mjs'

const TENANT = 'a'.repeat(64)
const OTHER_TENANT = 'b'.repeat(64)
const FIXED_NOW = new Date('2026-07-18T00:00:00.000Z')
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
]
const ENV = {
  PHARMCAT_RUN_BUCKET: 'pgx-run-test',
  PHARMCAT_JOB_NAME: 'projects/pgx-test-123/locations/australia-southeast1/jobs/pharmcat-worker',
  PHARMCAT_JOB_CONTAINER: 'worker',
  PHARMCAT_IMAGE: 'pgkb/pharmcat:3.3.0@sha256:e9b02865a0abe1a0085ac0d7625f1ec33a06a56e9571d5befb16f90d4fedc435',
  PHARMCAT_WORKER_IMAGE_DIGEST: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  PGX_APP_ORIGIN: 'https://app.example',
}
const CYP2D6_WITHHELD_REASON = 'No validated structural/copy-number-aware CYP2D6 outside call was supplied for this run.'
const OUTSIDE_ANTIDEPRESSANT_SCOPE_REASON = 'Outside this antidepressant pharmacogenomics analysis scope.'

function inMemoryGoogle() {
  const objects = new Map()
  let generation = 0
  const write = (name, body, contentType) => {
    generation += 1
    const value = {
      bytes: typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
      contentType,
      generation: String(generation),
      crc32c: 'test-crc',
    }
    objects.set(name, value)
    return value
  }
  const fetchImpl = async (input, init = {}) => {
    const target = new URL(String(input))
    if (target.hostname === 'run.googleapis.com') {
      if (init.method !== 'POST') {
        return Response.json({
          template: {
            template: {
              containers: [{
                name: 'worker',
                image: 'australia-southeast1-docker.pkg.dev/pgx-test-123/pgx/pharmcat-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              }],
            },
          },
        })
      }
      return Response.json({ name: 'operations/test-dispatch' })
    }
    if (target.hostname !== 'storage.googleapis.com') return new Response(null, { status: 404 })
    if (target.pathname.startsWith('/upload/storage/v1/b/') && target.searchParams.get('uploadType') === 'resumable') {
      return new Response(null, {
        status: 200,
        headers: {
          Location: 'https://storage.googleapis.com/upload/storage/v1/b/pgx-run-test/o?uploadType=resumable&name=sealed&upload_id=object-scoped-session',
        },
      })
    }
    if (target.pathname.startsWith('/upload/storage/v1/b/') && target.searchParams.get('uploadType') === 'media') {
      const name = target.searchParams.get('name')
      if (!name) return new Response(null, { status: 400 })
      const current = objects.get(name)
      const match = target.searchParams.get('ifGenerationMatch')
      if ((match === '0' && current) || (match !== '0' && match !== current?.generation)) {
        return new Response(null, { status: 412 })
      }
      const body = init.body === undefined ? '' : String(init.body)
      const stored = write(name, body, new Headers(init.headers).get('content-type') ?? 'application/octet-stream')
      return Response.json({ generation: stored.generation, size: String(stored.bytes.byteLength) })
    }
    if (target.pathname.startsWith('/storage/v1/b/')) {
      const marker = '/o/'
      const offset = target.pathname.indexOf(marker)
      const name = decodeURIComponent(target.pathname.slice(offset + marker.length))
      const stored = objects.get(name)
      if (!stored) return new Response(null, { status: 404 })
      if (target.searchParams.get('alt') === 'media') {
        return new Response(stored.bytes, {
          status: 200,
          headers: { 'Content-Type': stored.contentType, 'Content-Length': String(stored.bytes.byteLength) },
        })
      }
      return Response.json({
        generation: stored.generation,
        size: String(stored.bytes.byteLength),
        contentType: stored.contentType,
        crc32c: stored.crc32c,
      })
    }
    return new Response(null, { status: 404 })
  }
  return { objects, write, fetchImpl }
}

function request(path, method = 'GET', body, tenant = TENANT) {
  return new Request(`https://control.internal${path}`, {
    method,
    headers: {
      'X-PGX-Tenant': tenant,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function queuedRun() {
  const google = inMemoryGoogle()
  let idIndex = 0
  const handle = createControlHandler({
    env: ENV,
    fetchImpl: google.fetchImpl,
    getAccessToken: async () => 'short-lived-token',
    now: () => FIXED_NOW,
    randomUUID: () => IDS[idIndex++],
  })
  const created = await (await handle(request('/v1/runs', 'POST', {
    fileName: 'genome.vcf',
    inputFormat: 'vcf',
    sizeBytes: 3,
    sha256: 'b'.repeat(64),
    genomeBuild: 'GRCh38',
  }))).json()
  google.write(`runs/${TENANT}/${created.runId}/input/source`, 'vcf', 'text/vcf')
  const submitted = await (await handle(request(`/v1/runs/${created.runId}/submit`, 'POST', {}))).json()
  return { google, handle, runId: submitted.runId }
}

function sealCompletedRun(google, runId) {
  const prefix = `runs/${TENANT}/${runId}`
  const stateStored = google.objects.get(`${prefix}/state.json`)
  const state = JSON.parse(new TextDecoder().decode(stateStored.bytes))
  state.status = 'complete'
  state.workerExecution = 'executions/verified-worker'
  google.write(`${prefix}/state.json`, JSON.stringify(state), 'application/json')

  const originalReport = {
    pharmcatVersion: '3.3.0',
    dataVersion: null,
    genes: { 'HLA-B': {}, CYP2D6: {}, CYP2C19: {}, CYP2B6: {} },
    drugs: { 'CPIC Guideline Annotation': {} },
  }
  const restrictedReport = {
    pharmcatVersion: '3.3.0',
    dataVersion: null,
    genes: { CYP2C19: {}, CYP2B6: {} },
    drugs: { 'CPIC Guideline Annotation': {} },
  }
  const originalBytes = new TextEncoder().encode(JSON.stringify(originalReport))
  const restrictedBytes = new TextEncoder().encode(JSON.stringify(restrictedReport))
  const missingBytes = new TextEncoder().encode('##fileformat=VCFv4.2\n')
  const genes = {
    CYP2C19: { status: 'measured', positionsCalled: 2, positionsMissing: 1, missingPositionLabels: ['rs-missing'] },
    CYP2B6: { status: 'measured', positionsCalled: 1, positionsMissing: 0, missingPositionLabels: [] },
  }
  const coverage = { schemaVersion: '1.0', runId, genes }
  const coverageBytes = new TextEncoder().encode(JSON.stringify(coverage))
  google.write(`${prefix}/output/reporter.original.json`, originalBytes, 'application/json')
  google.write(`${prefix}/output/reporter.restricted.json`, restrictedBytes, 'application/json')
  google.write(`${prefix}/output/missing_pgx_var.vcf`, missingBytes, 'text/vcf')
  google.write(`${prefix}/output/coverage.json`, coverageBytes, 'application/json')

  const manifest = {
    schemaVersion: '1.0',
    runId,
    status: 'complete',
    createdAt: state.createdAt,
    startedAt: state.updatedAt,
    completedAt: state.updatedAt,
    input: {
      format: 'vcf',
      sizeBytes: 3,
      sha256: 'b'.repeat(64),
      objectGeneration: state.input.objectGeneration,
      genomeBuild: 'GRCh38',
      sampleCount: 1,
      recordCount: 1,
      uncompressedSizeBytes: 3,
    },
    caller: {
      image: ENV.PHARMCAT_IMAGE,
      imageDigest: ENV.PHARMCAT_IMAGE.split('@')[1],
      workerImageDigest: ENV.PHARMCAT_WORKER_IMAGE_DIGEST,
      command: ['pharmcat_pipeline', 'input.vcf', '-o', 'output', '-reporterJson', '-reporterCallsOnlyTsv'],
      pharmcatVersion: '3.3.0',
      pharmcatDataVersion: null,
      cloudRunExecution: state.workerExecution,
      cyp2d6OutsideCall: false,
    },
    outputs: {
      reporterSha256: hash(originalBytes),
      restrictedReporterSha256: hash(restrictedBytes),
      missingPositionsSha256: hash(missingBytes),
      coverageSha256: hash(coverageBytes),
      missingPositionCount: 1,
    },
    coverage: genes,
    geneScope: {
      unrestrictedReporterGeneCount: 4,
      unrestrictedReporterGenes: ['CYP2B6', 'CYP2C19', 'CYP2D6', 'HLA-B'],
      antidepressantRelevantGenes: ['CYP2B6', 'CYP2C19', 'CYP2D6'],
      retainedReporterGenes: ['CYP2B6', 'CYP2C19'],
      withheldReporterGenes: [
        { gene: 'CYP2D6', reason: CYP2D6_WITHHELD_REASON },
        { gene: 'HLA-B', reason: OUTSIDE_ANTIDEPRESSANT_SCOPE_REASON },
      ],
    },
    exclusions: [{ gene: 'CYP2D6', reason: CYP2D6_WITHHELD_REASON }],
  }
  google.write(`${prefix}/manifest.final.json`, JSON.stringify(manifest), 'application/json')
  return prefix
}

function mutateManifest(google, prefix, mutate) {
  const name = `${prefix}/manifest.final.json`
  const stored = google.objects.get(name)
  const manifest = JSON.parse(new TextDecoder().decode(stored.bytes))
  mutate(manifest)
  google.write(name, JSON.stringify(manifest), 'application/json')
}

describe('PharmCAT control service', () => {
  it('creates, submits and reads the same standard UUID run without changing ownership', async () => {
    const google = inMemoryGoogle()
    let idIndex = 0
    const handle = createControlHandler({
      env: ENV,
      fetchImpl: google.fetchImpl,
      getAccessToken: async () => 'short-lived-token',
      now: () => FIXED_NOW,
      randomUUID: () => IDS[idIndex++],
    })
    const createdResponse = await handle(request('/v1/runs', 'POST', {
      fileName: 'genome.vcf',
      inputFormat: 'vcf',
      sizeBytes: 3,
      sha256: 'b'.repeat(64),
      genomeBuild: 'GRCh38',
    }))
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json()
    assert.equal(created.runId, IDS[0])
    assert.equal(created.status, 'awaiting_upload')
    assert.equal(created.upload.protocol, 'gcs-resumable')

    google.write(`runs/${TENANT}/${created.runId}/input/source`, 'vcf', 'text/vcf')
    const submittedResponse = await handle(request(`/v1/runs/${created.runId}/submit`, 'POST', {}))
    assert.equal(submittedResponse.status, 202)
    const submitted = await submittedResponse.json()
    assert.equal(submitted.runId, created.runId)
    assert.equal(submitted.status, 'queued')

    const readResponse = await handle(request(`/v1/runs/${created.runId}`))
    assert.equal(readResponse.status, 200)
    const read = await readResponse.json()
    assert.equal(read.runId, created.runId)
    assert.equal(read.status, 'queued')
  })

  it('does not allow another tenant to read or submit a run', async () => {
    const google = inMemoryGoogle()
    let idIndex = 0
    const handle = createControlHandler({
      env: ENV,
      fetchImpl: google.fetchImpl,
      getAccessToken: async () => 'short-lived-token',
      now: () => FIXED_NOW,
      randomUUID: () => IDS[idIndex++],
    })
    const created = await (await handle(request('/v1/runs', 'POST', {
      fileName: 'genome.vcf',
      inputFormat: 'vcf',
      sizeBytes: 3,
      sha256: 'b'.repeat(64),
      genomeBuild: 'GRCh38',
    }))).json()
    google.write(`runs/${TENANT}/${created.runId}/input/source`, 'vcf', 'text/vcf')

    const foreignRead = await handle(request(`/v1/runs/${created.runId}`, 'GET', undefined, OTHER_TENANT))
    assert.equal(foreignRead.status, 404)
    assert.deepEqual(await foreignRead.json(), {
      error: { code: 'run_not_found', message: 'The genome-analysis run was not found.' },
    })

    const foreignSubmit = await handle(request(`/v1/runs/${created.runId}/submit`, 'POST', {}, OTHER_TENANT))
    assert.equal(foreignSubmit.status, 404)
    assert.deepEqual(await foreignSubmit.json(), {
      error: { code: 'run_not_found', message: 'The genome-analysis run was not found.' },
    })
    assert.equal(
      [...google.objects.keys()].some((name) => name.startsWith(`runs/${OTHER_TENANT}/`)),
      false,
    )

    const ownerSubmit = await handle(request(`/v1/runs/${created.runId}/submit`, 'POST', {}))
    assert.equal(ownerSubmit.status, 202)
    assert.equal((await ownerSubmit.json()).status, 'queued')
  })

  it('rejects consumer genotype input before creating any run or upload session', async () => {
    const google = inMemoryGoogle()
    const handle = createControlHandler({
      env: ENV,
      fetchImpl: google.fetchImpl,
      getAccessToken: async () => 'short-lived-token',
      now: () => FIXED_NOW,
      randomUUID: () => IDS[0],
    })
    const response = await handle(request('/v1/runs', 'POST', {
      fileName: 'consumer.txt',
      inputFormat: 'consumer-genotype',
      sizeBytes: 100,
    }))
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'unsupported_input',
        message: 'Consumer genotype conversion is not enabled because build, strand and missing-site handling are not verified.',
      },
    })
    assert.equal(google.objects.size, 0)
  })

  it('rejects a VCF without an exact source digest before creating storage state', async () => {
    const google = inMemoryGoogle()
    const handle = createControlHandler({
      env: ENV,
      fetchImpl: google.fetchImpl,
      getAccessToken: async () => 'short-lived-token',
      now: () => FIXED_NOW,
      randomUUID: () => IDS[0],
    })
    const response = await handle(request('/v1/runs', 'POST', {
      fileName: 'genome.vcf',
      inputFormat: 'vcf',
      sizeBytes: 3,
      genomeBuild: 'GRCh38',
    }))
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: { code: 'invalid_request', message: 'The upload request is invalid.' },
    })
    assert.equal(google.objects.size, 0)
  })

  it('returns a completed result only when every sealed artefact matches the manifest', async () => {
    const { google, handle, runId } = await queuedRun()
    sealCompletedRun(google, runId)
    const response = await handle(request(`/v1/runs/${runId}`))
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.status, 'complete')
    assert.equal(result.manifest.coverage.CYP2C19.positionsMissing, 1)
    assert.equal(result.manifest.geneScope.unrestrictedReporterGeneCount, 4)
    assert.deepEqual(result.manifest.geneScope.retainedReporterGenes, ['CYP2B6', 'CYP2C19'])
    assert.equal(result.report.pharmcatVersion, '3.3.0')
  })

  it('returns the sealed bundle when submit is retried after fast completion', async () => {
    const { google, handle, runId } = await queuedRun()
    sealCompletedRun(google, runId)
    const response = await handle(request(`/v1/runs/${runId}/submit`, 'POST', {}))
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.status, 'complete')
    assert.equal(result.manifest.runId, runId)
    assert.equal(result.report.pharmcatVersion, '3.3.0')
  })

  it('turns a completed state into a visible failure when coverage is tampered', async () => {
    const { google, handle, runId } = await queuedRun()
    const prefix = sealCompletedRun(google, runId)
    google.write(`${prefix}/output/coverage.json`, JSON.stringify({
      schemaVersion: '1.0',
      runId,
      genes: {},
    }), 'application/json')
    const response = await handle(request(`/v1/runs/${runId}`))
    assert.equal(response.status, 502)
    const result = await response.json()
    assert.equal(result.status, 'failed')
    assert.equal(result.error.code, 'output_integrity_failed')
    assert.equal(result.report, undefined)
  })

  it('rejects a self-partitioned gene scope that omits an unrestricted Reporter gene', async () => {
    const { google, handle, runId } = await queuedRun()
    const prefix = sealCompletedRun(google, runId)
    mutateManifest(google, prefix, (manifest) => {
      manifest.geneScope.unrestrictedReporterGeneCount = 3
      manifest.geneScope.unrestrictedReporterGenes = ['CYP2B6', 'CYP2C19', 'CYP2D6']
      manifest.geneScope.withheldReporterGenes = [
        { gene: 'CYP2D6', reason: CYP2D6_WITHHELD_REASON },
      ]
    })

    const response = await handle(request(`/v1/runs/${runId}`))
    assert.equal(response.status, 502)
    const result = await response.json()
    assert.equal(result.error.code, 'output_integrity_failed')
  })

  it('rejects retained genes that differ from the sealed restricted Reporter', async () => {
    const { google, handle, runId } = await queuedRun()
    const prefix = sealCompletedRun(google, runId)
    mutateManifest(google, prefix, (manifest) => {
      manifest.geneScope.retainedReporterGenes = ['CYP2B6', 'CYP2C19', 'HLA-B']
      manifest.geneScope.withheldReporterGenes = [
        { gene: 'CYP2D6', reason: CYP2D6_WITHHELD_REASON },
      ]
    })

    const response = await handle(request(`/v1/runs/${runId}`))
    assert.equal(response.status, 502)
    const result = await response.json()
    assert.equal(result.error.code, 'output_integrity_failed')
  })

  it('rejects a CYP2D6 exclusion that disagrees with the derived withheld-gene reason', async () => {
    const { google, handle, runId } = await queuedRun()
    const prefix = sealCompletedRun(google, runId)
    mutateManifest(google, prefix, (manifest) => {
      manifest.exclusions[0].reason = 'Different reason.'
    })

    const response = await handle(request(`/v1/runs/${runId}`))
    assert.equal(response.status, 502)
    const result = await response.json()
    assert.equal(result.error.code, 'output_integrity_failed')
  })
})
