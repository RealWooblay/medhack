/**
 * PharmCAT adapter.
 *
 * We wrap PharmCAT, we do not fork it — its maintainers state that customisation is
 * unsupported, and the whole pitch is that the guideline facts come from the PharmGKB
 * reference implementation rather than from us.
 *
 * Four implementations sit behind one interface:
 *
 *   FixtureAdapter    — known-diplotype fixtures. The demo path, so a demonstration can
 *                       never fail on live variant calling.
 *   TagSnpAdapter     — a genuinely functional but deliberately reduced caller for an
 *                       uploaded 23andMe export or VCF. It reads the handful of tag SNPs
 *                       that consumer arrays actually carry, and reports everything it
 *                       could not see. It is NOT PharmCAT and does not pretend to be; the
 *                       confidence layer marks its output down accordingly.
 *   DockerAdapter     — the real thing. Runs the pgkb/pharmcat image. Not reachable from a
 *                       browser, so it lives in scripts/run-pharmcat.sh and regenerates the
 *                       fixtures this app ships with.
 *   ReporterJsonAdapter — reads a PharmCAT Reporter JSON result, preserves ambiguity, and maps
 *                         gene calls into the app's versioned CPIC evidence table. It does not
 *                         infer VCF coverage that is absent from the report.
 *
 * The output shape mirrors PharmCAT's own reporter JSON closely enough that swapping
 * TagSnpAdapter for parsed PharmCAT output is a parsing change, not a redesign.
 */

import { lookupRecommendation, DRUG_PROFILES } from '../../data/cpic'
import { excludedGeneCalls } from '../../data/excluded-genes'
import type { AssayType, GeneCall, PharmCATReport, PharmCATDrugRecommendation, Phenotype } from '../types'

export interface GenomeInput {
  fileName: string
  /** Raw file contents. Empty for fixture runs. */
  contents?: string
  assayType: AssayType
}

export interface PharmCATAdapter {
  readonly name: string
  readonly provenance: PharmCATReport['provenance']
  analyze(input: GenomeInput): Promise<PharmCATReport>
}

/* ------------------------------------------------------------------ */
/* Variant definitions                                                 */
/* ------------------------------------------------------------------ */

/**
 * GRCh38 coordinates read from PharmCAT's shipped `pharmcat_positions.vcf`.
 *
 * Strand caveat, stated because it is a real source of silent error: CYP2D6 sits on the
 * minus strand, and consumer arrays report plus-strand alleles. `variantAlleles` below
 * lists the letters as a 23andMe-style export presents them, which is what this caller
 * consumes. A production system should resolve strand from the file header rather than
 * assuming, and PharmCAT's own preprocessor does exactly that.
 */
export interface VariantDefinition {
  rsid: string
  gene: string
  chrom: string
  position: number
  /** Alleles that indicate the non-reference star allele, as reported plus-strand. */
  variantAlleles: string[]
  starAllele: string
  label: string
}

export const VARIANTS: VariantDefinition[] = [
  { rsid: 'rs4244285', gene: 'CYP2C19', chrom: 'chr10', position: 94781859, variantAlleles: ['A'], starAllele: '*2', label: 'CYP2C19*2 (c.681G>A)' },
  { rsid: 'rs4986893', gene: 'CYP2C19', chrom: 'chr10', position: 94780653, variantAlleles: ['A'], starAllele: '*3', label: 'CYP2C19*3 (c.636G>A)' },
  { rsid: 'rs12248560', gene: 'CYP2C19', chrom: 'chr10', position: 94761900, variantAlleles: ['T'], starAllele: '*17', label: 'CYP2C19*17 (c.-806C>T)' },
  { rsid: 'rs3892097', gene: 'CYP2D6', chrom: 'chr22', position: 42128945, variantAlleles: ['A'], starAllele: '*4', label: 'CYP2D6*4 (splice defect)' },
  { rsid: 'rs1065852', gene: 'CYP2D6', chrom: 'chr22', position: 42130692, variantAlleles: ['A'], starAllele: '*10', label: 'CYP2D6*10 (c.100C>T)' },
  { rsid: 'rs3745274', gene: 'CYP2B6', chrom: 'chr19', position: 40991381, variantAlleles: ['T'], starAllele: '*6', label: 'CYP2B6*6 (c.516G>T)' },
]

/**
 * What a consumer array cannot see, by gene. Fed straight into the confidence layer.
 */
export const UNCALLABLE_BY_ARRAY: Record<string, string[]> = {
  CYP2D6: [
    'gene duplications and multiplications (xN) — ultrarapid metabolisers are missed entirely',
    'CYP2D6*5 whole-gene deletion — makes a hemizygous variant look homozygous',
    'CYP2D6-CYP2D7 hybrid alleles',
    'rs5030655 (*6) and other small indels',
  ],
  CYP2C19: [
    'the long tail of rarer no-function alleles (*4, *5, *6, *7, *8, *35)',
  ],
  CYP2B6: [
    'phase between c.516G>T and c.785A>G, which distinguishes *6 from *4/*9 combinations',
  ],
}

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
  const wanted = new Set(VARIANTS.map((v) => v.rsid))
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
/* Star allele calling                                                 */
/* ------------------------------------------------------------------ */

function countVariantAlleles(genotype: string | undefined, variantAlleles: string[]): number | null {
  if (!genotype || genotype.includes('-')) return null
  return genotype.split('').filter((a) => variantAlleles.includes(a)).length
}

function callCyp2c19(calls: Record<string, string>): { diplotype: string; phenotype: Phenotype } {
  const star2 = countVariantAlleles(calls.rs4244285, ['A']) ?? 0
  const star3 = countVariantAlleles(calls.rs4986893, ['A']) ?? 0
  const star17 = countVariantAlleles(calls.rs12248560, ['T']) ?? 0
  const noFunction = Math.min(2, star2 + star3)

  if (noFunction >= 2) return { diplotype: '*2/*2', phenotype: 'Poor Metabolizer' }
  if (noFunction === 1 && star17 >= 1) return { diplotype: '*2/*17', phenotype: 'Intermediate Metabolizer' }
  if (noFunction === 1) return { diplotype: '*1/*2', phenotype: 'Intermediate Metabolizer' }
  if (star17 >= 2) return { diplotype: '*17/*17', phenotype: 'Ultrarapid Metabolizer' }
  if (star17 === 1) return { diplotype: '*1/*17', phenotype: 'Rapid Metabolizer' }
  return { diplotype: '*1/*1', phenotype: 'Normal Metabolizer' }
}

function callCyp2d6(calls: Record<string, string>): {
  diplotype: string
  phenotype: Phenotype
  activityScore: number
} {
  const star4 = countVariantAlleles(calls.rs3892097, ['A']) ?? 0
  const star10 = countVariantAlleles(calls.rs1065852, ['A']) ?? 0

  if (star4 >= 2) return { diplotype: '*4/*4', phenotype: 'Poor Metabolizer', activityScore: 0 }
  if (star4 === 1) return { diplotype: '*1/*4', phenotype: 'Intermediate Metabolizer', activityScore: 1.0 }
  // *10 carries an activity value of 0.25 per allele.
  if (star10 >= 2) return { diplotype: '*10/*10', phenotype: 'Intermediate Metabolizer', activityScore: 0.5 }
  if (star10 === 1) return { diplotype: '*1/*10', phenotype: 'Normal Metabolizer', activityScore: 1.25 }
  return { diplotype: '*1/*1', phenotype: 'Normal Metabolizer', activityScore: 2.0 }
}

function callCyp2b6(calls: Record<string, string>): { diplotype: string; phenotype: Phenotype } {
  const star6 = countVariantAlleles(calls.rs3745274, ['T']) ?? 0
  if (star6 >= 2) return { diplotype: '*6/*6', phenotype: 'Poor Metabolizer' }
  if (star6 === 1) return { diplotype: '*1/*6', phenotype: 'Intermediate Metabolizer' }
  return { diplotype: '*1/*1', phenotype: 'Normal Metabolizer' }
}

/* ------------------------------------------------------------------ */
/* Genotype-only recommendations — what PharmCAT alone would say       */
/* ------------------------------------------------------------------ */

/**
 * Deliberately computed from the GENETIC phenotype only, with no knowledge of concurrent
 * medication. This is the baseline the UI contrasts against, and it is what a genotype-only
 * report would hand a prescriber.
 */
export function genotypeOnlyRecommendations(genes: GeneCall[]): PharmCATDrugRecommendation[] {
  const out: PharmCATDrugRecommendation[] = []
  for (const profile of DRUG_PROFILES) {
    for (const geneName of profile.primaryGenes) {
      const gene = genes.find((g) => g.gene === geneName)
      if (!gene) continue
      const rec = lookupRecommendation(geneName, gene.phenotype, profile.drug)
      if (!rec) continue
      out.push({
        drug: profile.drug,
        gene: geneName,
        phenotype: gene.phenotype,
        action: rec.action,
        text: rec.text,
        strength: rec.strength,
        source: 'CPIC',
        citationIds: rec.citationIds,
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

export class TagSnpAdapter implements PharmCATAdapter {
  readonly name = 'Reduced tag-SNP caller'
  readonly provenance = 'reduced-tagsnp' as const

  async analyze(input: GenomeInput): Promise<PharmCATReport> {
    const parsed = parseGenomeFile(input.contents ?? '')
    const genes = buildGeneCalls(parsed.calls, input.assayType)
    return {
      reportId: `tagsnp-${input.fileName}`,
      provenance: 'reduced-tagsnp',
      pharmcatVersion: 'reduced tag-SNP caller (not PharmCAT)',
      pharmcatDataVersion: null,
      reportTimestamp: null,
      assayType: input.assayType,
      genes,
      excludedGenes: excludedGeneCalls({}),
      recommendations: genotypeOnlyRecommendations(genes),
    }
  }
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parsePharmCATGene(geneName: string, raw: PharmCATGeneJson | undefined): GeneCall {
  const source = asArray(raw?.sourceDiplotypes) as PharmCATDiplotypeJson[]
  const recommendation = asArray(raw?.recommendationDiplotypes) as PharmCATDiplotypeJson[]
  const selected = recommendation[0] ?? source[0]
  const phenotypeRaw = asArray(selected?.phenotypes)[0]
  const ambiguous = recommendation.length > 1 || source.length > 1
  const phenotype = !ambiguous && typeof phenotypeRaw === 'string' && PHENOTYPES.includes(phenotypeRaw as Phenotype)
    ? phenotypeRaw as Phenotype
    : 'Indeterminate'
  const activityRaw = selected?.activityScore
  const activity = typeof activityRaw === 'string' || typeof activityRaw === 'number'
    ? Number.parseFloat(String(activityRaw))
    : Number.NaN
  const variants = asArray(raw?.variants)
  const uncalled = asArray(raw?.uncalledHaplotypes)
  const callSource = typeof raw?.callSource === 'string' ? raw.callSource : 'UNKNOWN'

  return {
    gene: geneName,
    diplotype: !ambiguous && typeof selected?.label === 'string' ? selected.label : 'ambiguous or no call',
    phenotype,
    activityScore: !ambiguous && Number.isFinite(activity) ? activity : null,
    positionsCalled: variants.length,
    positionsMissing: 0,
    coverageScope: 'report-json-only',
    missingPositionLabels: [
      'Reporter JSON was supplied without PharmCAT’s missing-position VCF, so coverage completeness is unknown.',
      ...uncalled.map((value) => typeof value === 'string' ? value : JSON.stringify(value)),
      ...(ambiguous ? ['PharmCAT reported more than one possible diplotype.'] : []),
      ...(geneName === 'CYP2D6' && callSource !== 'OUTSIDE'
        ? ['CYP2D6 did not come from an SV/CNV-aware outside call.']
        : []),
    ],
    structuralVariationUnresolved: geneName === 'CYP2D6' && callSource !== 'OUTSIDE',
  }
}

/**
 * Reads PharmCAT's machine-readable *.report.json. This does not run PharmCAT in the
 * browser; it is a static-app handoff after a governed PharmCAT service or local
 * pipeline has produced the report. CYP2D6 is trusted structurally only when PharmCAT
 * marks the call source as OUTSIDE.
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
    if (!Object.keys(geneMap).length || typeof parsed.pharmcatVersion !== 'string') {
      throw new Error('The JSON does not contain the genes and pharmcatVersion fields from a PharmCAT report.')
    }

    const genes = ['CYP2C19', 'CYP2D6', 'CYP2B6'].map((gene) =>
      parsePharmCATGene(gene, asRecord(geneMap[gene]) as PharmCATGeneJson),
    )
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
      assayType: input.assayType,
      genes,
      excludedGenes: excludedGeneCalls(excludedObserved),
      recommendations: genotypeOnlyRecommendations(genes),
    }
  }
}

export function buildGeneCalls(
  calls: Record<string, string>,
  assayType: AssayType,
  coverageScope: GeneCall['coverageScope'] = 'reduced-prototype',
): GeneCall[] {
  const genes: GeneCall[] = []

  for (const geneName of ['CYP2C19', 'CYP2D6', 'CYP2B6']) {
    const geneVariants = VARIANTS.filter((v) => v.gene === geneName)
    const found = geneVariants.filter((v) => calls[v.rsid])
    const missing = geneVariants.filter((v) => !calls[v.rsid])

    let diplotype: string
    let phenotype: Phenotype
    let activityScore: number | null = null

    if (geneName === 'CYP2C19') {
      ;({ diplotype, phenotype } = callCyp2c19(calls))
    } else if (geneName === 'CYP2D6') {
      const c = callCyp2d6(calls)
      diplotype = c.diplotype
      phenotype = c.phenotype
      activityScore = c.activityScore
    } else {
      ;({ diplotype, phenotype } = callCyp2b6(calls))
    }

    if (found.length === 0 || (coverageScope === 'reduced-prototype' && missing.length > 0)) {
      diplotype = 'unknown'
      phenotype = 'Indeterminate'
      activityScore = null
    }

    genes.push({
      gene: geneName,
      diplotype,
      phenotype,
      activityScore,
      positionsCalled: found.length,
      positionsMissing: missing.length,
      coverageScope,
      missingPositionLabels: [
        ...missing.map((v) => v.label),
        ...(assayType === 'consumer-array' ? (UNCALLABLE_BY_ARRAY[geneName] ?? []) : []),
      ],
      structuralVariationUnresolved:
        geneName === 'CYP2D6' &&
        (coverageScope === 'reduced-prototype' || assayType !== 'targeted-pgx'),
    })
  }

  return genes
}
