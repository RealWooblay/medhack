export type PharmCATInputFormat = 'vcf' | 'vcf-gzip' | 'consumer-genotype'

export type PharmCATRunStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'expired'

export interface PharmCATRunError {
  code: string
  message: string
}

export interface PharmCATUploadTarget {
  protocol: 'gcs-resumable'
  url: string
  method: 'PUT'
  /** Headers fixed when the server created this object-scoped upload session. */
  headers: Record<string, string>
  /** Always a multiple of GCS's 256 KiB resumable-upload quantum. */
  chunkSizeBytes: number
  expiresAt: string
}

export interface PharmCATRunInput {
  fileName: string
  format: PharmCATInputFormat
  sizeBytes: number
  /** Browser-computed integrity value. The worker always computes its own authoritative hash. */
  browserSha256: string
  genomeBuild: 'GRCh38' | null
}

export interface PharmCATRunManifest {
  schemaVersion: '1.0'
  runId: string
  status: 'complete'
  createdAt: string
  startedAt: string
  completedAt: string
  input: {
    format: 'vcf' | 'vcf-gzip'
    sizeBytes: number
    sha256: string
    objectGeneration: string
    genomeBuild: 'GRCh38'
    sampleCount: 1
    recordCount: number
    uncompressedSizeBytes: number
  }
  caller: {
    image: string
    imageDigest: string
    workerImageDigest: string
    command: string[]
    pharmcatVersion: string
    pharmcatDataVersion: string | null
    cloudRunExecution: string
    cyp2d6OutsideCall: false
  }
  outputs: {
    reporterSha256: string
    restrictedReporterSha256: string
    missingPositionsSha256: string
    coverageSha256: string
    missingPositionCount: number
  }
  coverage: Record<'CYP2C19' | 'CYP2B6', {
    status: 'measured'
    positionsCalled: number
    positionsMissing: number
    missingPositionLabels: string[]
  }>
  exclusions: Array<{
    gene: 'CYP2D6'
    reason: string
  }>
}

export interface PharmCATRunResponse {
  schemaVersion: '1.0'
  runId: string
  status: PharmCATRunStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  input: PharmCATRunInput
  upload?: PharmCATUploadTarget
  error?: PharmCATRunError
  /** Present only after a successful, sealed run. */
  manifest?: PharmCATRunManifest
  /** Restricted Reporter JSON tied to manifest.outputs.restrictedReporterSha256. */
  report?: unknown
}

export interface CreatePharmCATRunRequest {
  fileName: string
  inputFormat: PharmCATInputFormat
  sizeBytes: number
  /** SHA-256 of the exact source bytes. The worker independently recomputes and verifies it. */
  sha256: string
  genomeBuild?: 'GRCh38'
}

export interface RunGenomeOptions {
  inputFormat: PharmCATInputFormat
  /** Required for VCF. A header/reference check must independently confirm it in the worker. */
  genomeBuild?: 'GRCh38'
  /** Optional independently computed digest. If supplied, it must match the source bytes. */
  sha256?: string
  signal?: AbortSignal
  pollIntervalMs?: number
  maxWaitMs?: number
  onStatus?: (event: PharmCATRunProgress) => void
}

export interface PharmCATRunProgress {
  phase: 'uploading' | 'analysing' | 'complete'
  run: PharmCATRunResponse
}
