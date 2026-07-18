import type {
  CreatePharmCATRunRequest,
  PharmCATRunProgress,
  PharmCATRunResponse,
  RunGenomeOptions,
} from './types'

const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1_000
const MAX_UPLOAD_RETRIES = 3
const UPLOAD_RETRY_BASE_DELAY_MS = 200
const TRANSIENT_UPLOAD_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export class PharmCATServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly run?: PharmCATRunResponse,
  ) {
    super(message)
    this.name = 'PharmCATServiceError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function parseApiResponse(response: Response): Promise<PharmCATRunResponse> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new PharmCATServiceError('invalid_service_response', 'The genome service returned an invalid response.', response.status)
  }

  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : {}
    throw new PharmCATServiceError(
      typeof error.code === 'string' ? error.code : 'service_error',
      typeof error.message === 'string' ? error.message : 'The genome service could not complete the request.',
      response.status,
    )
  }
  if (
    !isRecord(body) ||
    body.schemaVersion !== '1.0' ||
    typeof body.runId !== 'string' ||
    typeof body.status !== 'string'
  ) {
    throw new PharmCATServiceError('invalid_service_response', 'The genome service returned an invalid response.', response.status)
  }
  return body as unknown as PharmCATRunResponse
}

async function apiRequest(path: string, init: RequestInit): Promise<PharmCATRunResponse> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    })
  } catch {
    throw new PharmCATServiceError('service_unreachable', 'The genome service is unavailable.', 0)
  }
  return parseApiResponse(response)
}

export async function createPharmCATRun(
  request: CreatePharmCATRunRequest,
  signal?: AbortSignal,
): Promise<PharmCATRunResponse> {
  return apiRequest('/api/pharmcat/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
}

export async function submitPharmCATRun(
  runId: string,
  signal?: AbortSignal,
): Promise<PharmCATRunResponse> {
  return apiRequest(`/api/pharmcat/runs/${encodeURIComponent(runId)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  })
}

export async function getPharmCATRun(
  runId: string,
  signal?: AbortSignal,
): Promise<PharmCATRunResponse> {
  return apiRequest(`/api/pharmcat/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    signal,
  })
}

function notify(options: RunGenomeOptions, event: PharmCATRunProgress): void {
  options.onStatus?.(event)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

async function sha256File(file: File, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal)
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new PharmCATServiceError(
      'integrity_check_unavailable',
      'This browser cannot verify the genome file before upload.',
      0,
    )
  }
  try {
    const bytes = await file.arrayBuffer()
    throwIfAborted(signal)
    const digest = await subtle.digest('SHA-256', bytes)
    throwIfAborted(signal)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof PharmCATServiceError) throw error
    throw new PharmCATServiceError(
      'integrity_check_failed',
      'The genome file could not be verified before upload.',
      0,
    )
  }
}

function uploadedOffset(range: string | null): number | null {
  if (range === null) return 0
  const match = range.match(/^bytes=0-(\d+)$/)
  if (!match) return null
  const last = Number(match[1])
  return Number.isSafeInteger(last) && last >= 0 ? last + 1 : null
}

function retryDelay(attempt: number): number {
  return UPLOAD_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1))
}

async function queryResumableOffset(
  url: string,
  totalBytes: number,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ complete: boolean; offset: number }> {
  let retries = 0
  while (true) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Range': `bytes */${totalBytes}` },
        body: new Uint8Array(),
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      retries += 1
      if (retries > MAX_UPLOAD_RETRIES) {
        throw new PharmCATServiceError('upload_failed', 'The genome upload could not be resumed.', 0)
      }
      await wait(retryDelay(retries), signal)
      continue
    }
    if (response.status === 200 || response.status === 201) {
      return { complete: true, offset: totalBytes }
    }
    if (response.status === 308) {
      const offset = uploadedOffset(response.headers.get('Range'))
      if (offset === null || offset >= totalBytes) {
        throw new PharmCATServiceError('upload_failed', 'The genome service returned an invalid upload offset.', 308)
      }
      return { complete: false, offset }
    }
    if (!TRANSIENT_UPLOAD_STATUSES.has(response.status)) {
      throw new PharmCATServiceError('upload_failed', 'The genome upload could not be resumed.', response.status)
    }
    retries += 1
    if (retries > MAX_UPLOAD_RETRIES) {
      throw new PharmCATServiceError('upload_failed', 'The genome upload could not be resumed.', response.status)
    }
    await wait(retryDelay(retries), signal)
  }
}

async function uploadResumable(
  file: File,
  target: NonNullable<PharmCATRunResponse['upload']>,
  signal?: AbortSignal,
): Promise<void> {
  if (
    target.protocol !== 'gcs-resumable' ||
    target.chunkSizeBytes < 256 * 1024 ||
    target.chunkSizeBytes % (256 * 1024) !== 0
  ) {
    throw new PharmCATServiceError('invalid_service_response', 'The genome service returned an invalid upload session.', 502)
  }

  let offset = 0
  let retries = 0
  while (offset < file.size) {
    const endExclusive = Math.min(offset + target.chunkSizeBytes, file.size)
    let response: Response
    try {
      response = await fetch(target.url, {
        method: target.method,
        headers: {
          ...target.headers,
          'Content-Range': `bytes ${offset}-${endExclusive - 1}/${file.size}`,
        },
        body: file.slice(offset, endExclusive),
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      retries += 1
      if (retries > MAX_UPLOAD_RETRIES) {
        throw new PharmCATServiceError('upload_failed', 'The genome file could not be uploaded.', 0)
      }
      await wait(retryDelay(retries), signal)
      const recovered = await queryResumableOffset(target.url, file.size, target.headers, signal)
      if (recovered.complete) {
        if (endExclusive === file.size) return
        throw new PharmCATServiceError('upload_failed', 'The genome service returned an invalid upload offset.', 200)
      }
      if (recovered.offset < offset || recovered.offset > endExclusive) {
        throw new PharmCATServiceError('upload_failed', 'The genome service returned an invalid upload offset.', 308)
      }
      if (recovered.offset > offset) retries = 0
      offset = recovered.offset
      continue
    }

    const isFinalChunk = endExclusive === file.size
    if (isFinalChunk && (response.status === 200 || response.status === 201)) return
    if (response.status === 308) {
      const confirmed = uploadedOffset(response.headers.get('Range'))
      if (confirmed === null || confirmed < offset || confirmed > endExclusive || confirmed >= file.size) {
        throw new PharmCATServiceError('upload_failed', 'The genome service returned an invalid upload offset.', response.status)
      }
      if (confirmed === offset) {
        retries += 1
        if (retries > MAX_UPLOAD_RETRIES) {
          throw new PharmCATServiceError('upload_failed', 'The genome file could not be uploaded.', response.status)
        }
        await wait(retryDelay(retries), signal)
      } else {
        retries = 0
      }
      offset = confirmed
      continue
    }
    if (TRANSIENT_UPLOAD_STATUSES.has(response.status)) {
      retries += 1
      if (retries > MAX_UPLOAD_RETRIES) {
        throw new PharmCATServiceError('upload_failed', 'The genome file could not be uploaded.', response.status)
      }
      await wait(retryDelay(retries), signal)
      const recovered = await queryResumableOffset(target.url, file.size, target.headers, signal)
      if (recovered.complete) {
        if (isFinalChunk) return
        throw new PharmCATServiceError('upload_failed', 'The genome service returned an invalid upload offset.', 200)
      }
      if (recovered.offset < offset || recovered.offset > endExclusive) {
        throw new PharmCATServiceError('upload_failed', 'The genome service returned an invalid upload offset.', 308)
      }
      if (recovered.offset > offset) retries = 0
      offset = recovered.offset
      continue
    }
    throw new PharmCATServiceError('upload_failed', 'The genome file could not be uploaded.', response.status)
  }
}

/**
 * Upload raw bytes directly to the run-scoped object URL, submit the immutable object to
 * PharmCAT, then poll until a sealed result or a visible terminal failure is returned.
 */
export async function runGenome(file: File, options: RunGenomeOptions): Promise<PharmCATRunResponse> {
  const sha256 = await sha256File(file, options.signal)
  if (options.sha256 && options.sha256.toLowerCase() !== sha256) {
    throw new PharmCATServiceError(
      'integrity_check_failed',
      'The genome file changed after it was selected.',
      0,
    )
  }
  const created = await createPharmCATRun({
    fileName: file.name,
    inputFormat: options.inputFormat,
    sizeBytes: file.size,
    sha256,
    ...(options.genomeBuild ? { genomeBuild: options.genomeBuild } : {}),
  }, options.signal)
  if (created.status !== 'awaiting_upload' || !created.upload) {
    throw new PharmCATServiceError('invalid_service_response', 'The genome service did not create an upload session.', 502, created)
  }
  notify(options, { phase: 'uploading', run: created })

  try {
    await uploadResumable(file, created.upload, options.signal)
  } catch (error) {
    if (error instanceof PharmCATServiceError) {
      throw new PharmCATServiceError(error.code, error.message, error.status, created)
    }
    throw error
  }

  let current = await submitPharmCATRun(created.runId, options.signal)
  notify(options, { phase: 'analysing', run: current })
  const startedAt = Date.now()
  const pollInterval = Math.max(500, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const maxWait = Math.max(pollInterval, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)

  while (current.status === 'queued' || current.status === 'running') {
    if (Date.now() - startedAt >= maxWait) {
      throw new PharmCATServiceError('client_wait_timeout', 'Analysis is still running. The run can be checked again later.', 408, current)
    }
    await wait(pollInterval, options.signal)
    current = await getPharmCATRun(created.runId, options.signal)
    notify(options, { phase: 'analysing', run: current })
  }

  if (current.status !== 'complete' || !current.manifest || current.report === undefined) {
    throw new PharmCATServiceError(
      current.error?.code ?? 'analysis_failed',
      current.error?.message ?? 'PharmCAT did not produce a complete result.',
      422,
      current,
    )
  }
  notify(options, { phase: 'complete', run: current })
  return current
}
