/**
 * PharmCAT adapter.
 *
 * We wrap PharmCAT, we do not fork it — its maintainers state that customisation is
 * unsupported, and the whole pitch is that the guideline facts come from the PharmGKB
 * reference implementation rather than from us.
 *
 * A browser must never infer star alleles from a few tag SNPs. This module therefore has one
 * clinical adapter: it reads a Reporter JSON produced by the official PharmCAT pipeline.
 * Raw VCF and consumer files may be inspected elsewhere, but they need the governed upstream
 * pipeline before they can produce any result.
 */

import { excludedGeneCalls } from '../../data/excluded-genes'
import { canonicalDrug, drugClassOf } from '../../data/drug-lexicon'
import type { PharmCATRunManifest } from '../../pharmcat/types'
import type { AssayType, GeneCall, PharmCATReport, PharmCATDrugRecommendation, Phenotype } from '../types'

export interface GenomeInput {
  fileName: string
  /** Reporter JSON contents. */
  contents?: string
  assayType: AssayType
  /** Set only for a restricted report hash-bound to a verified private run manifest. */
  verifiedRunManifest?: PharmCATRunManifest
}

export interface PharmCATAdapter {
  readonly name: string
  readonly provenance: PharmCATReport['provenance']
  analyze(input: GenomeInput): Promise<PharmCATReport>
}

/* ------------------------------------------------------------------ */
/* Syntax-inspection marker definitions                               */
/* ------------------------------------------------------------------ */

/**
 * Familiar PGx rsIDs used only to exercise conservative VCF/consumer-file syntax checks.
 * Presence is not interpreted as a star allele, gene call, coverage claim or PharmCAT
 * compatibility signal.
 */
export const INSPECTION_RSIDS = [
  'rs4244285',
  'rs4986893',
  'rs12248560',
  'rs3892097',
  'rs1065852',
  'rs3745274',
] as const

/* ------------------------------------------------------------------ */
/* Genotype parsing                                                    */
/* ------------------------------------------------------------------ */

export interface ParsedGenotypes {
  /** rsid -> two-letter genotype, e.g. "AG" */
  calls: Record<string, string>
  format: '23andme' | 'vcf' | 'unknown'
  totalLines: number
}

function consumerFields(line: string): string[] {
  const trimmed = line.trim()
  return (trimmed.includes(',') ? trimmed.split(',') : trimmed.split(/\s+/))
    .map((field) => field.trim())
}

export function parseGenomeFile(contents: string): ParsedGenotypes {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/)
  const wanted = new Set<string>(INSPECTION_RSIDS)
  const calls: Record<string, string> = {}
  const conflicted = new Set<string>()
  let format: ParsedGenotypes['format'] = 'unknown'

  const isVcf = lines.some((l) => l.startsWith('##fileformat=VCF'))
  const hasVcfColumnHeader = lines.some((line) => {
    if (!line.startsWith('#CHROM\t')) return false
    const fields = line.split('\t')
    return fields[8] === 'FORMAT' && fields.length >= 10
  })
  format = isVcf
    ? 'vcf'
    : lines.some((line) => /^rs\d+(?:\t|,|\s)/i.test(line.trim()))
      ? '23andme'
      : 'unknown'

  const saveCall = (id: string, genotype: string): void => {
    if (conflicted.has(id)) return
    const previous = calls[id]
    if (previous !== undefined && previous !== genotype) {
      delete calls[id]
      conflicted.add(id)
      return
    }
    calls[id] = genotype
  }

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue

    if (format === 'vcf') {
      if (!hasVcfColumnHeader) continue
      // #CHROM POS ID REF ALT QUAL FILTER INFO FORMAT SAMPLE
      const fields = line.split('\t')
      if (fields.length < 10) continue
      const [, , id, ref, alt, , , , fmt, sample] = fields
      if (!wanted.has(id)) continue
      const gtIndex = fmt.split(':').indexOf('GT')
      if (gtIndex === -1) continue
      const gt = sample.split(':')[gtIndex]
      if (!gt) continue
      const refAllele = ref.toUpperCase()
      const altAlleles = alt.split(',').map((allele) => allele.toUpperCase())
      const alleleIndexes = gt.split(/[/|]/)
      if (alleleIndexes.length !== 2 || !/^[ACGT]$/.test(refAllele)) continue

      const alleles: string[] = []
      let valid = true
      for (const value of alleleIndexes) {
        if (!/^\d+$/.test(value)) {
          valid = false
          break
        }
        const index = Number.parseInt(value, 10)
        const allele = index === 0 ? refAllele : altAlleles[index - 1]
        if (!allele || !/^[ACGT]$/.test(allele)) {
          valid = false
          break
        }
        alleles.push(allele)
      }
      if (valid) saveCall(id, alleles.join(''))
    } else {
      // rsid chromosome position genotype
      const fields = consumerFields(line)
      if (fields.length < 4) continue
      const [rawId, , , rawGenotype] = fields
      const id = rawId.toLowerCase()
      if (!wanted.has(id)) continue
      const genotype = rawGenotype.toUpperCase()
      if (genotype === '--') continue
      if (/^[ACGT]{2}$/.test(genotype)) saveCall(id, genotype)
    }
  }

  return { calls, format, totalLines: lines.length }
}

/* ------------------------------------------------------------------ */
/* Real PharmCAT reporter JSON                                        */
/* ------------------------------------------------------------------ */

interface PharmCATDiplotypeJson {
  label?: unknown
  phenotypes?: unknown
  activityScore?: unknown
}

interface PharmCATGeneJson {
  callSource?: unknown
  alleleDefinitionVersion?: unknown
  phenotypeVersion?: unknown
  sourceDiplotypes?: unknown
  recommendationDiplotypes?: unknown
  uncalledHaplotypes?: unknown
  variants?: unknown
}

interface PharmCATReporterJson {
  title?: unknown
  timestamp?: unknown
  pharmcatVersion?: unknown
  dataVersion?: unknown
  genes?: unknown
  drugs?: unknown
}

interface PharmCATAnnotationJson {
  drugRecommendation?: unknown
  classification?: unknown
  population?: unknown
  dosingInformation?: unknown
  alternateDrugAvailable?: unknown
  otherPrescribingGuidance?: unknown
  genotypes?: unknown
}

interface PharmCATGuidelineJson {
  url?: unknown
  annotations?: unknown
}

interface PharmCATDrugJson {
  name?: unknown
  urls?: unknown
  guidelines?: unknown
}

const PHENOTYPES: Phenotype[] = [
  'Ultrarapid Metabolizer',
  'Rapid Metabolizer',
  'Normal Metabolizer',
  'Likely Intermediate Metabolizer',
  'Intermediate Metabolizer',
  'Likely Poor Metabolizer',
  'Poor Metabolizer',
  'Indeterminate',
]

/**
 * Genes for which the pinned CPIC serotonin-reuptake-inhibitor guideline can produce
 * antidepressant prescribing guidance. PharmCAT may call many other pharmacogenes, but
 * they belong to other drug areas and must not be presented as antidepressant results.
 */
export const ANTIDEPRESSANT_PGX_GENES = ['CYP2C19', 'CYP2D6', 'CYP2B6'] as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Strict recognition of the current Reporter handoff.
 * This checks structure, not authenticity: an uploaded report still needs a governed run
 * manifest before its origin can be trusted.
 */
export function isRecognisablePharmCATReporter(value: unknown): value is PharmCATReporterJson {
  const report = asRecord(value)
  const genes = asRecord(report.genes)
  const hasSupportedGene = ANTIDEPRESSANT_PGX_GENES.some((gene) => {
    const record = asRecord(genes[gene])
    return (
      typeof record.callSource === 'string' &&
      Array.isArray(record.sourceDiplotypes) &&
      Array.isArray(record.recommendationDiplotypes)
    )
  })
  return (
    (report.title === null || (typeof report.title === 'string' && report.title.trim().length > 0)) &&
    typeof report.timestamp === 'string' && report.timestamp.trim().length > 0 &&
    typeof report.pharmcatVersion === 'string' && report.pharmcatVersion.trim().length > 0 &&
    typeof report.dataVersion === 'string' && report.dataVersion.trim().length > 0 &&
    Object.keys(genes).length > 0 &&
    hasSupportedGene &&
    report.drugs !== null && typeof report.drugs === 'object' && !Array.isArray(report.drugs)
  )
}

function parsePharmCATGene(
  geneName: string,
  raw: PharmCATGeneJson | undefined,
  manifest?: PharmCATRunManifest,
): GeneCall {
  const source = asArray(raw?.sourceDiplotypes) as PharmCATDiplotypeJson[]
  // recommendationDiplotypes can be a collapsed lookup representation. It must never be
  // substituted for the actual source call shown to the user.
  const candidates = source
  const selected = candidates[0]
  const phenotypeValues = asArray(selected?.phenotypes)
    .filter((value): value is string => typeof value === 'string')
  const phenotypeRaw = phenotypeValues[0]
  const label = typeof selected?.label === 'string' ? selected.label.trim() : ''
  const ambiguous = candidates.length !== 1 || phenotypeValues.length !== 1 || !label
  const phenotype = !ambiguous && PHENOTYPES.includes(phenotypeRaw as Phenotype)
    ? phenotypeRaw as Phenotype
    : 'Indeterminate'
  const activityRaw = selected?.activityScore
  const activity = typeof activityRaw === 'string' || typeof activityRaw === 'number'
    ? Number.parseFloat(String(activityRaw))
    : Number.NaN
  const uncalled = asArray(raw?.uncalledHaplotypes)
  const callSource = typeof raw?.callSource === 'string' ? raw.callSource : 'UNKNOWN'
  const coverage = geneName === 'CYP2C19' || geneName === 'CYP2B6'
    ? manifest?.coverage?.[geneName]
    : undefined
  const measured = coverage?.status === 'measured' &&
    Number.isSafeInteger(coverage.positionsCalled) && coverage.positionsCalled >= 0 &&
    Number.isSafeInteger(coverage.positionsMissing) && coverage.positionsMissing >= 0 &&
    coverage.positionsCalled + coverage.positionsMissing > 0 &&
    coverage.missingPositionLabels.length === coverage.positionsMissing
      ? coverage
      : null

  return {
    gene: geneName,
    callSource,
    alleleDefinitionVersion: typeof raw?.alleleDefinitionVersion === 'string' ? raw.alleleDefinitionVersion : null,
    phenotypeVersion: typeof raw?.phenotypeVersion === 'string' ? raw.phenotypeVersion : null,
    diplotype: !ambiguous ? label : 'ambiguous or no call',
    phenotype,
    activityScore: !ambiguous && Number.isFinite(activity) && activity >= 0 ? activity : null,
    // Reporter JSON variant rows do not prove assay coverage and can include blank/no-call
    // records. Only the separate missing-position artefact and run manifest can establish
    // called/missing counts.
    positionsCalled: measured?.positionsCalled ?? null,
    positionsMissing: measured?.positionsMissing ?? null,
    coverageScope: measured ? 'pharmcat-measured' : 'report-json-only',
    missingPositionLabels: measured ? [...measured.missingPositionLabels] : [
      'Reporter JSON was supplied without PharmCAT’s missing-position VCF, so coverage completeness is unknown.',
      ...uncalled.map((value) => typeof value === 'string' ? value : JSON.stringify(value)),
      ...(ambiguous ? ['PharmCAT did not report one unambiguous source diplotype.'] : []),
      ...(geneName === 'CYP2D6'
        ? [callSource === 'OUTSIDE'
            ? 'PharmCAT used an outside CYP2D6 call, but Reporter JSON does not identify or validate the structural-variant caller.'
            : 'No outside CYP2D6 call was supplied; structural and copy-number variation is unresolved.']
        : []),
    ],
    structuralVariationUnresolved: geneName === 'CYP2D6',
  }
}

const ALLOWED_GUIDELINE_HOSTS = new Set([
  'clinpgx.org',
  'www.clinpgx.org',
  'cpicpgx.org',
  'www.cpicpgx.org',
  'pharmgkb.org',
  'www.pharmgkb.org',
])

function safeGuidelineUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_GUIDELINE_HOSTS.has(url.hostname.toLowerCase())
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function antidepressantGuidelineCitation(drug: string): string | null {
  const drugClass = drugClassOf(drug)
  if (drugClass === 'TCA') return 'cpic-2016-tca'
  if (drugClass === 'SSRI' || drugClass === 'SNRI' || drugClass === 'serotonin modulator') {
    return 'cpic-2023-sri'
  }
  return null
}

/**
 * Convert exact PharmCAT recommendation wording into a neutral UI grouping. The original
 * text remains the clinical fact; this classification only controls where the row appears.
 */
export function recommendationActionFromText(text: string): PharmCATDrugRecommendation['action'] {
  const value = text.trim()
  if (!value || /\bno recommendation\b|\bno action recommended\b/i.test(value)) return 'no_recommendation'

  /*
   * The anchored "initiate therapy with recommended starting dose" test must run BEFORE the
   * unanchored avoid/alternative tests.
   *
   * CPIC routinely opens with that phrase and then qualifies it in a subordinate clause, e.g.
   * the real CYP2C19 rapid-metaboliser citalopram row ends "...or switching to a clinically
   * appropriate alternative antidepressant not predominantly metabolized by CYP2C19", and
   * ordinary dose guidance says "...a lower maintenance dose to avoid adverse effects".
   * Tested in the old order, both returned avoid/alternative and the row rendered under
   * "Discuss a different medicine" while the guideline it quotes says to start normally.
   */
  if (/^initiate therapy with (?:the )?recommended starting dose/i.test(value)) {
    if (/\blower maintenance dose\b/i.test(value)) return 'standard_start_reduced_maintenance'
    if (/\bhigher maintenance dose\b/i.test(value)) return 'standard_start_conditional_increase'
    if (/\bslower titration\b/i.test(value)) return 'standard_start_reduced_maintenance'
    return 'standard'
  }

  if (/\bavoid\b/i.test(value)) return 'avoid'
  if (
    /\b(?:consider|select|use)(?:\s+[a-z-]+){0,5}\s+alternative\b/i.test(value) ||
    /\bantidepressant not predominantly metabolized by\b/i.test(value)
  ) return 'alternative'
  if (/\blower starting dose\b|\breduction of (?:the )?recommended starting dose\b/i.test(value)) {
    return 'decrease_start'
  }
  if (/\breduc(?:e|ed|tion)\b.{0,80}\b(?:maintenance )?dose\b/i.test(value)) return 'decrease'
  if (/\bhigher (?:target|maintenance) dose\b|\bincrease\b.{0,80}\bdose\b/i.test(value)) return 'increase'
  return 'caution'
}

function annotationGeneResults(annotation: PharmCATAnnotationJson): PharmCATDrugRecommendation['geneResults'] {
  const byGene = new Map<string, Set<Phenotype>>()
  for (const rawGenotype of asArray(annotation.genotypes)) {
    for (const rawDiplotype of asArray(asRecord(rawGenotype).diplotypes)) {
      const diplotype = asRecord(rawDiplotype)
      const gene = typeof diplotype.gene === 'string' ? diplotype.gene : null
      const phenotypeValues = asArray(diplotype.phenotypes)
        .filter((value): value is string => typeof value === 'string')
      const phenotypeRaw = phenotypeValues[0]
      if (!gene) continue
      const phenotype = phenotypeValues.length === 1 && PHENOTYPES.includes(phenotypeRaw as Phenotype)
        ? phenotypeRaw as Phenotype
        : 'Indeterminate'
      const values = byGene.get(gene) ?? new Set<Phenotype>()
      values.add(phenotype)
      byGene.set(gene, values)
    }
  }

  return [...byGene.entries()]
    .map(([gene, values]) => ({
      gene,
      phenotype: values.size === 1 ? [...values][0] : 'Indeterminate' as Phenotype,
    }))
    .sort((a, b) => a.gene.localeCompare(b.gene))
}

export function parsePharmCATRecommendations(parsed: PharmCATReporterJson): PharmCATDrugRecommendation[] {
  const cpic = asRecord(asRecord(parsed.drugs)['CPIC Guideline Annotation'])
  const recommendations: PharmCATDrugRecommendation[] = []

  for (const [fallbackDrug, rawDrug] of Object.entries(cpic)) {
    const drugReport = asRecord(rawDrug) as PharmCATDrugJson
    const rawName = (typeof drugReport.name === 'string' ? drugReport.name : fallbackDrug).trim()
    const drug = (canonicalDrug(rawName) ?? rawName).toLowerCase()
    if (!drug) continue
    // Reporter JSON can contain CPIC annotations from every specialty. This product only
    // has source mappings and output semantics for the antidepressant SRI and TCA guidelines.
    const citationId = antidepressantGuidelineCitation(drug)
    if (!citationId) continue
    const fallbackUrl = asArray(drugReport.urls).map(safeGuidelineUrl).find(Boolean)

    for (const rawGuideline of asArray(drugReport.guidelines)) {
      const guideline = asRecord(rawGuideline) as PharmCATGuidelineJson
      const sourceUrl = safeGuidelineUrl(guideline.url) ?? fallbackUrl
      for (const rawAnnotation of asArray(guideline.annotations)) {
        const annotation = asRecord(rawAnnotation) as PharmCATAnnotationJson
        if (typeof annotation.drugRecommendation !== 'string' || !annotation.drugRecommendation.trim()) continue
        const geneResults = annotationGeneResults(annotation)
        if (!geneResults.length) continue
        const text = annotation.drugRecommendation.trim()
        const alternateDrugAvailable = typeof annotation.alternateDrugAvailable === 'boolean'
          ? annotation.alternateDrugAvailable
          : null
        recommendations.push({
          drug,
          geneResults,
          gene: geneResults.map((result) => result.gene).join(' + '),
          phenotype: geneResults[0].phenotype,
          // The boolean flag describes whether an alternative exists; it is not itself a
          // recommendation to switch. Only the recommendation text determines the grouping.
          action: recommendationActionFromText(text),
          text,
          strength: typeof annotation.classification === 'string' ? annotation.classification : undefined,
          population: typeof annotation.population === 'string' ? annotation.population : null,
          dosingInformation: typeof annotation.dosingInformation === 'boolean' ? annotation.dosingInformation : null,
          alternateDrugAvailable,
          otherPrescribingGuidance: typeof annotation.otherPrescribingGuidance === 'boolean' ? annotation.otherPrescribingGuidance : null,
          source: 'CPIC',
          citationIds: [citationId],
          ...(sourceUrl ? { sourceUrl } : {}),
        })
      }
    }
  }

  const seen = new Set<string>()
  return recommendations.filter((recommendation) => {
    const key = JSON.stringify([
      recommendation.drug,
      recommendation.geneResults,
      recommendation.population,
      recommendation.text,
      recommendation.strength,
      recommendation.dosingInformation,
      recommendation.alternateDrugAvailable,
      recommendation.otherPrescribingGuidance,
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Reads PharmCAT's machine-readable *.report.json. This does not run PharmCAT in the
 * browser; it is a static-app handoff after a governed PharmCAT service or local
 * pipeline has produced the report. Reporter JSON alone never proves CYP2D6 structural-call
 * validation or VCF coverage; those require separate run-manifest artefacts.
 */
export class PharmCATReportJsonAdapter implements PharmCATAdapter {
  readonly name = 'PharmCAT reporter JSON'
  readonly provenance = 'pharmcat-json' as const

  async analyze(input: GenomeInput): Promise<PharmCATReport> {
    let parsed: PharmCATReporterJson
    try {
      parsed = JSON.parse(input.contents ?? '') as PharmCATReporterJson
    } catch {
      throw new Error('This is not valid PharmCAT reporter JSON.')
    }

    const geneMap = asRecord(parsed.genes)
    if (!isRecognisablePharmCATReporter(parsed)) {
      throw new Error('The JSON does not match the supported PharmCAT Reporter structure. No result was created.')
    }

    const sourceGeneNames = Object.keys(geneMap).sort((a, b) => a.localeCompare(b))
    const genes = ANTIDEPRESSANT_PGX_GENES
      .filter((gene) => {
        const raw = asRecord(geneMap[gene]) as PharmCATGeneJson
        return typeof raw.callSource === 'string' && Array.isArray(raw.sourceDiplotypes)
      })
      .map((gene) => parsePharmCATGene(
        gene,
        asRecord(geneMap[gene]) as PharmCATGeneJson,
        input.verifiedRunManifest,
      ))
    const excludedObserved: Record<string, string> = {}
    for (const gene of ['SLC6A4', 'HTR2A']) {
      const raw = asRecord(geneMap[gene]) as PharmCATGeneJson
      const selected = (asArray(raw.sourceDiplotypes)[0] ?? null) as PharmCATDiplotypeJson | null
      if (selected && typeof selected.label === 'string') excludedObserved[gene] = selected.label
    }

    return {
      reportId: typeof parsed.timestamp === 'string' ? `pharmcat-${parsed.timestamp}` : `pharmcat-${input.fileName}`,
      provenance: 'pharmcat-json',
      pharmcatVersion: `${parsed.pharmcatVersion}`,
      pharmcatDataVersion: typeof parsed.dataVersion === 'string' ? parsed.dataVersion : null,
      reportTimestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
      sourceGeneNames,
      sourceGeneCount: sourceGeneNames.length,
      assayType: input.assayType,
      genes,
      excludedGenes: excludedGeneCalls(excludedObserved),
      recommendations: parsePharmCATRecommendations(parsed),
    }
  }
}
