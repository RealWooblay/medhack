/**
 * Medication-specific PGx assembly.
 *
 * This module applies captured gene–drug guidance across the candidate set. It does not
 * answer which medicine should be prescribed. Results are returned alphabetically and the
 * UI keeps PGx, treatment history, interactions and daily-life context separate.
 *
 * Two design decisions carry most of the value:
 *
 *  1. The CPIC lookup uses the supported functional phenotype when a recorded current
 *     inhibitor has a validated adjustment method.
 *
 *  2. This build does not calculate a post-washout state or combine the evidence lanes into
 *     a treatment score.
 */

import { lookupRecommendation, profileOf, SHORTLIST_CANDIDATES, type DrugProfile } from '../data/cpic'
import { canonicalDrug } from '../data/drug-lexicon'
import type {
  Claim,
  DrugAssessment,
  GeneFinding,
  GenePhenotypeResult,
  InteractionFlag,
  PgxReviewCategory,
  Phenotype,
  RecommendationAction,
  TrialReconstruction,
} from './types'

/* ------------------------------------------------------------------ */
/* Action semantics                                                    */
/* ------------------------------------------------------------------ */

/**
 * Worst first. Used to reduce several gene findings to one verdict.
 *
 * The two `standard_start_*` actions sit near the mild end deliberately: both begin from
 * the ordinary starting dose, so neither is a barrier to starting the drug.
 */
const ACTION_SEVERITY: RecommendationAction[] = [
  'avoid', 'alternative', 'decrease_start', 'decrease', 'caution', 'increase',
  'standard_start_reduced_maintenance', 'standard_start_conditional_increase',
  'no_recommendation', 'standard',
]

function worstAction(actions: RecommendationAction[]): RecommendationAction | null {
  for (const a of ACTION_SEVERITY) if (actions.includes(a)) return a
  return null
}

function categoryFor(findings: GeneFinding[], _cpicCovered: boolean): PgxReviewCategory {
  if (!findings.length) return 'no_gene_based_guidance'
  const worst = worstAction(findings.map((f) => f.action))
  if (!worst) return 'no_gene_based_guidance'

  switch (worst) {
    case 'avoid':
    case 'alternative':
      return 'alternative_discussion'
    case 'decrease_start':
    case 'decrease':
    case 'caution':
    case 'increase':
      return 'dose_or_titration_review'
    case 'standard_start_reduced_maintenance':
    case 'standard_start_conditional_increase':
    case 'standard':
      return 'usual_guidance'
    case 'no_recommendation':
      return findings.some((f) => f.action === 'standard') ? 'usual_guidance' : 'no_gene_based_guidance'
  }
}

function headlineFor(findings: GeneFinding[], cpicCovered: boolean): string {
  if (!findings.length) return cpicCovered ? 'no guideline recommendation' : 'no CPIC recommendation'
  const worst = worstAction(findings.map((f) => f.action))
  switch (worst) {
    case 'avoid':
      return 'avoid'
    case 'alternative':
      return 'consider an alternative'
    case 'decrease_start':
      return 'lower starting dose, slower titration'
    case 'decrease':
      return 'reduce starting and maintenance dose'
    case 'increase':
      return 'may need a higher maintenance dose'
    case 'caution':
      return 'use with caution'
    case 'standard_start_reduced_maintenance':
      return 'usual starting dose, slower titration and lower maintenance dose'
    case 'standard_start_conditional_increase':
      return 'usual starting dose, may need more later'
    case 'standard':
      return 'standard dosing'
    default:
      return 'no guideline recommendation'
  }
}

/* ------------------------------------------------------------------ */
/* Gene findings                                                       */
/* ------------------------------------------------------------------ */

function findingsFor(
  profile: DrugProfile,
  genes: GenePhenotypeResult[],
  usePhenotype: (g: GenePhenotypeResult) => Phenotype,
): GeneFinding[] {
  const findings: GeneFinding[] = []
  for (const geneName of profile.primaryGenes) {
    const gene = genes.find((g) => g.gene === geneName)
    if (!gene) continue
    const phenotype = usePhenotype(gene)
    const rec = lookupRecommendation(geneName, phenotype, profile.drug)
    if (!rec) continue
    findings.push({
      gene: geneName,
      phenotypeUsed: phenotype,
      usedFunctionalPhenotype: phenotype !== gene.geneticPhenotype,
      action: rec.action,
      guidelineText: rec.text,
      strength: rec.strength,
      citationIds: rec.citationIds,
    })
  }
  return findings
}

/* ------------------------------------------------------------------ */
/* Enzyme independence — why a drug sidesteps the problem              */
/* ------------------------------------------------------------------ */

function enzymeIndependenceFor(profile: DrugProfile, genes: GenePhenotypeResult[]): Claim[] {
  if (!profile.cpicCovered) return []
  const claims: Claim[] = []
  for (const gene of genes) {
    const isPrimary = profile.primaryGenes.includes(gene.gene)
    if (isPrimary) continue

    if (gene.converted) {
      claims.push({
        text:
          `${gene.gene} is functionally a ${gene.functionalPhenotype} for this patient, but ${profile.drug} ` +
          `dosing is not governed by ${gene.gene}. ${profile.metabolicNote}`,
        citationIds: profile.citationIds,
      })
    } else if (gene.status === 'unvalidated_method') {
      claims.push({
        text:
          `An inhibitor of ${gene.gene} is on board and its effect on this patient cannot be quantified from ` +
          `any validated method, but ${profile.drug} dosing is not governed by ${gene.gene} — so that ` +
          `unresolved uncertainty does not propagate into this recommendation.`,
        citationIds: profile.citationIds,
      })
    } else if (gene.confidence.level === 'low') {
      claims.push({
        text:
          `The ${gene.gene} call for this patient is low confidence, and ${profile.drug} dosing does not ` +
          `depend on it — so an incorrect ${gene.gene} phenotype would not change this recommendation.`,
        citationIds: profile.citationIds,
      })
    }
  }
  return claims
}

/* ------------------------------------------------------------------ */
/* Interaction flags                                                   */
/* ------------------------------------------------------------------ */

function interactionFlagsFor(
  profile: DrugProfile,
  genes: GenePhenotypeResult[],
): InteractionFlag[] {
  const flags: InteractionFlag[] = []

  // The candidate is dosed on a gene whose interaction the engine refused to resolve.
  for (const gene of genes) {
    if (gene.status !== 'unvalidated_method') continue
    if (!profile.primaryGenes.includes(gene.gene)) continue
    const inhibitor = gene.modifiers[0]
    flags.push({
      withDrug: inhibitor?.drug ?? 'a current medication',
      severity: 'caution',
      text:
        `${profile.drug} is dosed on ${gene.gene}, and ${inhibitor?.drug ?? 'a current medication'} inhibits ` +
        `${gene.gene}. True ${gene.gene} activity is therefore likely lower than the reported ${gene.geneticPhenotype} ` +
        `phenotype, but no validated method exists to quantify by how much, so this needs prescriber judgement ` +
        `rather than a calculated dose.`,
      citationIds: ['cpic-2023-sri', 'fda-interaction-table'],
    })
  }

  return flags
}

/* ------------------------------------------------------------------ */
/* Treatment history — is this worth a second look?                    */
/* ------------------------------------------------------------------ */

interface RetryOutcome {
  category: PgxReviewCategory
  retryRationale: Claim | null
}

function assessRetry(
  drug: string,
  category: PgxReviewCategory,
  pastTrial: TrialReconstruction | null,
  _history: TrialReconstruction[],
): RetryOutcome {
  if (pastTrial) {
    return {
      category,
      retryRationale: {
        text:
          `${capDrug(drug)} is recorded in your treatment history with the outcome “${pastTrial.outcome.replace('_', ' ')}”. ` +
          `That history is shown beside the PGx finding but does not change the PGx category. The app cannot ` +
          `infer why the outcome occurred without the full trial and clinical context.`,
        citationIds: pastTrial.mechanism?.citationIds ?? ['cpic-2023-sri'],
      },
    }
  }

  return { category, retryRationale: null }
}

function capDrug(drug: string): string {
  return drug.charAt(0).toUpperCase() + drug.slice(1)
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface RankingInput {
  genes: GenePhenotypeResult[]
  currentMedications: string[]
  history: TrialReconstruction[]
}

export function assembleDrugFindings({ genes, currentMedications, history }: RankingInput): DrugAssessment[] {
  const meds = currentMedications.map((m) => (canonicalDrug(m) ?? m).toLowerCase())

  const assessments: DrugAssessment[] = []

  for (const drug of SHORTLIST_CANDIDATES) {
    const profile = profileOf(drug)
    if (!profile) continue

    const findings = findingsFor(profile, genes, (g) => g.functionalPhenotype)
    const baseCategory = categoryFor(findings, profile.cpicCovered)
    const headline = headlineFor(findings, profile.cpicCovered)
    const independence = enzymeIndependenceFor(profile, genes)
    const flags = interactionFlagsFor(profile, genes)
    const pastTrial = history.find((h) => h.drug.toLowerCase() === drug.toLowerCase()) ?? null
    const isCurrent = meds.includes(drug.toLowerCase())
    const retry = assessRetry(drug, baseCategory, pastTrial, history)
    const pgxCategory = retry.category

    /* -- reason line -- */
    const reasonParts: string[] = []
    if (findings.length) {
      reasonParts.push(
        findings
          .map((f) => `${f.gene} ${f.phenotypeUsed.replace(' Metabolizer', '')}${f.usedFunctionalPhenotype ? ' (functional)' : ''}`)
          .join(', '),
      )
    }
    if (independence.length && !findings.some((f) => f.action === 'avoid' || f.action === 'alternative')) {
      const sidestepped = genes.filter((g) => g.converted && !profile.primaryGenes.includes(g.gene)).map((g) => g.gene)
      if (sidestepped.length) reasonParts.push(`not ${sidestepped.join('/')}-dependent`)
    }
    if (!profile.cpicCovered) reasonParts.push('outside CPIC scope')

    assessments.push({
      drug,
      drugClass: profile.drugClass,
      pgxCategory,
      headline,
      reason: reasonParts.join(' · ') || profile.metabolicNote.slice(0, 80),
      geneFindings: findings,
      interactionFlags: flags,
      confidenceCaveats: genes
        .filter((g) => profile.primaryGenes.includes(g.gene) && g.confidence.level !== 'high')
        .flatMap((g) => g.confidence.reasons),
      enzymeIndependence: independence,
      pastTrial,
      retryRationale: retry.retryRationale,
      isCurrentMedication: isCurrent,
      citationIds: [
        ...new Set([...findings.flatMap((f) => f.citationIds), ...profile.citationIds]),
      ],
    })
  }

  return assessments.sort((a, b) => {
    if (a.isCurrentMedication !== b.isCurrentMedication) return a.isCurrentMedication ? 1 : -1
    return a.drug.localeCompare(b.drug)
  })
}
