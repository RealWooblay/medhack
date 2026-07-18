import { getVercelOidcToken } from '@vercel/oidc'
import { ExternalAccountClient, GoogleAuth } from 'google-auth-library'

import { canonicalDrug } from '../src/data/drug-lexicon'
import {
  buildClinicalReviewContext,
  validateClinicalReviewOutput,
  type ClinicalReviewContext,
  type CurrentMedicationsStatus,
} from '../src/ai/clinical-review'
import {
  CLINICAL_REVIEW_SYSTEM_PROMPT,
  CLINICAL_REVIEW_TASK,
} from '../src/ai/clinical-review-prompt'
import { DEFAULT_CARE_CONTEXT } from '../src/engine/depression'
import { PharmCATReportJsonAdapter } from '../src/engine/pharmcat/adapter'
import { runAnalysis } from '../src/engine/pipeline'
import type { LifestyleContext } from '../src/engine/types'
import type { PharmCATRunManifest } from '../src/pharmcat/types'
import {
  PharmCATRunReadError,
  readCompletedPharmCATRun,
  type CompletedPharmCATRun,
} from './_lib/pharmcat-service'

const MAX_REQUEST_BYTES = 32 * 1024
const MAX_UPSTREAM_BYTES = 128 * 1024
const MAX_MODEL_CONTENT_BYTES = 64 * 1024
const UPSTREAM_TIMEOUT_MS = 45_000
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MEDGEMMA_MODEL_ID = 'google/medgemma-27b-text-it'

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

interface ParsedReviewRequest {
  runId: string
  patientContext: {
    selectedDrug: string | null
    currentMedications: string[]
    currentMedicationsStatus: CurrentMedicationsStatus
    confirmedLifestyle: Partial<LifestyleContext>
  }
}

interface GatewayDependencies {
  env?: GatewayEnv
  fetchImpl?: typeof fetch
  getAccessToken?: (config: VertexConfig) => Promise<string>
  loadCompletedRun?: (request: Request, runId: string) => Promise<CompletedPharmCATRun>
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

function parseCurrentMedications(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new GatewayError(400, 'invalid_patient_context', 'The current-medicine list is invalid.')
  }
  const medicines: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 100) {
      throw new GatewayError(400, 'invalid_patient_context', 'The current-medicine list is invalid.')
    }
    const generic = canonicalDrug(item)
    if (!generic) {
      throw new GatewayError(400, 'unknown_medicine', 'A current medicine is outside the governed medicine vocabulary.')
    }
    if (!medicines.includes(generic)) medicines.push(generic)
  }
  return medicines.sort((a, b) => a.localeCompare(b))
}

function parseCurrentMedicationsStatus(
  value: unknown,
  currentMedications: string[],
): CurrentMedicationsStatus {
  if (value !== 'provided' && value !== 'confirmed_none') {
    throw new GatewayError(400, 'invalid_patient_context', 'The current-medicine confirmation is invalid.')
  }
  if (
    (value === 'provided' && currentMedications.length === 0) ||
    (value === 'confirmed_none' && currentMedications.length !== 0)
  ) {
    throw new GatewayError(
      400,
      'invalid_patient_context',
      'The current-medicine confirmation does not match the medicine list.',
    )
  }
  return value
}

const LIFESTYLE_VALUES: { [K in keyof LifestyleContext]: ReadonlySet<LifestyleContext[K]> } = {
  sleep: new Set(['settled', 'trouble_sleeping', 'sleeping_too_much', 'variable']),
  mealRoutine: new Set(['regular', 'irregular', 'variable']),
  dailySchedule: new Set(['regular', 'shift_work', 'variable']),
  alcohol: new Set(['none', 'occasional', 'regular']),
  drivingOrMachinery: new Set([true, false]),
  missedDoses: new Set(['rarely', 'sometimes', 'often']),
  eatingDisorderHistory: new Set([true, false]),
}

function parseLifestyle(value: unknown): Partial<LifestyleContext> {
  if (!isRecord(value)) {
    throw new GatewayError(400, 'invalid_patient_context', 'The daily-routine answers are invalid.')
  }
  const parsed: Partial<LifestyleContext> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!(rawKey in LIFESTYLE_VALUES)) {
      throw new GatewayError(400, 'invalid_patient_context', 'The daily-routine answers contain an unsupported field.')
    }
    const key = rawKey as keyof LifestyleContext
    const allowed = LIFESTYLE_VALUES[key] as ReadonlySet<unknown>
    if (!allowed.has(rawValue)) {
      throw new GatewayError(400, 'invalid_patient_context', 'A daily-routine answer is invalid.')
    }
    ;(parsed as Record<string, unknown>)[key] = rawValue
  }
  return parsed
}

function parseReviewPayload(value: unknown): ParsedReviewRequest {
  if (!isRecord(value)) {
    throw new GatewayError(400, 'invalid_request', 'The request body is invalid.')
  }
  requireExactKeys(value, ['schemaVersion', 'runId', 'patientContext'], 'The request body')
  if (value.schemaVersion !== '1.0' || typeof value.runId !== 'string' || !RUN_ID.test(value.runId)) {
    throw new GatewayError(400, 'invalid_request', 'The private run identity is invalid.')
  }
  if (!isRecord(value.patientContext)) {
    throw new GatewayError(400, 'invalid_patient_context', 'The patient context is invalid.')
  }
  requireExactKeys(
    value.patientContext,
    ['selectedDrug', 'currentMedications', 'currentMedicationsStatus', 'confirmedLifestyle'],
    'The patient context',
  )

  let selectedDrug: string | null = null
  if (value.patientContext.selectedDrug !== null) {
    if (
      typeof value.patientContext.selectedDrug !== 'string' ||
      !value.patientContext.selectedDrug.trim() ||
      value.patientContext.selectedDrug.length > 100
    ) {
      throw new GatewayError(400, 'invalid_patient_context', 'The selected medicine is invalid.')
    }
    selectedDrug = canonicalDrug(value.patientContext.selectedDrug)
    if (!selectedDrug) {
      throw new GatewayError(400, 'unknown_medicine', 'The selected medicine is outside the governed medicine vocabulary.')
    }
  }

  const currentMedications = parseCurrentMedications(value.patientContext.currentMedications)
  const currentMedicationsStatus = parseCurrentMedicationsStatus(
    value.patientContext.currentMedicationsStatus,
    currentMedications,
  )

  return {
    runId: value.runId.toLowerCase(),
    patientContext: {
      selectedDrug,
      currentMedications,
      currentMedicationsStatus,
      confirmedLifestyle: parseLifestyle(value.patientContext.confirmedLifestyle),
    },
  }
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
    modelIdentity !== MEDGEMMA_MODEL_ID
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
    const stop = () => signal.removeEventListener('abort', onAbort)
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
  context: ClinicalReviewContext,
  config: VertexConfig,
  dependencies: GatewayDependencies,
): Promise<string> {
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
          model: config.modelIdentity,
          messages: [
            { role: 'system', content: CLINICAL_REVIEW_SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({ task: CLINICAL_REVIEW_TASK, context }),
            },
          ],
          response_format: { type: 'json_object' },
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
    return parseVertexResponse(payload)
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

async function deriveReviewContext(
  request: Request,
  parsed: ParsedReviewRequest,
  dependencies: GatewayDependencies,
): Promise<ClinicalReviewContext> {
  let completed: CompletedPharmCATRun
  try {
    completed = dependencies.loadCompletedRun
      ? await dependencies.loadCompletedRun(request, parsed.runId)
      : await readCompletedPharmCATRun(request, parsed.runId, {
          env: dependencies.env ?? process.env,
        })
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (error instanceof PharmCATRunReadError) {
      throw new GatewayError(error.status, error.code, error.message)
    }
    throw new GatewayError(404, 'run_not_found', 'The completed private genome run was not found.')
  }
  if (
    completed.status !== 'complete' ||
    completed.runId.toLowerCase() !== parsed.runId ||
    completed.manifest.runId !== parsed.runId ||
    completed.manifest.status !== 'complete' ||
    !isRecord(completed.report)
  ) {
    throw new GatewayError(409, 'run_not_complete', 'The private genome run is not complete and verified.')
  }

  const adapter = new PharmCATReportJsonAdapter()
  let analysis
  try {
    analysis = await runAnalysis({
      adapter,
      genome: {
        fileName: 'private-pharmcat-run.report.json',
        contents: JSON.stringify(completed.report),
        assayType: 'unknown',
        verifiedRunManifest: completed.manifest as unknown as PharmCATRunManifest,
      },
      input: {
        genomeFileName: 'private-pharmcat-run.report.json',
        assayType: 'unknown',
        currentMedications: parsed.patientContext.currentMedications,
        pastTrials: [],
        careContext: {
          ...DEFAULT_CARE_CONTEXT,
          lifestyle: { ...parsed.patientContext.confirmedLifestyle },
        },
        confirmedLifestyle: parsed.patientContext.confirmedLifestyle,
      },
    })
  } catch {
    throw new GatewayError(502, 'run_result_invalid', 'The verified genome result could not be converted into review facts.')
  }

  const context = buildClinicalReviewContext(analysis, {
    selectedDrug: parsed.patientContext.selectedDrug,
    confirmedLifestyle: parsed.patientContext.confirmedLifestyle,
    includeSymptomContext: false,
  })
  if (parsed.patientContext.selectedDrug && context.selectedDrug !== parsed.patientContext.selectedDrug) {
    throw new GatewayError(422, 'selected_medicine_unavailable', 'The selected medicine is not available in this run.')
  }
  return context
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
    const context = await deriveReviewContext(request, parsed, dependencies)
    const config = readVertexConfig(dependencies.env ?? process.env)
    const modelContent = await callVertex(request, context, config, dependencies)
    let decoded: unknown = null
    try {
      // Markdown fences and prose are deliberately not repaired.
      decoded = JSON.parse(modelContent)
    } catch {
      decoded = null
    }
    const review = validateClinicalReviewOutput(
      decoded,
      context,
      `Medical-model review · ${config.modelIdentity}`,
      config.modelIdentity,
    )
    return jsonResponse(200, {
      schemaVersion: '1.0',
      runId: parsed.runId,
      model: config.modelIdentity,
      context,
      review: {
        status: review.status,
        items: review.items,
        rejections: review.rejections,
      },
    })
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
