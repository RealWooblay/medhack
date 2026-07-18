/**
 * Extension 3 — confidence and coverage scoring.
 *
 * PharmCAT reports which expected positions were missing from the VCF. It does not tell
 * you what that means. This module turns coverage into a per-gene trust score.
 *
 * The load-bearing case: CYP2C19 calls cleanly from consumer array data, CYP2D6 does not.
 * Copy number variants, gene duplications and CYP2D6-CYP2D7 hybrids are not measurable
 * from a SNP array at all, so a CYP2D6 phenotype derived from one can be confidently
 * wrong. We surface that as a trust score rather than hiding it, and the ranking layer
 * consumes the score directly — a low-confidence gene call actively pushes the shortlist
 * toward drugs whose safety does not depend on that call.
 */

import type { AssayType, Claim, ConfidenceLevel, GeneCall, GeneConfidence } from './types'

const ASSAY_FACTOR: Record<AssayType, number> = {
  'consumer-array': 0.9,
  wgs: 1.0,
  'targeted-pgx': 1.0,
}

const ASSAY_LABEL: Record<AssayType, string> = {
  'consumer-array': 'consumer SNP array export',
  wgs: 'whole genome sequencing',
  'targeted-pgx': 'targeted pharmacogenomic panel',
}

function levelFor(score: number): ConfidenceLevel {
  if (score >= 0.8) return 'high'
  if (score >= 0.55) return 'moderate'
  return 'low'
}

const HEADLINE: Record<ConfidenceLevel, string> = {
  high: 'high confidence',
  moderate: 'moderate confidence',
  low: 'low confidence',
}

export function scoreGene(gene: GeneCall, assayType: AssayType): GeneConfidence {
  const reasons: Claim[] = []
  let score = 1.0

  // 1. Structural variation the assay cannot see. This dominates everything else.
  if (gene.structuralVariationUnresolved) {
    score *= 0.45
    reasons.push({
      text:
        `Copy number is not callable from a ${ASSAY_LABEL[assayType]}. ${gene.gene} gene deletions, ` +
        `duplications and ${gene.gene}-CYP2D7 hybrid alleles change enzyme activity but are not ` +
        `represented on a SNP array, so this phenotype could be confidently wrong. A duplication of a ` +
        `functional allele would raise the true activity; a hybrid or deletion would lower it.`,
      citationIds: ['pharmgkb-cyp2d6-structural', 'cpic-activity-score'],
    })
  }

  // 2. Positions PharmCAT expected and did not find.
  const expected = gene.positionsCalled + gene.positionsMissing
  if (expected > 0 && gene.positionsMissing > 0) {
    const missingFraction = gene.positionsMissing / expected
    score *= 1 - Math.min(0.35, missingFraction * 0.7)
    reasons.push({
      text:
        `${gene.positionsMissing} of ${expected} positions PharmCAT expects for ${gene.gene} were absent ` +
        `from the uploaded file (${gene.missingPositionLabels.slice(0, 4).join(', ')}` +
        `${gene.missingPositionLabels.length > 4 ? ', and others' : ''}). Absent positions are treated as ` +
        `reference by the caller, which can mask a reduced-function allele.`,
      citationIds: ['pharmcat'],
    })
  }

  // 3. Assay class.
  score *= ASSAY_FACTOR[assayType]

  // 4. An indeterminate call is barely a call.
  if (gene.phenotype === 'Indeterminate') {
    score *= 0.5
    reasons.push({
      text: `${gene.gene} could not be resolved to a phenotype from the supplied data, so no ${gene.gene}-driven recommendation is made.`,
      citationIds: ['pharmcat'],
    })
  }

  if (!reasons.length) {
    reasons.push({
      text:
        `All positions PharmCAT expects for ${gene.gene} were present, and ${gene.gene} has no clinically ` +
        `significant structural variation to resolve. This diplotype calls reliably from a ${ASSAY_LABEL[assayType]}.`,
      citationIds: ['pharmcat'],
    })
  }

  const rounded = Math.round(score * 100) / 100
  const level = levelFor(rounded)

  return {
    gene: gene.gene,
    level,
    score: rounded,
    headline: gene.structuralVariationUnresolved
      ? `${HEADLINE[level]} — copy number not callable from this file type`
      : HEADLINE[level],
    reasons,
  }
}

/**
 * Confidence weight applied to a drug's ranking score when its recommendation depends on
 * a given gene. A high-confidence call is worth its full weight; a low-confidence call is
 * discounted, which is what makes an enzyme-independent drug rise to the top when the
 * enzyme call itself is shaky.
 */
export function rankingWeight(confidence: GeneConfidence): number {
  return 0.4 + 0.6 * confidence.score
}
