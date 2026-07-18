import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { getVercelOidcToken } from '@vercel/oidc'
import { ExternalAccountClient, GoogleAuth } from 'google-auth-library'

const MAX_REQUEST_BYTES = 32 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 20_000
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const SESSION_COOKIE = 'pgx_session'
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const STATUSES = new Set(['awaiting_upload', 'queued', 'running', 'complete', 'failed', 'expired'])

type GatewayEnv = Record<string, string | undefined>

export interface PharmCATGatewayConfig {
  serviceUrl: string
  serviceAudience: string
  sessionSecret: string
  isVercel: boolean
  projectNumber?: string
  serviceAccountEmail?: string
  workloadAudience?: string
  oidcAudience?: string
}

export interface PharmCATGatewayDependencies {
  env?: GatewayEnv
  fetchImpl?: typeof fetch
  getIdToken?: (config: PharmCATGatewayConfig) => Promise<string>
  timeoutMs?: number
  randomSessionId?: () => string
}

export interface CompletedPharmCATRun {
  schemaVersion: '1.0'
  runId: string
  status: 'complete'
  createdAt: string
  updatedAt: string
  expiresAt: string
  input: Record<string, unknown>
  manifest: Record<string, unknown>
  report: Record<string, unknown>
}

export class PharmCATRunReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PharmCATRunReadError'
  }
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
  }
}

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

function errorResponse(error: GatewayError): Response {
  return jsonResponse(error.status, {
    error: { code: error.code, message: error.publicMessage },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

function requiredEnv(env: GatewayEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new GatewayError(503, 'pharmcat_not_configured', 'The genome-analysis service is not configured.')
  }
  return value
}

function validateServiceUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new GatewayError(503, 'pharmcat_not_configured', 'The genome-analysis service is not configured.')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname.endsWith('.run.app')
  ) {
    throw new GatewayError(503, 'pharmcat_not_configured', 'The genome-analysis service is not configured.')
  }
  return parsed.origin
}

export function readPharmCATGatewayConfig(env: GatewayEnv): PharmCATGatewayConfig {
  const serviceUrl = validateServiceUrl(requiredEnv(env, 'PHARMCAT_SERVICE_URL'))
  const serviceAudience = requiredEnv(env, 'PHARMCAT_SERVICE_AUDIENCE')
  const sessionSecret = requiredEnv(env, 'PHARMCAT_SESSION_SECRET')
  if (serviceAudience !== serviceUrl || !/^[A-Za-z0-9+/_=-]{43,256}$/.test(sessionSecret)) {
    throw new GatewayError(503, 'pharmcat_not_configured', 'The genome-analysis service is not configured.')
  }

  const isVercel = Boolean(env.VERCEL)
  if (!isVercel) return { serviceUrl, serviceAudience, sessionSecret, isVercel }

  const projectNumber = requiredEnv(env, 'GCP_PROJECT_NUMBER')
  const serviceAccountEmail = requiredEnv(env, 'GCP_SERVICE_ACCOUNT_EMAIL')
  const poolId = requiredEnv(env, 'GCP_WORKLOAD_IDENTITY_POOL_ID')
  const providerId = requiredEnv(env, 'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID')
  const oidcAudience = requiredEnv(env, 'GCP_AUDIENCE')
  if (
    !/^\d{6,20}$/.test(projectNumber) ||
    !/^[a-z0-9](?:[a-z0-9-]{2,28}[a-z0-9])?$/.test(poolId) ||
    !/^[a-z0-9](?:[a-z0-9-]{2,28}[a-z0-9])?$/.test(providerId) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)
  ) {
    throw new GatewayError(503, 'pharmcat_not_configured', 'The genome-analysis service is not configured.')
  }
  const providerPath =
    `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`
  if (oidcAudience !== `https://iam.googleapis.com/${providerPath}`) {
    throw new GatewayError(503, 'pharmcat_not_configured', 'The genome-analysis service is not configured.')
  }
  return {
    serviceUrl,
    serviceAudience,
    sessionSecret,
    isVercel,
    projectNumber,
    serviceAccountEmail,
    workloadAudience: `//iam.googleapis.com/${providerPath}`,
    oidcAudience,
  }
}

function signSession(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`session:${sessionId}`).digest('base64url')
}

function sessionCookieValue(sessionId: string, secret: string): string {
  return `${sessionId}.${signSession(sessionId, secret)}`
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  for (const segment of cookie.split(';')) {
    const [rawName, ...rawValue] = segment.trim().split('=')
    if (rawName === name) return rawValue.join('=') || null
  }
  return null
}

function verifySession(value: string | null, secret: string): string | null {
  if (!value) return null
  const separator = value.indexOf('.')
  if (separator === -1) return null
  const sessionId = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null
  const expected = signSession(sessionId, secret)
  const actualBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null
  return sessionId
}

function tenantId(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`tenant:${sessionId}`).digest('hex')
}

function makeSessionCookie(value: string, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new GatewayError(415, 'unsupported_media_type', 'Use application/json for this request.')
  }
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new GatewayError(400, 'invalid_request', 'The request length is invalid.')
    }
    if (length > MAX_REQUEST_BYTES) {
      throw new GatewayError(413, 'request_too_large', 'The request is too large.')
    }
  }
  if (!request.body) throw new GatewayError(400, 'invalid_json', 'The request is not valid JSON.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel()
      throw new GatewayError(413, 'request_too_large', 'The request is too large.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new GatewayError(400, 'invalid_json', 'The request is not valid JSON.')
  }
}

function validateCreateBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !exactKeys(value, ['fileName', 'inputFormat', 'sizeBytes', 'sha256', 'genomeBuild'])) {
    throw new GatewayError(400, 'invalid_request', 'The upload request is invalid.')
  }
  if (
    typeof value.fileName !== 'string' ||
    !value.fileName.trim() ||
    value.fileName.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(value.fileName) ||
    !['vcf', 'vcf-gzip', 'consumer-genotype'].includes(String(value.inputFormat)) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0 ||
    Number(value.sizeBytes) > 512 * 1024 * 1024 ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    (value.genomeBuild !== undefined && value.genomeBuild !== 'GRCh38')
  ) {
    throw new GatewayError(400, 'invalid_request', 'The upload request is invalid.')
  }
  return value
}

function validateSubmitBody(value: unknown): Record<string, never> {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new GatewayError(400, 'invalid_request', 'The submit request must be an empty JSON object.')
  }
  return {}
}

interface Route {
  operation: 'create' | 'submit' | 'read'
  upstreamPath: string
  runId?: string
}

function routeRequest(request: Request): Route {
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  if (path === '/api/pharmcat/runs' && request.method === 'POST') {
    return { operation: 'create', upstreamPath: '/v1/runs' }
  }
  const submit = path.match(/^\/api\/pharmcat\/runs\/([^/]+)\/submit$/)
  if (submit && request.method === 'POST' && RUN_ID.test(submit[1])) {
    return { operation: 'submit', upstreamPath: `/v1/runs/${submit[1]}/submit`, runId: submit[1] }
  }
  const read = path.match(/^\/api\/pharmcat\/runs\/([^/]+)$/)
  if (read && request.method === 'GET' && RUN_ID.test(read[1])) {
    return { operation: 'read', upstreamPath: `/v1/runs/${read[1]}`, runId: read[1] }
  }
  const knownPath = path === '/api/pharmcat/runs' || /^\/api\/pharmcat\/runs\/[^/]+(?:\/submit)?$/.test(path)
  if (knownPath) {
    throw new GatewayError(405, 'method_not_allowed', 'This method is not allowed for the genome-analysis route.')
  }
  throw new GatewayError(404, 'not_found', 'The genome-analysis route was not found.')
}

async function defaultIdToken(config: PharmCATGatewayConfig): Promise<string> {
  if (config.isVercel) {
    if (!config.workloadAudience || !config.oidcAudience || !config.serviceAccountEmail) {
      throw new Error('Missing workload identity configuration.')
    }
    // Obtain the federated principal token, then use its getOpenIdToken permission on the
    // dedicated service account. No persistent service-account key is stored in Vercel.
    const client = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience: config.workloadAudience,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      scopes: [CLOUD_PLATFORM_SCOPE],
      subject_token_supplier: {
        getSubjectToken: async () => getVercelOidcToken({ audience: config.oidcAudience! }),
      },
    })
    if (!client) throw new Error('Could not create the workload identity client.')
    const access = await client.getAccessToken()
    if (!access.token) throw new Error('Google Cloud returned no federated access token.')
    const response = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:generateIdToken`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ audience: config.serviceAudience, includeEmail: true }),
      },
    )
    if (!response.ok) throw new Error('Google Cloud did not issue a service ID token.')
    const value = await response.json() as { token?: unknown }
    if (typeof value.token !== 'string' || !value.token) throw new Error('Google Cloud returned no service ID token.')
    return value.token
  }

  const client = await new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] })
    .getIdTokenClient(config.serviceAudience)
  return client.idTokenProvider.fetchIdToken(config.serviceAudience)
}

async function readLimitedResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
  }
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
    }
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
  }
}

function validateUploadTarget(value: unknown): void {
  if (
    !isRecord(value) ||
    value.protocol !== 'gcs-resumable' ||
    value.method !== 'PUT' ||
    !isRecord(value.headers) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isSafeInteger(value.chunkSizeBytes) ||
    Number(value.chunkSizeBytes) < 256 * 1024 ||
    Number(value.chunkSizeBytes) % (256 * 1024) !== 0
  ) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid upload target.')
  }
  let url: URL
  try {
    url = new URL(String(value.url))
  } catch {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid upload target.')
  }
  const headerNames = Object.keys(value.headers).map((name) => name.toLowerCase()).sort()
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'storage.googleapis.com' ||
    !url.pathname.startsWith('/upload/storage/v1/b/') ||
    url.searchParams.get('uploadType') !== 'resumable' ||
    !url.searchParams.has('upload_id') ||
    headerNames.join(',') !== 'content-type'
  ) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid upload target.')
  }
}

function validateServiceResponse(value: unknown, route: Route): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
  }
  // Errors from the private control service are intentionally narrow and never include
  // internal details. They are handled separately from successful run records.
  if (isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
    if (
      !/^[a-z][a-z0-9_]{0,79}$/.test(value.error.code) ||
      !value.error.message.trim() ||
      value.error.message.length > 500
    ) {
      throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid error response.')
    }
    return { error: { code: value.error.code, message: value.error.message } }
  }
  if (
    value.schemaVersion !== '1.0' ||
    typeof value.runId !== 'string' ||
    !RUN_ID.test(value.runId) ||
    (route.runId !== undefined && route.runId !== value.runId) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !isRecord(value.input)
  ) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
  }
  if (value.status === 'awaiting_upload') {
    validateUploadTarget(value.upload)
  } else if (value.upload !== undefined) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid response.')
  }
  if (value.status === 'complete' && (!isRecord(value.manifest) || !isRecord(value.report))) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an incomplete result.')
  }
  if ((value.status === 'failed' || value.status === 'expired') && !isRecord(value.error)) {
    throw new GatewayError(502, 'invalid_service_response', 'The genome-analysis service returned an invalid terminal state.')
  }
  return value
}

async function forward(
  request: Request,
  route: Route,
  tenant: string,
  config: PharmCATGatewayConfig,
  dependencies: PharmCATGatewayDependencies,
): Promise<Response> {
  let body: string | undefined
  if (route.operation === 'create') body = JSON.stringify(validateCreateBody(await readLimitedJson(request)))
  if (route.operation === 'submit') body = JSON.stringify(validateSubmitBody(await readLimitedJson(request)))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? UPSTREAM_TIMEOUT_MS)
  const abort = () => controller.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted) controller.abort()
  try {
    let token: string
    try {
      token = await (dependencies.getIdToken ?? defaultIdToken)(config)
    } catch {
      throw new GatewayError(502, 'pharmcat_authentication_failed', 'The genome-analysis service could not authenticate.')
    }
    if (!token.trim()) {
      throw new GatewayError(502, 'pharmcat_authentication_failed', 'The genome-analysis service could not authenticate.')
    }
    let upstream: Response
    try {
      upstream = await (dependencies.fetchImpl ?? fetch)(`${config.serviceUrl}${route.upstreamPath}`, {
        method: request.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-PGX-Tenant': tenant,
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) {
        throw new GatewayError(504, 'pharmcat_timeout', 'The genome-analysis service timed out.')
      }
      throw new GatewayError(502, 'pharmcat_unavailable', 'The genome-analysis service is unavailable.')
    }
    const value = validateServiceResponse(await readLimitedResponse(upstream), route)
    return jsonResponse(upstream.status, value)
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abort)
  }
}

export async function handlePharmCATGateway(
  request: Request,
  dependencies: PharmCATGatewayDependencies = {},
): Promise<Response> {
  try {
    const route = routeRequest(request)
    const config = readPharmCATGatewayConfig(dependencies.env ?? process.env)
    let sessionId = verifySession(readCookie(request, SESSION_COOKIE), config.sessionSecret)
    let setCookie: string | null = null
    if (!sessionId) {
      if (route.operation !== 'create') {
        throw new GatewayError(404, 'run_not_found', 'The genome-analysis run was not found.')
      }
      sessionId = dependencies.randomSessionId?.() ?? randomBytes(32).toString('base64url')
      if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) {
        throw new GatewayError(500, 'session_failed', 'A private analysis session could not be created.')
      }
      setCookie = makeSessionCookie(sessionCookieValue(sessionId, config.sessionSecret), request)
    }
    const response = await forward(request, route, tenantId(sessionId, config.sessionSecret), config, dependencies)
    if (!setCookie) return response
    const headers = new Headers(response.headers)
    headers.set('Set-Cookie', setCookie)
    return new Response(response.body, { status: response.status, headers })
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error)
    return errorResponse(new GatewayError(500, 'gateway_failed', 'The genome-analysis gateway failed safely.'))
  }
}

/**
 * Server-only rehydration for downstream clinical routes. Ownership comes from the signed
 * HttpOnly browser session and the private control service, never from a tenant, manifest,
 * report or fact object supplied in the request body.
 */
export async function readCompletedPharmCATRun(
  request: Request,
  runId: string,
  dependencies: PharmCATGatewayDependencies = {},
): Promise<CompletedPharmCATRun> {
  if (!RUN_ID.test(runId)) {
    throw new PharmCATRunReadError(404, 'run_not_found', 'The genome-analysis run was not found.')
  }
  try {
    const config = readPharmCATGatewayConfig(dependencies.env ?? process.env)
    const sessionId = verifySession(readCookie(request, SESSION_COOKIE), config.sessionSecret)
    if (!sessionId) {
      throw new PharmCATRunReadError(404, 'run_not_found', 'The genome-analysis run was not found.')
    }
    const route: Route = {
      operation: 'read',
      upstreamPath: `/v1/runs/${runId}`,
      runId,
    }
    const response = await forward(
      new Request(request.url, { method: 'GET', signal: request.signal }),
      route,
      tenantId(sessionId, config.sessionSecret),
      config,
      dependencies,
    )
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const error = isRecord(value.error) ? value.error : {}
      throw new PharmCATRunReadError(
        response.status,
        typeof error.code === 'string' ? error.code : 'pharmcat_unavailable',
        typeof error.message === 'string' ? error.message : 'The genome-analysis run could not be loaded.',
      )
    }
    if (
      value.status !== 'complete' ||
      !isRecord(value.input) ||
      !isRecord(value.manifest) ||
      !isRecord(value.report)
    ) {
      throw new PharmCATRunReadError(409, 'run_not_complete', 'The genome-analysis run is not complete.')
    }
    return value as unknown as CompletedPharmCATRun
  } catch (error) {
    if (error instanceof PharmCATRunReadError) throw error
    if (error instanceof GatewayError) {
      throw new PharmCATRunReadError(error.status, error.code, error.publicMessage)
    }
    throw new PharmCATRunReadError(502, 'pharmcat_unavailable', 'The genome-analysis service is unavailable.')
  }
}

export default {
  fetch(request: Request): Promise<Response> {
    return handlePharmCATGateway(request)
  },
}
