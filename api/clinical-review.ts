import { getVercelOidcToken } from '@vercel/oidc'
import { ExternalAccountClient, GoogleAuth } from 'google-auth-library'

import {
  CLINICAL_REVIEW_SYSTEM_PROMPT,
  CLINICAL_REVIEW_TASK,
} from '../src/ai/clinical-review-prompt'

const MAX_REQUEST_BYTES = 256 * 1024
const MAX_UPSTREAM_BYTES = 128 * 1024
const MAX_MODEL_CONTENT_BYTES = 64 * 1024
const UPSTREAM_TIMEOUT_MS = 45_000
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const FACT_DOMAINS = new Set([
  'gene_result',
  'gene_limit',
  'pgx_guidance',
  'medicine_interaction',
  'current_medication',
  'past_trial',
  'lifestyle_context',
  'lifestyle_requirement',
  'lifestyle_match',
  'evidence_limit',
  'care_goal',
  'symptom_context',
])

type GatewayEnv = Record<string, string | undefined>

interface VertexConfig {
  projectId: string
  location: string
  endpointId: string
  endpointUrl: string
  modelIdentity: string
  isVercel: boolean
  projectNumber?: string
  serviceAccountEmail?: string
  workloadAudience?: string
  oidcAudience?: string
}

interface ReviewContext {
  schemaVersion: '1.0'
  privacy: 'derived-clinical-facts-only'
  selectedDrug: string | null
  currentMedications: string[]
  allowedDrugs: string[]
  availableProtocolDrugs: string[]
  facts: Array<{
    id: string
    domain: string
    text: string
    drugNames: string[]
    sourceIds: string[]
  }>
  sources: Array<{ id: string; label: string; title: string }>
}

interface ParsedReviewRequest {
  context: ReviewContext
}

interface GatewayDependencies {
  env?: GatewayEnv
  fetchImpl?: typeof fetch
  getAccessToken?: (config: VertexConfig) => Promise<string>
  timeoutMs?: number
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

function jsonResponse(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
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

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected)
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  const missing = expected.find((key) => !(key in value))
  if (unexpected || missing) {
    throw new GatewayError(400, 'invalid_request', `${label} has an unsupported or missing field.`)
  }
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new GatewayError(400, 'invalid_request', `${label} is invalid.`)
  }
  return value
}

function requireStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new GatewayError(400, 'invalid_request', `${label} is invalid.`)
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`, maxLength))
}

function parseContext(value: unknown): ReviewContext {
  if (!isRecord(value)) {
    throw new GatewayError(400, 'invalid_request', 'The review context is invalid.')
  }
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'privacy',
      'selectedDrug',
      'currentMedications',
      'allowedDrugs',
      'availableProtocolDrugs',
      'facts',
      'sources',
    ],
    'The review context',
  )
  if (value.schemaVersion !== '1.0' || value.privacy !== 'derived-clinical-facts-only') {
    throw new GatewayError(400, 'invalid_request', 'The review context has an unsupported schema or privacy mode.')
  }

  const currentMedications = requireStringArray(value.currentMedications, 'Current medicines', 64, 100)
  const allowedDrugs = requireStringArray(value.allowedDrugs, 'Allowed medicines', 100, 100)
  const availableProtocolDrugs = requireStringArray(
    value.availableProtocolDrugs,
    'Protocol medicines',
    100,
    100,
  )
  const knownDrugs = new Set([...allowedDrugs, ...availableProtocolDrugs, ...currentMedications])
  const selectedDrug = value.selectedDrug === null
    ? null
    : requireString(value.selectedDrug, 'Selected medicine', 100)
  if (selectedDrug && !knownDrugs.has(selectedDrug)) {
    throw new GatewayError(400, 'invalid_request', 'The selected medicine is outside the approved context.')
  }

  if (!Array.isArray(value.sources) || value.sources.length > 200) {
    throw new GatewayError(400, 'invalid_request', 'The evidence-source list is invalid.')
  }
  const sources = value.sources.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new GatewayError(400, 'invalid_request', `Evidence source ${index + 1} is invalid.`)
    }
    requireExactKeys(raw, ['id', 'label', 'title'], `Evidence source ${index + 1}`)
    return {
      id: requireString(raw.id, `Evidence source ${index + 1} ID`, 160),
      label: requireString(raw.label, `Evidence source ${index + 1} label`, 300),
      title: requireString(raw.title, `Evidence source ${index + 1} title`, 600),
    }
  })
  const sourceIds = new Set(sources.map((source) => source.id))
  if (sourceIds.size !== sources.length) {
    throw new GatewayError(400, 'invalid_request', 'Evidence-source IDs must be unique.')
  }

  if (!Array.isArray(value.facts) || value.facts.length === 0 || value.facts.length > 300) {
    throw new GatewayError(400, 'invalid_request', 'The clinical-fact list is invalid.')
  }
  const facts = value.facts.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new GatewayError(400, 'invalid_request', `Clinical fact ${index + 1} is invalid.`)
    }
    requireExactKeys(raw, ['id', 'domain', 'text', 'drugNames', 'sourceIds'], `Clinical fact ${index + 1}`)
    const domain = requireString(raw.domain, `Clinical fact ${index + 1} domain`, 80)
    if (!FACT_DOMAINS.has(domain)) {
      throw new GatewayError(400, 'invalid_request', `Clinical fact ${index + 1} has an unsupported domain.`)
    }
    const drugNames = requireStringArray(raw.drugNames, `Clinical fact ${index + 1} medicines`, 64, 100)
    const factSourceIds = requireStringArray(raw.sourceIds, `Clinical fact ${index + 1} sources`, 64, 160)
    if (drugNames.some((drug) => !knownDrugs.has(drug))) {
      throw new GatewayError(400, 'invalid_request', `Clinical fact ${index + 1} names an unapproved medicine.`)
    }
    if (factSourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
      throw new GatewayError(400, 'invalid_request', `Clinical fact ${index + 1} names an unknown evidence source.`)
    }
    return {
      id: requireString(raw.id, `Clinical fact ${index + 1} ID`, 180),
      domain,
      text: requireString(raw.text, `Clinical fact ${index + 1} text`, 4_000),
      drugNames,
      sourceIds: factSourceIds,
    }
  })
  const factIds = new Set(facts.map((fact) => fact.id))
  if (factIds.size !== facts.length) {
    throw new GatewayError(400, 'invalid_request', 'Clinical-fact IDs must be unique.')
  }

  return {
    schemaVersion: '1.0',
    privacy: 'derived-clinical-facts-only',
    selectedDrug,
    currentMedications,
    allowedDrugs,
    availableProtocolDrugs,
    facts,
    sources,
  }
}

function parseReviewPayload(value: unknown): ParsedReviewRequest {
  if (!isRecord(value)) {
    throw new GatewayError(400, 'invalid_request', 'The request body is invalid.')
  }
  requireExactKeys(value, ['model', 'temperature', 'response_format', 'messages'], 'The request body')
  if (value.model !== 'server-controlled') {
    throw new GatewayError(400, 'invalid_request', 'The model identity is controlled by the server.')
  }
  if (value.temperature !== 0) {
    throw new GatewayError(400, 'invalid_request', 'Temperature must be zero for a clinical review.')
  }
  if (!isRecord(value.response_format)) {
    throw new GatewayError(400, 'invalid_request', 'The requested response format is invalid.')
  }
  requireExactKeys(value.response_format, ['type'], 'The requested response format')
  if (value.response_format.type !== 'json_object') {
    throw new GatewayError(400, 'invalid_request', 'The clinical review requires a JSON response.')
  }
  if (!Array.isArray(value.messages) || value.messages.length !== 2) {
    throw new GatewayError(400, 'invalid_request', 'The clinical review requires the fixed two-message contract.')
  }
  const [systemMessage, userMessage] = value.messages
  if (!isRecord(systemMessage) || !isRecord(userMessage)) {
    throw new GatewayError(400, 'invalid_request', 'The clinical-review messages are invalid.')
  }
  requireExactKeys(systemMessage, ['role', 'content'], 'The system message')
  requireExactKeys(userMessage, ['role', 'content'], 'The user message')
  if (
    systemMessage.role !== 'system' ||
    systemMessage.content !== CLINICAL_REVIEW_SYSTEM_PROMPT ||
    userMessage.role !== 'user' ||
    typeof userMessage.content !== 'string'
  ) {
    throw new GatewayError(400, 'invalid_request', 'The fixed clinical-review prompt was changed.')
  }

  let userPayload: unknown
  try {
    userPayload = JSON.parse(userMessage.content)
  } catch {
    throw new GatewayError(400, 'invalid_request', 'The structured clinical-review context is not valid JSON.')
  }
  if (!isRecord(userPayload)) {
    throw new GatewayError(400, 'invalid_request', 'The structured clinical-review context is invalid.')
  }
  requireExactKeys(userPayload, ['task', 'context'], 'The structured clinical-review request')
  if (userPayload.task !== CLINICAL_REVIEW_TASK) {
    throw new GatewayError(400, 'invalid_request', 'The fixed clinical-review task was changed.')
  }
  return { context: parseContext(userPayload.context) }
}

async function readRequest(request: Request): Promise<ParsedReviewRequest> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new GatewayError(415, 'unsupported_media_type', 'Use application/json for the clinical-review request.')
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new GatewayError(400, 'invalid_request', 'The request length is invalid.')
    }
    if (parsedLength > MAX_REQUEST_BYTES) {
      throw new GatewayError(413, 'request_too_large', 'The clinical-review request is too large.')
    }
  }

  const bytes = await readLimitedStream(
    request.body,
    MAX_REQUEST_BYTES,
    new GatewayError(413, 'request_too_large', 'The clinical-review request is too large.'),
  )
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new GatewayError(400, 'invalid_json', 'The clinical-review request is not valid JSON.')
  }
  return parseReviewPayload(decoded)
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeError: GatewayError,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw tooLargeError
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function requiredEnv(env: GatewayEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new GatewayError(500, 'model_not_configured', 'The medical-model service is not configured.')
  }
  return value
}

function validateDnsHostname(value: string): string {
  const hostname = value.toLowerCase()
  if (
    hostname.length > 253 ||
    !hostname.endsWith('.prediction.vertexai.goog') ||
    hostname === 'prediction.vertexai.goog' ||
    hostname.includes('://') ||
    hostname.includes('/') ||
    hostname.includes(':') ||
    hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new GatewayError(500, 'model_not_configured', 'The medical-model service is not configured.')
  }
  return hostname
}

export function readVertexConfig(env: GatewayEnv): VertexConfig {
  const projectId = requiredEnv(env, 'GCP_PROJECT_ID')
  const location = requiredEnv(env, 'MEDGEMMA_VERTEX_LOCATION')
  const endpointId = requiredEnv(env, 'MEDGEMMA_VERTEX_ENDPOINT_ID')
  const modelIdentity = requiredEnv(env, 'MEDGEMMA_MODEL_ID')
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new GatewayError(500, 'model_not_configured', 'The medical-model service is not configured.')
  }
  if (
    !/^[a-z]+-[a-z0-9]+[0-9]$/.test(location) ||
    !/^\d{4,30}$/.test(endpointId) ||
    modelIdentity.length > 200 ||
    !/^[A-Za-z0-9._/@:+-]+$/.test(modelIdentity)
  ) {
    throw new GatewayError(500, 'model_not_configured', 'The medical-model service is not configured.')
  }

  const resourceName = `projects/${projectId}/locations/${location}/endpoints/${endpointId}`
  const dedicatedDns = env.MEDGEMMA_VERTEX_DEDICATED_DNS?.trim()
  const endpointUrl = dedicatedDns
    ? `https://${validateDnsHostname(dedicatedDns)}/v1beta1/${resourceName}/chat/completions`
    : `https://${location}-aiplatform.googleapis.com/v1beta1/${resourceName}/chat/completions`
  const isVercel = Boolean(env.VERCEL)
  if (!isVercel) return { projectId, location, endpointId, endpointUrl, modelIdentity, isVercel }

  const projectNumber = requiredEnv(env, 'GCP_PROJECT_NUMBER')
  const serviceAccountEmail = requiredEnv(env, 'GCP_SERVICE_ACCOUNT_EMAIL')
  const poolId = requiredEnv(env, 'GCP_WORKLOAD_IDENTITY_POOL_ID')
  const providerId = requiredEnv(env, 'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID')
  const oidcAudience = requiredEnv(env, 'GCP_AUDIENCE')
  if (
    !/^\d{6,20}$/.test(projectNumber) ||
    !/^[a-z0-9](?:[a-z0-9-]{2,28}[a-z0-9])?$/.test(poolId) ||
    !/^[a-z0-9](?:[a-z0-9-]{2,28}[a-z0-9])?$/.test(providerId) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
      serviceAccountEmail,
    )
  ) {
    throw new GatewayError(500, 'model_not_configured', 'The medical-model service is not configured.')
  }
  const providerPath =
    `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`
  const expectedOidcAudience = `https://iam.googleapis.com/${providerPath}`
  if (oidcAudience !== expectedOidcAudience) {
    throw new GatewayError(500, 'model_not_configured', 'The medical-model service is not configured.')
  }
  return {
    projectId,
    location,
    endpointId,
    endpointUrl,
    modelIdentity,
    isVercel,
    projectNumber,
    serviceAccountEmail,
    workloadAudience: `//iam.googleapis.com/${providerPath}`,
    oidcAudience,
  }
}

async function defaultAccessToken(config: VertexConfig): Promise<string> {
  if (config.isVercel) {
    if (
      !config.projectNumber ||
      !config.serviceAccountEmail ||
      !config.workloadAudience ||
      !config.oidcAudience
    ) {
      throw new Error('Missing workload identity configuration.')
    }
    const client = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience: config.workloadAudience,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url:
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/` +
        `${config.serviceAccountEmail}:generateAccessToken`,
      scopes: [CLOUD_PLATFORM_SCOPE],
      subject_token_supplier: {
        getSubjectToken: async () => getVercelOidcToken({ audience: config.oidcAudience! }),
      },
    })
    if (!client) throw new Error('Could not create the workload identity client.')
    const accessToken = await client.getAccessToken()
    if (!accessToken.token) throw new Error('Google Cloud returned no access token.')
    return accessToken.token
  }

  const auth = new GoogleAuth({
    projectId: config.projectId,
    scopes: [CLOUD_PLATFORM_SCOPE],
  })
  const client = await auth.getClient()
  const accessToken = await client.getAccessToken()
  if (!accessToken.token) throw new Error('Google Cloud returned no access token.')
  return accessToken.token
}

function parseVertexResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw new GatewayError(502, 'model_invalid_response', 'The medical model returned an invalid response.')
  }
  const message = value.choices[0].message
  if (!isRecord(message) || typeof message.content !== 'string' || !message.content.trim()) {
    throw new GatewayError(502, 'model_invalid_response', 'The medical model returned an invalid response.')
  }
  if (new TextEncoder().encode(message.content).byteLength > MAX_MODEL_CONTENT_BYTES) {
    throw new GatewayError(502, 'model_invalid_response', 'The medical model returned an invalid response.')
  }
  return message.content
}

function settleBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('The operation was aborted.'))
  }

  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      stop()
      reject(signal.reason ?? new Error('The operation was aborted.'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        stop()
        resolve(value)
      },
      (error: unknown) => {
        stop()
        reject(error)
      },
    )
  })
}

async function callVertex(
  request: Request,
  parsed: ParsedReviewRequest,
  config: VertexConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? UPSTREAM_TIMEOUT_MS)
  const abortUpstream = () => controller.abort()
  request.signal.addEventListener('abort', abortUpstream, { once: true })
  if (request.signal.aborted) controller.abort()
  try {
    let accessToken: string
    try {
      accessToken = await settleBeforeAbort(
        Promise.resolve().then(() => (dependencies.getAccessToken ?? defaultAccessToken)(config)),
        controller.signal,
      )
    } catch {
      if (controller.signal.aborted) {
        throw new GatewayError(504, 'model_timeout', 'The medical-model review timed out.')
      }
      throw new GatewayError(502, 'model_authentication_failed', 'The medical-model service could not authenticate.')
    }
    if (!accessToken.trim()) {
      throw new GatewayError(502, 'model_authentication_failed', 'The medical-model service could not authenticate.')
    }

    const upstream = await settleBeforeAbort(
      (dependencies.fetchImpl ?? fetch)(config.endpointUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Model Garden endpoints are bound to one deployed model. Google's
          // OpenAI-compatible example sends an empty model value.
          model: '',
          messages: [
            { role: 'system', content: CLINICAL_REVIEW_SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({ task: CLINICAL_REVIEW_TASK, context: parsed.context }),
            },
          ],
          max_tokens: 1_200,
          temperature: 0,
          stream: false,
        }),
        signal: controller.signal,
      }),
      controller.signal,
    )
    if (!upstream.ok) {
      throw new GatewayError(502, 'model_unavailable', 'The medical-model service is unavailable.')
    }
    const declaredLengthHeader = upstream.headers.get('content-length')
    const declaredLength = declaredLengthHeader === null ? 0 : Number(declaredLengthHeader)
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_UPSTREAM_BYTES) {
      throw new GatewayError(502, 'model_invalid_response', 'The medical model returned an invalid response.')
    }
    const bytes = await settleBeforeAbort(
      readLimitedStream(
        upstream.body,
        MAX_UPSTREAM_BYTES,
        new GatewayError(502, 'model_invalid_response', 'The medical model returned an invalid response.'),
      ),
      controller.signal,
    )
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new GatewayError(502, 'model_invalid_response', 'The medical model returned an invalid response.')
    }
    const content = parseVertexResponse(payload)
    return jsonResponse(200, {
      model: config.modelIdentity,
      choices: [{ message: { role: 'assistant', content } }],
    })
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (controller.signal.aborted) {
      throw new GatewayError(504, 'model_timeout', 'The medical-model review timed out.')
    }
    throw new GatewayError(502, 'model_unavailable', 'The medical-model service is unavailable.')
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abortUpstream)
  }
}

export async function handleClinicalReview(
  request: Request,
  dependencies: GatewayDependencies = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(
      405,
      { error: { code: 'method_not_allowed', message: 'Use POST for the clinical review.' } },
      { Allow: 'POST' },
    )
  }
  try {
    const parsed = await readRequest(request)
    const config = readVertexConfig(dependencies.env ?? process.env)
    return await callVertex(request, parsed, config, dependencies)
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error)
    return errorResponse(
      new GatewayError(500, 'model_gateway_failed', 'The medical-model gateway stopped safely.'),
    )
  }
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleClinicalReview(request)
  },
}
