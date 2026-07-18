/**
 * Treatment-history context bound to the exact imported PharmCAT result.
 *
 * A past outcome is not a genetic experiment. This module only says whether this patient's
 * uploaded report contains an actionable annotation for that same medicine. It never uses a
 * static drug profile to manufacture a match and never claims that genetics caused benefit,
 * non-response or an adverse effect.
 */

import { canonicalDrug } from '../data/drug-lexicon'
import type {
  Claim,
  GenePhenotypeResult,
  PastTrial,
  PharmCATDrugRecommendation,
  RecommendationAction,
  TrialReconstruction,
} from './types'

const ACTIONABLE = new Set<RecommendationAction>([
  'avoid',
  'alternative',
  'decrease_start',
  'decrease',
  'caution',
  'increase',
  'standard_start_reduced_maintenance',
  'standard_start_conditional_increase',
])

function normaliseDrug(value: string): string {
  return (canonicalDrug(value) ?? value).trim().toLowerCase()
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function outcomeLimit(trial: PastTrial): string {
  switch (trial.outcome) {
    case 'side_effects':
      return 'It cannot show what caused the side effects.'
    case 'no_effect':
      return 'It cannot show why the medicine did not help.'
    case 'helped':
      return 'It cannot show why the medicine helped.'
    case 'stopped_other':
      return 'It cannot show why the medicine was stopped.'
  }
}

function geneLabel(recommendations: PharmCATDrugRecommendation[]): string {
  const values = recommendations.flatMap((recommendation) => recommendation.geneResults)
  const unique = new Map(values.map((result) => [
    `${result.gene}:${result.phenotype}`,
    `${result.gene} ${result.phenotype}`,
  ]))
  return [...unique.values()].join(' + ')
}

export function reconstructTrials(
  trials: PastTrial[],
  genes: GenePhenotypeResult[],
  recommendations: PharmCATDrugRecommendation[],
): TrialReconstruction[] {
  return trials.map((trial) => {
    const drug = normaliseDrug(trial.drug)
    const matched = recommendations.filter((item) => normaliseDrug(item.drug) === drug)
    const actionable = matched.filter((item) => ACTIONABLE.has(item.action))

    if (!actionable.length) {
      return {
        drug,
        outcome: trial.outcome,
        explanation: 'not_explained_by_genetics',
        mechanism: null,
        supporting: [],
        patientSummary: matched.length
          ? `${cap(drug)} has a matched PharmCAT annotation, but it does not provide an actionable explanation for this past result. ${outcomeLimit(trial)}`
          : `No matched PharmCAT guidance was imported for ${drug}. ${outcomeLimit(trial)}`,
      }
    }

    const relevantGenes = new Set(actionable.flatMap((item) => item.geneResults.map((result) => result.gene)))
    const supporting: Claim[] = genes
      .filter((gene) => relevantGenes.has(gene.gene))
      .flatMap((gene) => gene.confidence.reasons)
    const citationIds = [...new Set(actionable.flatMap((item) => item.citationIds))]

    return {
      drug,
      outcome: trial.outcome,
      explanation: 'possible',
      mechanism: {
        text:
          `The imported PharmCAT result has actionable guidance for ${drug} using ${geneLabel(actionable)}. ` +
          `That guidance is relevant to reviewing the old dose and trial conditions. ${outcomeLimit(trial)}`,
        citationIds,
      },
      supporting,
      patientSummary:
        `The uploaded result contains dosing or medicine-choice guidance relevant to the past ${drug} trial. ` +
        outcomeLimit(trial),
    }
  })
}
