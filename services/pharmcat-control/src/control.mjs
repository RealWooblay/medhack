import { createHash, randomUUID } from 'node:crypto'

const MAX_CONTROL_BODY_BYTES = 32 * 1024
const MAX_REPORT_BYTES = 4 * 1024 * 1024
const MAX_ARTEFACT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60
const DEFAULT_RUN_TTL_SECONDS = 20 * 60
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const TOKEN_EARLY_REFRESH_MS = 60_000
const TENANT_ID = /^[0-9a-f]{64}$/
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/
const JOB_NAME = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z]+-[a-z0-9]+[0-9]\/jobs\/[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const OFFICIAL_IMAGE = /^pgkb\/pharmcat:([0-9]+\.[0-9]+\.[0-9]+)@sha256:([0-9a-f]{64})$/

class ControlError extends Error {
  constructor(status, code, publicMessage) {
    super(publicMessage)
    this.status = status
    this.code = code
    this.publicMessage = publicMessage
  }
}

function json(status, body, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, allowed) {
  const names = new Set(allowed)
  return Object.keys(value).every((key) => names.has(key))
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid.`)
  }
  return parsed
}

function readConfig(env) {
  const bucket = env.PHARMCAT_RUN_BUCKET?.trim()
  const jobName = env.PHARMCAT_JOB_NAME?.trim()
  const jobContainer = env.PHARMCAT_JOB_CONTAINER?.trim()
  const image = env.PHARMCAT_IMAGE?.trim()
  const workerImageDigest = env.PHARMCAT_WORKER_IMAGE_DIGEST?.trim()
  const appOrigin = env.PGX_APP_ORIGIN?.trim()
  const imageMatch = image?.match(OFFICIAL_IMAGE)
  let origin
  try {
    origin = new URL(appOrigin)
  } catch {
    throw new Error('PGX_APP_ORIGIN is invalid.')
  }
  if (
    !bucket || !BUCKET.test(bucket) ||
    !jobName || !JOB_NAME.test(jobName) ||
    !jobContainer || !/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(jobContainer) ||
    !imageMatch ||
    !workerImageDigest || !/^sha256:[0-9a-f]{64}$/.test(workerImageDigest) ||
    origin.protocol !== 'https:' || origin.origin !== appOrigin || origin.pathname !== '/'
  ) {
    throw new Error('The PharmCAT control service configuration is invalid.')
  }
  return {
    bucket,
    jobName,
    jobContainer,
    image,
    imageDigest: `sha256:${imageMatch[2]}`,
    workerImageDigest,
    appOrigin,
    maxUploadBytes: boundedInteger(
      env.PHARMCAT_MAX_UPLOAD_BYTES,
      DEFAULT_MAX_UPLOAD_BYTES,
      1,
      DEFAULT_MAX_UPLOAD_BYTES,
      'PHARMCAT_MAX_UPLOAD_BYTES',
    ),
    uploadTtlSeconds: boundedInteger(
      env.PHARMCAT_UPLOAD_TTL_SECONDS,
      DEFAULT_UPLOAD_TTL_SECONDS,
      60,
      60 * 60,
      'PHARMCAT_UPLOAD_TTL_SECONDS',
    ),
    runTtlSeconds: boundedInteger(
      env.PHARMCAT_RUN_TTL_SECONDS,
      DEFAULT_RUN_TTL_SECONDS,
      60,
      60 * 60,
      'PHARMCAT_RUN_TTL_SECONDS',
    ),
  }
}

function objectUrl(bucket, objectName, query = {}) {
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  return url
}

function uploadUrl(bucket, objectName, generationMatch) {
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`)
  url.searchParams.set('uploadType', 'media')
  url.searchParams.set('name', objectName)
  url.searchParams.set('ifGenerationMatch', generationMatch)
  return url
}

function resumableUrl(bucket, objectName) {
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`)
  url.searchParams.set('uploadType', 'resumable')
  url.searchParams.set('name', objectName)
  url.searchParams.set('ifGenerationMatch', '0')
  return url
}

function stateObject(tenantId, runId) {
  return `runs/${tenantId}/${runId}/state.json`
}

function inputObject(tenantId, runId) {
  return `runs/${tenantId}/${runId}/input/source`
}

function eventObject(tenantId, runId, event, now, id) {
  return `runs/${tenantId}/${runId}/events/${now.toISOString()}-${event}-${id}.json`
}

function finalManifestObject(tenantId, runId) {
  return `runs/${tenantId}/${runId}/manifest.final.json`
}

function restrictedReportObject(tenantId, runId) {
  return `runs/${tenantId}/${runId}/output/reporter.restricted.json`
}

function publicRun(state, upload) {
  const value = {
    schemaVersion: '1.0',
    runId: state.runId,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    expiresAt: state.expiresAt,
    input: {
      fileName: state.input.fileName,
      format: state.input.format,
      sizeBytes: state.input.sizeBytes,
      browserSha256: state.input.browserSha256,
      genomeBuild: state.input.genomeBuild,
    },
  }
  if (upload) value.upload = upload
  if (state.error) value.error = state.error
  return value
}

function parseCreate(value, config) {
  if (!isRecord(value) || !exactKeys(value, ['fileName', 'inputFormat', 'sizeBytes', 'sha256', 'genomeBuild'])) {
    throw new ControlError(400, 'invalid_request', 'The upload request is invalid.')
  }
  if (value.inputFormat === 'consumer-genotype') {
    throw new ControlError(
      422,
      'unsupported_input',
      'Consumer genotype conversion is not enabled because build, strand and missing-site handling are not verified.',
    )
  }
  if (
    typeof value.fileName !== 'string' ||
    !value.fileName.trim() ||
    value.fileName.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(value.fileName) ||
    !['vcf', 'vcf-gzip'].includes(value.inputFormat) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > config.maxUploadBytes ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    (value.genomeBuild !== undefined && value.genomeBuild !== 'GRCh38')
  ) {
    throw new ControlError(400, 'invalid_request', 'The upload request is invalid.')
  }
  return {
    fileName: value.fileName,
    format: value.inputFormat,
    sizeBytes: value.sizeBytes,
    browserSha256: value.sha256,
    genomeBuild: value.genomeBuild ?? null,
    contentType: value.inputFormat === 'vcf-gzip' ? 'application/gzip' : 'text/vcf',
  }
}

async function readJson(request) {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new ControlError(415, 'unsupported_media_type', 'Use application/json.')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_CONTROL_BODY_BYTES) throw new ControlError(413, 'request_too_large', 'The request is too large.')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ControlError(400, 'invalid_json', 'The request is not valid JSON.')
  }
}

function requestTenant(request) {
  const tenantId = request.headers.get('x-pgx-tenant')
  if (!tenantId || !TENANT_ID.test(tenantId)) {
    // The service is private at Cloud Run IAM as well. This header binds the already-
    // authenticated gateway request to one browser session without exposing identity data.
    throw new ControlError(401, 'unauthorized', 'The genome-analysis request is not authorized.')
  }
  return tenantId
}

function route(request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  if (path === '/v1/runs' && request.method === 'POST') return { operation: 'create' }
  const submit = path.match(/^\/v1\/runs\/([^/]+)\/submit$/)
  if (submit && request.method === 'POST' && RUN_ID.test(submit[1])) return { operation: 'submit', runId: submit[1] }
  const read = path.match(/^\/v1\/runs\/([^/]+)$/)
  if (read && request.method === 'GET' && RUN_ID.test(read[1])) return { operation: 'read', runId: read[1] }
  throw new ControlError(404, 'not_found', 'The genome-analysis route was not found.')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createGoogleClient(fetchImpl, providedToken) {
  let cached = null
  async function token() {
    if (providedToken) return providedToken()
    const now = Date.now()
    if (cached && cached.expiresAt - TOKEN_EARLY_REFRESH_MS > now) return cached.value
    const response = await fetchImpl(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (!response.ok) throw new Error('Google metadata authentication failed.')
    const value = await response.json()
    if (!isRecord(value) || typeof value.access_token !== 'string' || !Number.isFinite(value.expires_in)) {
      throw new Error('Google metadata authentication failed.')
    }
    cached = { value: value.access_token, expiresAt: now + Number(value.expires_in) * 1_000 }
    return cached.value
  }

  async function googleFetch(url, init = {}) {
    return fetchImpl(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${await token()}`,
      },
    })
  }

  async function putObject(bucket, objectName, bytes, contentType, generationMatch) {
    const response = await googleFetch(uploadUrl(bucket, objectName, generationMatch), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes,
    })
    if (!response.ok) throw new Error(`Cloud Storage write failed (${response.status}).`)
    const metadata = await response.json()
    if (!isRecord(metadata) || typeof metadata.generation !== 'string') throw new Error('Cloud Storage returned invalid metadata.')
    return metadata
  }

  async function putJson(bucket, objectName, value, generationMatch = '0') {
    return putObject(bucket, objectName, JSON.stringify(value), 'application/json', generationMatch)
  }

  async function getMetadata(bucket, objectName) {
    const response = await googleFetch(objectUrl(bucket, objectName))
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Cloud Storage metadata read failed (${response.status}).`)
    const value = await response.json()
    if (!isRecord(value) || typeof value.generation !== 'string' || typeof value.size !== 'string') {
      throw new Error('Cloud Storage returned invalid metadata.')
    }
    return value
  }

  async function getBytes(bucket, objectName, generation, maxBytes) {
    const response = await googleFetch(objectUrl(bucket, objectName, { alt: 'media', ifGenerationMatch: generation }))
    if (!response.ok) throw new Error(`Cloud Storage object read failed (${response.status}).`)
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > maxBytes) throw new Error('Cloud Storage object exceeded its limit.')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error('Cloud Storage object exceeded its limit.')
    return bytes
  }

  async function getJson(bucket, objectName, maxBytes = MAX_REPORT_BYTES) {
    const metadata = await getMetadata(bucket, objectName)
    if (!metadata) return null
    const size = Number(metadata.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('Cloud Storage object exceeded its limit.')
    }
    const bytes = await getBytes(bucket, objectName, metadata.generation, maxBytes)
    let value
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Error('Cloud Storage JSON was invalid.')
    }
    return { value, metadata, bytes }
  }

  async function startResumable(bucket, objectName, input, appOrigin) {
    const response = await googleFetch(resumableUrl(bucket, objectName), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: appOrigin,
        'X-Upload-Content-Type': input.contentType,
        'X-Upload-Content-Length': String(input.sizeBytes),
      },
      body: JSON.stringify({
        contentType: input.contentType,
        metadata: { schemaVersion: '1.0' },
      }),
    })
    const location = response.headers.get('location')
    if (!response.ok || !location) throw new Error('Cloud Storage did not create an upload session.')
    const parsed = new URL(location)
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'storage.googleapis.com' ||
      !parsed.pathname.startsWith('/upload/storage/v1/b/') ||
      parsed.searchParams.get('uploadType') !== 'resumable' ||
      !parsed.searchParams.has('upload_id')
    ) throw new Error('Cloud Storage returned an invalid upload session.')
    return parsed.toString()
  }

  async function launchJob(config, tenantId, runId) {
    const jobResponse = await googleFetch(`https://run.googleapis.com/v2/${config.jobName}`)
    if (!jobResponse.ok) throw new Error(`Cloud Run job read failed (${jobResponse.status}).`)
    const job = await jobResponse.json()
    const containers = isRecord(job) && isRecord(job.template) && isRecord(job.template.template)
      ? job.template.template.containers
      : null
    const deployedContainer = Array.isArray(containers)
      ? containers.find((container) => isRecord(container) && container.name === config.jobContainer)
      : null
    if (
      !isRecord(deployedContainer) ||
      typeof deployedContainer.image !== 'string' ||
      !deployedContainer.image.endsWith(`@${config.workerImageDigest}`)
    ) {
      throw new Error('The deployed PharmCAT worker image does not match its configured digest.')
    }
    const response = await googleFetch(`https://run.googleapis.com/v2/${config.jobName}:run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overrides: {
          taskCount: 1,
          timeout: `${config.runTtlSeconds}s`,
          containerOverrides: [{
            name: config.jobContainer,
            env: [
              { name: 'PGX_RUN_ID', value: runId },
              { name: 'PGX_TENANT_ID', value: tenantId },
              { name: 'PHARMCAT_RUN_BUCKET', value: config.bucket },
              { name: 'PHARMCAT_IMAGE', value: config.image },
              { name: 'PGX_WORKER_IMAGE_DIGEST', value: config.workerImageDigest },
            ],
          }],
        },
      }),
    })
    if (!response.ok) throw new Error(`Cloud Run job dispatch failed (${response.status}).`)
    const value = await response.json()
    if (!isRecord(value) || typeof value.name !== 'string') throw new Error('Cloud Run returned an invalid operation.')
    return value.name
  }

  return { putJson, getMetadata, getBytes, getJson, startResumable, launchJob }
}

async function loadState(storage, config, tenantId, runId) {
  const result = await storage.getJson(config.bucket, stateObject(tenantId, runId), MAX_CONTROL_BODY_BYTES)
  if (!result || !isRecord(result.value) || result.value.runId !== runId || result.value.tenantId !== tenantId) {
    throw new ControlError(404, 'run_not_found', 'The genome-analysis run was not found.')
  }
  return result
}

async function appendEvent(storage, config, state, event, now, id, details = {}) {
  await storage.putJson(
    config.bucket,
    eventObject(state.tenantId, state.runId, event, now, id),
    {
      schemaVersion: '1.0',
      runId: state.runId,
      event,
      at: now.toISOString(),
      ...details,
    },
  )
}

async function updateState(storage, config, current, generation, patch, now) {
  const next = { ...current, ...patch, updatedAt: now.toISOString() }
  const metadata = await storage.putJson(
    config.bucket,
    stateObject(current.tenantId, current.runId),
    next,
    generation,
  )
  return { value: next, metadata }
}

async function markFailed(storage, config, loaded, code, message, now, id, allowComplete = false) {
  if (['failed', 'expired'].includes(loaded.value.status) || (loaded.value.status === 'complete' && !allowComplete)) return loaded.value
  const updated = await updateState(storage, config, loaded.value, loaded.metadata.generation, {
    status: 'failed',
    error: { code, message },
  }, now)
  await appendEvent(storage, config, updated.value, 'failed', now, id, { code })
  return updated.value
}

function validCoverageGenes(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'CYP2B6,CYP2C19') return false
  for (const gene of ['CYP2C19', 'CYP2B6']) {
    const coverage = value[gene]
    if (
      !isRecord(coverage) ||
      coverage.status !== 'measured' ||
      !Number.isSafeInteger(coverage.positionsCalled) || Number(coverage.positionsCalled) < 0 ||
      !Number.isSafeInteger(coverage.positionsMissing) || Number(coverage.positionsMissing) < 0 ||
      Number(coverage.positionsCalled) + Number(coverage.positionsMissing) <= 0 ||
      !Array.isArray(coverage.missingPositionLabels) ||
      coverage.missingPositionLabels.length !== coverage.positionsMissing ||
      coverage.missingPositionLabels.some((label) => typeof label !== 'string' || !label || label.length > 200) ||
      new Set(coverage.missingPositionLabels).size !== coverage.missingPositionLabels.length
    ) return false
  }
  return true
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function createRun(request, tenantId, config, storage, now, id) {
  const input = parseCreate(await readJson(request), config)
  const runId = id()
  if (!RUN_ID.test(runId)) throw new Error('The UUID source returned an invalid identifier.')
  const expiresAt = new Date(now.getTime() + config.uploadTtlSeconds * 1_000)
  const state = {
    schemaVersion: '1.0',
    runId,
    tenantId,
    status: 'awaiting_upload',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    input,
  }
  await storage.putJson(config.bucket, stateObject(tenantId, runId), state)
  await appendEvent(storage, config, state, 'created', now, id)
  const sessionUrl = await storage.startResumable(config.bucket, inputObject(tenantId, runId), input, config.appOrigin)
  return json(201, publicRun(state, {
    protocol: 'gcs-resumable',
    url: sessionUrl,
    method: 'PUT',
    headers: { 'Content-Type': input.contentType },
    chunkSizeBytes: UPLOAD_CHUNK_BYTES,
    expiresAt: expiresAt.toISOString(),
  }))
}

async function submitRun(request, tenantId, runId, config, storage, now, id) {
  const body = await readJson(request)
  if (!isRecord(body) || Object.keys(body).length !== 0) {
    throw new ControlError(400, 'invalid_request', 'The submit request must be an empty JSON object.')
  }
  let loaded = await loadState(storage, config, tenantId, runId)
  const state = loaded.value
  if (state.status === 'complete') {
    return completeResponse(storage, config, loaded, now, id)
  }
  if (['queued', 'running', 'failed', 'expired'].includes(state.status)) {
    return json(200, publicRun(state))
  }
  if (state.status !== 'awaiting_upload') throw new Error('The run state is invalid.')
  if (now >= new Date(state.expiresAt)) {
    loaded = await updateState(storage, config, state, loaded.metadata.generation, {
      status: 'expired',
      error: { code: 'upload_expired', message: 'The private upload session expired before submission.' },
    }, now)
    await appendEvent(storage, config, loaded.value, 'expired', now, id)
    return json(410, publicRun(loaded.value))
  }

  const object = await storage.getMetadata(config.bucket, inputObject(tenantId, runId))
  if (!object) throw new ControlError(409, 'upload_incomplete', 'The genome upload is not complete.')
  if (
    Number(object.size) !== state.input.sizeBytes ||
    object.contentType !== state.input.contentType ||
    typeof object.generation !== 'string' ||
    !object.crc32c
  ) {
    const failed = await markFailed(
      storage,
      config,
      loaded,
      'input_integrity_failed',
      'The uploaded genome object did not match the sealed upload request.',
      now,
      id,
    )
    return json(422, publicRun(failed))
  }
  const runExpiresAt = new Date(now.getTime() + config.runTtlSeconds * 1_000).toISOString()
  loaded = await updateState(storage, config, state, loaded.metadata.generation, {
    status: 'queued',
    expiresAt: runExpiresAt,
    input: { ...state.input, objectGeneration: object.generation },
  }, now)
  await appendEvent(storage, config, loaded.value, 'queued', now, id, { objectGeneration: object.generation })

  let operation
  try {
    operation = await storage.launchJob(config, tenantId, runId)
  } catch {
    const failed = await markFailed(
      storage,
      config,
      loaded,
      'job_start_failed',
      'The PharmCAT worker could not be started.',
      now,
      id,
    )
    return json(502, publicRun(failed))
  }
  // The worker may have moved the state to running before this best-effort operation-name
  // audit update. A precondition failure here must not overwrite the worker's newer state.
  try {
    loaded = await updateState(storage, config, loaded.value, loaded.metadata.generation, {
      dispatchOperation: operation,
    }, now)
  } catch {
    loaded = await loadState(storage, config, tenantId, runId)
  }
  if (loaded.value.status === 'complete') {
    return completeResponse(storage, config, loaded, now, id)
  }
  return json(202, publicRun(loaded.value))
}

async function completeResponse(storage, config, loaded, now, id) {
  const state = loaded.value
  const manifestResult = await storage.getJson(config.bucket, finalManifestObject(state.tenantId, state.runId), MAX_REPORT_BYTES)
  const reportResult = await storage.getJson(config.bucket, restrictedReportObject(state.tenantId, state.runId), MAX_REPORT_BYTES)
  const originalResult = await storage.getJson(
    config.bucket,
    `runs/${state.tenantId}/${state.runId}/output/reporter.original.json`,
    MAX_ARTEFACT_BYTES,
  )
  const coverageResult = await storage.getJson(
    config.bucket,
    `runs/${state.tenantId}/${state.runId}/output/coverage.json`,
    MAX_REPORT_BYTES,
  )
  const missingMetadata = await storage.getMetadata(
    config.bucket,
    `runs/${state.tenantId}/${state.runId}/output/missing_pgx_var.vcf`,
  )
  const missingBytes = missingMetadata
    && Number.isSafeInteger(Number(missingMetadata.size))
    && Number(missingMetadata.size) >= 0
    && Number(missingMetadata.size) <= MAX_ARTEFACT_BYTES
    ? await storage.getBytes(
      config.bucket,
      `runs/${state.tenantId}/${state.runId}/output/missing_pgx_var.vcf`,
      missingMetadata.generation,
      MAX_ARTEFACT_BYTES,
    )
    : null
  const manifest = manifestResult?.value
  const report = reportResult?.value
  const original = originalResult?.value
  const coverageDocument = coverageResult?.value
  const coverageGenes = isRecord(coverageDocument) ? coverageDocument.genes : null
  const manifestInput = isRecord(manifest) ? manifest.input : null
  const manifestCaller = isRecord(manifest) ? manifest.caller : null
  const manifestOutputs = isRecord(manifest) ? manifest.outputs : null
  const missingTotal = validCoverageGenes(coverageGenes)
    ? ['CYP2C19', 'CYP2B6'].reduce(
      (total, gene) => total + Number(coverageGenes[gene].positionsMissing),
      0,
    )
    : -1
  const valid =
    isRecord(manifest) &&
    manifest.schemaVersion === '1.0' &&
    manifest.runId === state.runId &&
    manifest.status === 'complete' &&
    isRecord(manifestCaller) &&
    manifestCaller.image === config.image &&
    manifestCaller.imageDigest === config.imageDigest &&
    manifestCaller.workerImageDigest === config.workerImageDigest &&
    manifestCaller.cloudRunExecution === state.workerExecution &&
    Array.isArray(manifestCaller.command) &&
    sameJson(manifestCaller.command, ['pharmcat_pipeline', 'input.vcf', '-o', 'output', '-reporterJson', '-reporterCallsOnlyTsv']) &&
    manifestCaller.cyp2d6OutsideCall === false &&
    isRecord(manifestInput) &&
    manifestInput.objectGeneration === state.input.objectGeneration &&
    manifestInput.format === state.input.format &&
    manifestInput.sizeBytes === state.input.sizeBytes &&
    manifestInput.genomeBuild === 'GRCh38' &&
    manifestInput.sampleCount === 1 &&
    Number.isSafeInteger(manifestInput.recordCount) && Number(manifestInput.recordCount) > 0 &&
    typeof manifestInput.sha256 === 'string' && SHA256.test(manifestInput.sha256) &&
    manifestInput.sha256 === state.input.browserSha256 &&
    isRecord(manifestOutputs) &&
    typeof manifestOutputs.reporterSha256 === 'string' &&
    typeof manifestOutputs.restrictedReporterSha256 === 'string' &&
    typeof manifestOutputs.missingPositionsSha256 === 'string' &&
    typeof manifestOutputs.coverageSha256 === 'string' &&
    manifestOutputs.missingPositionCount === missingTotal &&
    isRecord(original) &&
    originalResult && sha256(originalResult.bytes) === manifestOutputs.reporterSha256 &&
    reportResult &&
    sha256(reportResult.bytes) === manifestOutputs.restrictedReporterSha256 &&
    isRecord(report) &&
    report.pharmcatVersion === manifestCaller.pharmcatVersion &&
    (report.dataVersion ?? null) === (manifestCaller.pharmcatDataVersion ?? null) &&
    coverageResult && sha256(coverageResult.bytes) === manifestOutputs.coverageSha256 &&
    isRecord(coverageDocument) && coverageDocument.schemaVersion === '1.0' && coverageDocument.runId === state.runId &&
    validCoverageGenes(coverageGenes) && sameJson(manifest.coverage, coverageGenes) &&
    missingBytes && sha256(missingBytes) === manifestOutputs.missingPositionsSha256 &&
    Array.isArray(manifest.exclusions) && manifest.exclusions.some(
      (exclusion) => isRecord(exclusion) && exclusion.gene === 'CYP2D6',
    )
  if (!valid) {
    const failed = await markFailed(
      storage,
      config,
      loaded,
      'output_integrity_failed',
      'The PharmCAT output could not be verified against its run manifest.',
      now,
      id,
      true,
    )
    return json(502, publicRun(failed))
  }
  return json(200, { ...publicRun(state), manifest, report })
}

async function readRun(tenantId, runId, config, storage, now, id) {
  let loaded = await loadState(storage, config, tenantId, runId)
  if (['awaiting_upload', 'queued', 'running'].includes(loaded.value.status) && now >= new Date(loaded.value.expiresAt)) {
    const status = loaded.value.status === 'awaiting_upload' ? 'expired' : 'failed'
    loaded = await updateState(storage, config, loaded.value, loaded.metadata.generation, {
      status,
      error: status === 'expired'
        ? { code: 'upload_expired', message: 'The private upload session expired.' }
        : { code: 'run_timed_out', message: 'The PharmCAT run did not finish before its deadline.' },
    }, now)
    await appendEvent(storage, config, loaded.value, status, now, id)
  }
  if (loaded.value.status === 'complete') return completeResponse(storage, config, loaded, now, id)
  return json(200, publicRun(loaded.value))
}

export function createControlHandler(dependencies = {}) {
  const env = dependencies.env ?? process.env
  const config = readConfig(env)
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const now = dependencies.now ?? (() => new Date())
  const id = dependencies.randomUUID ?? randomUUID
  const storage = createGoogleClient(fetchImpl, dependencies.getAccessToken)

  return async function handle(request) {
    try {
      const selected = route(request)
      const tenantId = requestTenant(request)
      const timestamp = now()
      if (selected.operation === 'create') return await createRun(request, tenantId, config, storage, timestamp, id)
      if (selected.operation === 'submit') return await submitRun(request, tenantId, selected.runId, config, storage, timestamp, id)
      return await readRun(tenantId, selected.runId, config, storage, timestamp, id)
    } catch (error) {
      if (error instanceof ControlError) {
        return json(error.status, { error: { code: error.code, message: error.publicMessage } })
      }
      return json(500, { error: { code: 'control_failed', message: 'The genome-analysis service failed safely.' } })
    }
  }
}

export const internals = {
  readConfig,
  parseCreate,
  stateObject,
  inputObject,
  finalManifestObject,
  restrictedReportObject,
}
