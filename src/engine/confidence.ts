/**
 * Extension 3 — confidence and coverage scoring.
 *
 * Confidence is limited by the evidence actually supplied to this build. Reporter JSON
 * alone does not include PharmCAT's separate missing-position VCF, and the reduced tag-SNP
 * prototype is not a clinical allele caller. Neither is allowed to look complete.
 *
 * CYP2D6 copy number, duplications and CYP2D6-CYP2D7 hybrids cannot be resolved by the
 * reduced SNP path. The UI therefore shows categorical limitations. These tiers are
 * transparency labels, not calibrated probabilities and do not order medicines.
 */

import type { AssayType, Claim, ConfidenceLevel, GeneCall, GeneConfidence } from './types'

const ASSAY_LABEL: Record<AssayType, string> = {
  'consumer-array': 'consumer SNP array export',
  wgs: 'whole genome sequencing',
  'targeted-pgx': 'targeted pharmacogenomic panel',
}

const HEADLINE: Record<ConfidenceLevel, string> = {
  high: 'high confidence',
  moderate: 'moderate confidence',
  low: 'low confidence',
}

export function scoreGene(gene: GeneCall, assayType: AssayType): GeneConfidence {
  const reasons: Claim[] = []

  // 1. Structural variation the assay cannot see. This dominates everything else.
  if (gene.structuralVariationUnresolved) {
    reasons.push({
      text:
        `${gene.gene} structural variation is unresolved in this result. For CYP2D6, an ordinary VCF or ` +
        `small SNP set cannot reliably resolve deletions, duplications, copy number and CYP2D6-CYP2D7 ` +
        `hybrids. Clinical use requires an appropriate validated call, supplied to PharmCAT as an outside call.`,
      citationIds: ['pharmgkb-cyp2d6-structural', 'cpic-activity-score'],
    })
  }

  if (gene.coverageScope === 'report-json-only') {
    reasons.push({
      text:
        `A PharmCAT Reporter JSON was parsed for ${gene.gene}, but the separate missing-position VCF was not ` +
        `supplied to this app. Coverage completeness is therefore unknown; no missing position is assumed ` +
        `to be the reference allele.`,
      citationIds: ['pharmcat'],
    })
  } else if (gene.coverageScope === 'reduced-prototype') {
    reasons.push({
      text:
        `This exploratory call checks only the prototype's small tag-variant set for ${gene.gene}. It is not ` +
        `a PharmCAT or clinical laboratory call and cannot establish a complete star-allele result.`,
      citationIds: ['pharmcat'],
    })
  } else if (gene.coverageScope === 'fixture') {
    reasons.push({
      text:
        `${gene.gene} comes from a fictional known-result fixture. It demonstrates the report flow and must ` +
        `not be interpreted as patient assay confidence.`,
      citationIds: ['pharmcat'],
    })
  }

  // 2. Positions PharmCAT expected and did not find.
  const expected = gene.positionsCalled + gene.positionsMissing
  if (expected > 0 && gene.positionsMissing > 0) {
    reasons.push({
      text:
        `${gene.positionsMissing} of ${expected} positions checked by this input path for ${gene.gene} were absent ` +
        `from the uploaded file (${gene.missingPositionLabels.slice(0, 4).join(', ')}` +
        `${gene.missingPositionLabels.length > 4 ? ', and others' : ''}). Missing does not mean reference; ` +
        `the result remains incomplete.`,
      citationIds: ['pharmcat'],
    })
  }

  // An indeterminate call is not usable for a gene-driven recommendation.
  if (gene.phenotype === 'Indeterminate') {
    reasons.push({
      text: `${gene.gene} could not be resolved to a phenotype from the supplied data, so no ${gene.gene}-driven recommendation is made.`,
      citationIds: ['pharmcat'],
    })
  }

  if (!reasons.length && gene.coverageScope === 'pharmcat-complete') {
    reasons.push({
      text:
        `All positions PharmCAT expects for ${gene.gene} were present, and ${gene.gene} has no clinically ` +
        `significant structural variation to resolve. This diplotype calls reliably from a ${ASSAY_LABEL[assayType]}.`,
      citationIds: ['pharmcat'],
    })
  }

  const level: ConfidenceLevel =
    gene.phenotype === 'Indeterminate' ||
    gene.structuralVariationUnresolved ||
    gene.coverageScope === 'reduced-prototype'
      ? 'low'
      : gene.coverageScope === 'report-json-only' ||
          gene.coverageScope === 'fixture' ||
          gene.positionsMissing > 0
        ? 'moderate'
        : 'high'

  return {
    gene: gene.gene,
    level,
    headline: gene.structuralVariationUnresolved
      ? `${HEADLINE[level]} — CYP2D6 structural variation unresolved`
      : HEADLINE[level],
    reasons,
  }
}
