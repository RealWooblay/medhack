/**
 * Browser-safe, deterministic inspection of an uploaded genome-related file.
 *
 * This module identifies syntax only. It never infers genome build, strand, phase,
 * genotype, PharmCAT compatibility, or clinical meaning. Raw VCF and consumer files never
 * produce a browser-side gene call; only an externally produced PharmCAT Reporter JSON can
 * enter the result pipeline.
 */

import { INSPECTION_RSIDS, isRecognisablePharmCATReporter, parseGenomeFile } from './adapter'

export type InputKind =
  | 'pharmcat-report-json'
  | 'vcf'
  | 'consumer-genotype'
  | 'unknown'

export type InputInspectionStatus = 'ready' | 'limited-preview' | 'blocked'

export type InputBlockingCode =
  | 'EMPTY_INPUT'
  | 'AMBIGUOUS_FORMAT'
  | 'MALFORMED_JSON'
  | 'JSON_NOT_PHARMCAT_REPORT'
  | 'VCF_MISSING_FILEFORMAT'
  | 'VCF_MISSING_COLUMN_HEADER'
  | 'VCF_MISSING_GT'
  | 'MULTIPLE_SAMPLES'
  | 'MALFORMED_VCF_ROWS'
  | 'MALFORMED_CONSUMER_ROWS'
  | 'CONFLICTING_DUPLICATE'
  | 'NO_SUPPORTED_VARIANTS'
  | 'UNRECOGNIZED_FORMAT'

export interface InputInspection {
  kind: InputKind
  formatLabel: string
  status: InputInspectionStatus
  blockingCode: InputBlockingCode | null
  /** True only when this artefact can enter the real result parser in this build. */
  canRunAnalysis: boolean
  /** Syntax-only normalization. No alleles, positions, build, or strand are inferred. */
  normalizedContents: string
  /** Supported rsIDs with a usable diploid A/C/G/T call, after conservative parsing. */
  recognizedVariantCount: number
  warnings: string[]
  transformations: string[]
  /** Populated only if a future importer can read an explicit, verified declaration. */
  genomeBuild?: string
  /** Names copied verbatim from a valid VCF #CHROM header. */
  sampleNames?: string[]
  /** SHA-256 of the raw, pre-normalization upload bytes encoded as UTF-8. */
  sha256: string
}

interface BaseNormalization {
  normalizedContents: string
  transformations: string[]
}

interface ResultBase extends BaseNormalization {
  sha256: string
}

const SUPPORTED_RSIDS = new Set<string>(INSPECTION_RSIDS)

const LABELS: Record<InputKind, string> = {
  'pharmcat-report-json': 'PharmCAT Reporter JSON',
  vcf: 'VCF genotype file',
  'consumer-genotype': 'Consumer genotype text',
  unknown: 'Unknown format',
}

function normalizeBase(contents: string): BaseNormalization {
  const transformations: string[] = []
  let normalizedContents = contents

  if (normalizedContents.startsWith('\uFEFF')) {
    normalizedContents = normalizedContents.slice(1)
    transformations.push('Removed a UTF-8 byte-order mark.')
  }

  if (/\r/.test(normalizedContents)) {
    normalizedContents = normalizedContents.replace(/\r\n?/g, '\n')
    transformations.push('Changed line endings to LF.')
  }

  return { normalizedContents, transformations }
}

async function sha256(contents: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser cannot calculate the required SHA-256 upload identifier.')
  }
  const bytes = new TextEncoder().encode(contents)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function blocked(
  base: ResultBase,
  kind: InputKind,
  blockingCode: InputBlockingCode,
  warnings: string[],
  extra: Partial<Pick<InputInspection, 'recognizedVariantCount' | 'sampleNames'>> = {},
): InputInspection {
  return {
    kind,
    formatLabel: LABELS[kind],
    status: 'blocked',
    blockingCode,
    canRunAnalysis: false,
    normalizedContents: base.normalizedContents,
    recognizedVariantCount: extra.recognizedVariantCount ?? 0,
    warnings,
    transformations: base.transformations,
    ...(extra.sampleNames ? { sampleNames: extra.sampleNames } : {}),
    sha256: base.sha256,
  }
}

function inspectReporterJson(base: ResultBase): InputInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(base.normalizedContents)
  } catch {
    return blocked(base, 'unknown', 'MALFORMED_JSON', [
      'The content begins like JSON but is not valid JSON.',
    ])
  }

  if (!isRecognisablePharmCATReporter(parsed)) {
    return blocked(base, 'unknown', 'JSON_NOT_PHARMCAT_REPORT', [
      'The JSON does not match the supported PharmCAT Reporter structure.',
    ])
  }

  return {
    kind: 'pharmcat-report-json',
    formatLabel: LABELS['pharmcat-report-json'],
    status: 'ready',
    blockingCode: null,
    canRunAnalysis: true,
    normalizedContents: base.normalizedContents,
    recognizedVariantCount: 0,
    warnings: [
      'This is a recognisable PharmCAT Reporter structure. The browser does not prove its origin or rerun PharmCAT.',
      'Coverage, genome build, and CYP2D6 structural-variant handling must come from the governed upstream run.',
    ],
    transformations: base.transformations,
    sha256: base.sha256,
  }
}

function vcfHeader(lines: string[]): { fields: string[]; index: number } | null {
  const index = lines.findIndex((line) => line.startsWith('#CHROM\t'))
  return index === -1 ? null : { fields: lines[index].split('\t'), index }
}

function inspectVcf(base: ResultBase): InputInspection {
  const lines = base.normalizedContents.split('\n')
  const hasFileformat = lines.some((line) => /^##fileformat=VCFv\d/.test(line))
  if (!hasFileformat) {
    return blocked(base, 'vcf', 'VCF_MISSING_FILEFORMAT', [
      'VCF-like content was found, but the required ##fileformat=VCF header is missing.',
    ])
  }

  const header = vcfHeader(lines)
  const expected = ['#CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO', 'FORMAT']
  if (
    !header ||
    header.fields.length < 10 ||
    expected.some((name, index) => header.fields[index] !== name)
  ) {
    return blocked(base, 'vcf', 'VCF_MISSING_COLUMN_HEADER', [
      'The VCF needs a tab-delimited #CHROM header with FORMAT and at least one sample column.',
    ])
  }

  const sampleNames = header.fields.slice(9)
  if (sampleNames.length > 1) {
    return blocked(base, 'vcf', 'MULTIPLE_SAMPLES', [
      'This VCF contains more than one sample. Choose one sample before analysis; this interface has no sample selector.',
    ], { sampleNames })
  }
  const dataRows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line !== '' && !line.startsWith('#'))

  const malformedRows = dataRows.filter(({ line }) => {
    const fields = line.split('\t')
    return (
      fields.length !== header.fields.length ||
      !/^\d+$/.test(fields[1] ?? '') ||
      !(fields[2] ?? '') ||
      !(fields[3] ?? '') ||
      !(fields[4] ?? '')
    )
  })
  if (malformedRows.length > 0) {
    const lineNumbers = malformedRows.slice(0, 3).map(({ index }) => index + 1).join(', ')
    return blocked(base, 'vcf', 'MALFORMED_VCF_ROWS', [
      `Malformed VCF data row${malformedRows.length === 1 ? '' : 's'} found at line${malformedRows.length === 1 ? '' : 's'} ${lineNumbers}.`,
    ], { sampleNames })
  }

  const hasGt = dataRows.some(({ line }) => {
    const fields = line.split('\t')
    return fields[8]?.split(':').includes('GT') === true
  })
  if (!hasGt) {
    return blocked(base, 'vcf', 'VCF_MISSING_GT', [
      'The VCF contains no data row with a GT genotype field.',
    ], { sampleNames })
  }

  const fileformatLine = lines.find((line) => /^##fileformat=VCFv\d/.test(line)) as string
  const callsById = new Map<string, string>()
  for (const { line } of dataRows) {
    const id = line.split('\t')[2]?.toLowerCase()
    if (!id || !SUPPORTED_RSIDS.has(id)) continue
    const isolated = parseGenomeFile(`${fileformatLine}\n${lines[header.index]}\n${line}\n`).calls[id]
    if (!isolated) continue
    const previous = callsById.get(id)
    if (previous !== undefined && previous !== isolated) {
      return blocked(base, 'vcf', 'CONFLICTING_DUPLICATE', [
        `The VCF contains conflicting usable calls for ${id}. The inspector will not choose between them.`,
      ], { sampleNames })
    }
    callsById.set(id, isolated)
  }

  const parsed = parseGenomeFile(base.normalizedContents)
  const recognizedVariantCount = Object.keys(parsed.calls).length
  const supportedIdsPresent = new Set(
    dataRows
      .map(({ line }) => line.split('\t')[2]?.toLowerCase())
      .filter((id): id is string => Boolean(id && SUPPORTED_RSIDS.has(id))),
  ).size
  const callWarnings = supportedIdsPresent > recognizedVariantCount
    ? ['One or more supported rsIDs had a missing, non-diploid, conflicting, or invalid allele-index genotype and were not called.']
    : []

  return {
    kind: 'vcf',
    formatLabel: LABELS.vcf,
    status: 'limited-preview',
    blockingCode: null,
    canRunAnalysis: false,
    normalizedContents: base.normalizedContents,
    recognizedVariantCount,
    warnings: [
      'This is VCF syntax only. Genome build, strand, normalization, and PharmCAT compatibility are not established.',
      'No gene result is calculated in the browser. This VCF must run through the governed official PharmCAT pipeline first.',
      ...callWarnings,
    ],
    transformations: base.transformations,
    sampleNames,
    sha256: base.sha256,
  }
}

interface ConsumerRow {
  id: string
  chromosome: string
  position: string
  genotype: string
  delimiter: 'comma' | 'tab' | 'whitespace'
}

function splitConsumerRow(line: string): { fields: string[]; delimiter: ConsumerRow['delimiter'] } {
  if (line.includes(',')) {
    return { fields: line.split(',').map((field) => field.trim()), delimiter: 'comma' }
  }
  const delimiter = line.includes('\t') ? 'tab' : 'whitespace'
  return { fields: line.trim().split(/\s+/), delimiter }
}

function isConsumerHeader(fields: string[]): boolean {
  return fields.map((field) => field.toLowerCase()).join('|') === 'rsid|chromosome|position|genotype'
}

function parseConsumerRow(line: string): ConsumerRow | null {
  const { fields, delimiter } = splitConsumerRow(line)
  if (fields.length !== 4) return null
  const [rawId, chromosome, position, rawGenotype] = fields
  if (
    !/^(?:rs|i)\d+$/i.test(rawId) ||
    !/^[A-Za-z0-9_.-]+$/.test(chromosome) ||
    !/^\d+$/.test(position) ||
    !/^(?:[ACGTDI]{1,2}|--|00)$/i.test(rawGenotype)
  ) return null

  return {
    id: rawId.toLowerCase(),
    chromosome,
    position,
    genotype: rawGenotype.toUpperCase(),
    delimiter,
  }
}

function inspectConsumer(base: ResultBase): InputInspection {
  const lines = base.normalizedContents.split('\n')
  const normalizedLines: string[] = []
  const rows: ConsumerRow[] = []
  const malformedLineNumbers: number[] = []
  let changedCommaDelimiter = false
  let changedWhitespaceDelimiter = false
  let changedRsidCase = false
  let changedGenotypeCase = false

  lines.forEach((line, index) => {
    if (line === '' || line.startsWith('#')) {
      normalizedLines.push(line)
      return
    }

    const split = splitConsumerRow(line)
    if (isConsumerHeader(split.fields)) {
      normalizedLines.push('rsid\tchromosome\tposition\tgenotype')
      changedCommaDelimiter ||= split.delimiter === 'comma'
      changedWhitespaceDelimiter ||= split.delimiter === 'whitespace'
      return
    }

    const row = parseConsumerRow(line)
    if (!row) {
      malformedLineNumbers.push(index + 1)
      normalizedLines.push(line)
      return
    }

    rows.push(row)
    normalizedLines.push([row.id, row.chromosome, row.position, row.genotype].join('\t'))
    changedCommaDelimiter ||= row.delimiter === 'comma'
    changedWhitespaceDelimiter ||= row.delimiter === 'whitespace'
    changedRsidCase ||= row.id !== split.fields[0]
    changedGenotypeCase ||= row.genotype !== split.fields[3]
  })

  if (malformedLineNumbers.length > 0) {
    return blocked(base, 'consumer-genotype', 'MALFORMED_CONSUMER_ROWS', [
      `A consumer row must contain exactly rsID, chromosome, position, and genotype. Check line${malformedLineNumbers.length === 1 ? '' : 's'} ${malformedLineNumbers.slice(0, 3).join(', ')}.`,
    ])
  }

  const transformations = [...base.transformations]
  if (changedCommaDelimiter) transformations.push('Converted comma-delimited consumer rows to tab-delimited rows.')
  if (changedWhitespaceDelimiter) transformations.push('Converted whitespace-delimited consumer rows to tab-delimited rows.')
  if (changedRsidCase) transformations.push('Normalized rsID letter case.')
  if (changedGenotypeCase) transformations.push('Uppercased genotype letters without changing their values.')
  const normalizedContents = normalizedLines.join('\n')
  const normalizedBase: ResultBase = {
    normalizedContents,
    transformations,
    sha256: base.sha256,
  }
  const callsById = new Map<string, string>()
  for (const row of rows) {
    if (!SUPPORTED_RSIDS.has(row.id) || !/^[ACGT]{2}$/.test(row.genotype)) continue
    const previous = callsById.get(row.id)
    if (previous !== undefined && previous !== row.genotype) {
      return blocked(normalizedBase, 'consumer-genotype', 'CONFLICTING_DUPLICATE', [
        `The consumer file contains conflicting usable calls for ${row.id}. The inspector will not choose between them.`,
      ])
    }
    callsById.set(row.id, row.genotype)
  }

  const parsed = parseGenomeFile(normalizedContents)
  const recognizedVariantCount = Object.keys(parsed.calls).length
  const supportedIdsPresent = new Set(rows.filter((row) => SUPPORTED_RSIDS.has(row.id)).map((row) => row.id)).size
  const callWarnings = supportedIdsPresent > recognizedVariantCount
    ? ['One or more supported rsIDs were no-calls or non-diploid calls and were not called.']
    : []
  return {
    kind: 'consumer-genotype',
    formatLabel: LABELS['consumer-genotype'],
    status: 'limited-preview',
    blockingCode: null,
    canRunAnalysis: false,
    normalizedContents,
    recognizedVariantCount,
    warnings: [
      'This is consumer genotype syntax only. Genome build, strand, and assay coverage are not established.',
      'No gene result is calculated in the browser. Consumer data needs validated build/strand conversion and the governed official PharmCAT pipeline.',
      ...callWarnings,
    ],
    transformations,
    sha256: base.sha256,
  }
}

/** Inspect content deterministically; the file name is never used to decide its format. */
export async function inspectGenomeInput(fileName: string, contents: string): Promise<InputInspection> {
  void fileName
  const normalized = normalizeBase(contents)
  const base: ResultBase = { ...normalized, sha256: await sha256(contents) }

  if (base.normalizedContents.trim() === '') {
    return blocked(base, 'unknown', 'EMPTY_INPUT', ['The uploaded file is empty.'])
  }

  const trimmed = base.normalizedContents.trimStart()
  const lines = base.normalizedContents.split('\n')
  const jsonSignal = trimmed.startsWith('{') || trimmed.startsWith('[')
  const vcfSignal = lines.some((line) => /^##fileformat=/i.test(line) || line.startsWith('#CHROM'))
  const consumerSignal = lines.some((line) => /^rs\d+\b/i.test(line.trim()))
  const signalCount = Number(jsonSignal) + Number(vcfSignal) + Number(consumerSignal)

  if (signalCount > 1) {
    return blocked(base, 'unknown', 'AMBIGUOUS_FORMAT', [
      'The file mixes signatures from more than one supported format, so it was not normalized or analysed.',
    ])
  }
  if (jsonSignal) return inspectReporterJson(base)
  if (vcfSignal) return inspectVcf(base)
  if (consumerSignal) return inspectConsumer(base)

  return blocked(base, 'unknown', 'UNRECOGNIZED_FORMAT', [
    'The content is not recognizable as PharmCAT Reporter JSON, VCF, or four-column consumer genotype text.',
  ])
}
