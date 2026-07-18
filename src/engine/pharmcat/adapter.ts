/**
 * PharmCAT adapter.
 *
 * We wrap PharmCAT, we do not fork it — its maintainers state that customisation is
 * unsupported, and the whole pitch is that the guideline facts come from the PharmGKB
 * reference implementation rather than from us.
 *
 * Three implementations sit behind one interface:
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

export function parseGenomeFile(contents: string): ParsedGenotypes {
  const lines = contents.split(/\r?\n/)
  const wanted = new Set(VARIANTS.map((v) => v.rsid))
  const calls: Record<string, string> = {}
  let format: ParsedGenotypes['format'] = 'unknown'

  const isVcf = lines.some((l) => l.startsWith('##fileformat=VCF'))
  format = isVcf ? 'vcf' : lines.some((l) => /^rs\d+\t/.test(l)) ? '23andme' : 'unknown'

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    const fields = line.split('\t')

    if (format === 'vcf') {
      // #CHROM POS ID REF ALT QUAL FILTER INFO FORMAT SAMPLE
      if (fields.length < 10) continue
      const [, , id, ref, alt, , , , fmt, sample] = fields
      if (!wanted.has(id)) continue
      const gtIndex = fmt.split(':').indexOf('GT')
      if (gtIndex === -1) continue
      const gt = sample.split(':')[gtIndex]
      const alleles = gt.split(/[/|]/).map((a) => {
        if (a === '0') return ref
        const altIndex = Number.parseInt(a, 10) - 1
        return alt.split(',')[altIndex] ?? ref
      })
      if (alleles.length === 2) calls[id] = alleles.join('')
    } else {
      // rsid chromosome position genotype
      if (fields.length < 4) continue
      const [id, , , genotype] = fields
      if (!wanted.has(id)) continue
      if (/^[ACGT-]{1,2}$/.test(genotype)) calls[id] = genotype
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
  readonly provenance = 'fixture' as const

  async analyze(input: GenomeInput): Promise<PharmCATReport> {
    const parsed = parseGenomeFile(input.contents ?? '')
    const genes = buildGeneCalls(parsed.calls, input.assayType)
    return {
      reportId: `tagsnp-${input.fileName}`,
      provenance: 'fixture',
      pharmcatVersion: 'reduced tag-SNP caller (not PharmCAT)',
      assayType: input.assayType,
      genes,
      excludedGenes: excludedGeneCalls({}),
      recommendations: genotypeOnlyRecommendations(genes),
    }
  }
}

export function buildGeneCalls(calls: Record<string, string>, assayType: AssayType): GeneCall[] {
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

    if (found.length === 0) {
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
      missingPositionLabels: [
        ...missing.map((v) => v.label),
        ...(assayType === 'consumer-array' ? (UNCALLABLE_BY_ARRAY[geneName] ?? []) : []),
      ],
      structuralVariationUnresolved: geneName === 'CYP2D6' && assayType !== 'targeted-pgx',
    })
  }

  return genes
}
