/**
 * Extension 4 — treatment-history reconstruction.
 *
 * Past treatment is important clinical context, but a recorded outcome is not a causal
 * experiment. This module places a CPIC-covered gene–drug result beside a past trial and may
 * raise an exposure or dosing question for review. It never concludes that metabolism caused
 * benefit, non-response or an adverse effect.
 *
 * Past trials use the recorded genetic phenotype only. The medicines, dose, adherence and
 * other circumstances at that time are unknown, so current phenoconversion is not projected
 * backwards.
 */

import type { DrugProfile } from '../data/cpic'
import type {
  Claim,
  GenePhenotypeResult,
  PastTrial,
  Phenotype,
  TrialExplanation,
  TrialReconstruction,
} from './types'

const SLOW: Phenotype[] = ['Poor Metabolizer', 'Intermediate Metabolizer']
const FAST: Phenotype[] = ['Ultrarapid Metabolizer', 'Rapid Metabolizer']

const isSlow = (p: Phenotype) => SLOW.includes(p)
const isFast = (p: Phenotype) => FAST.includes(p)

/** Generic drug names are stored lowercase; they still need a capital at a sentence start. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

interface Analysis {
  explanation: TrialExplanation
  mechanism: Claim | null
  supporting: Claim[]
  patientSummary: string
}

function analyseSideEffects(
  trial: PastTrial,
  relevant: GenePhenotypeResult[],
): Analysis {
  const slowGene = relevant.find((g) => isSlow(g.geneticPhenotype))

  if (slowGene) {
    return {
      explanation: 'possible',
      mechanism: {
        text:
          `${cap(trial.drug)} has CPIC guidance for ${slowGene.gene}, and the recorded genotype predicts a ` +
          `${slowGene.geneticPhenotype}. That result raises an exposure and dosing question for review. ` +
          `The reported side effects do not establish cause, especially without the dose, duration, timing, ` +
          `adherence and medicines taken during that trial.`,
        citationIds: ['cpic-2023-sri'],
      },
      supporting: slowGene.confidence.reasons,
      patientSummary:
        `Your PGx result raises a dosing question worth reviewing for ${trial.drug}. It cannot show that ` +
        `your genotype caused the side effects you recorded.`,
    }
  }

  return {
    explanation: 'not_explained_by_genetics',
    mechanism: null,
    supporting: [],
    patientSummary:
      `This PGx result does not provide a supported explanation for the side effects recorded with ` +
      `${trial.drug}. Dose, timing, other medicines and non-genetic causes remain unknown.`,
  }
}

function analyseNoEffect(trial: PastTrial, relevant: GenePhenotypeResult[]): Analysis {
  const fastGene = relevant.find((g) => isFast(g.geneticPhenotype))

  if (fastGene) {
    return {
      explanation: 'possible',
      mechanism: {
        text:
          `${cap(trial.drug)} has CPIC guidance for ${fastGene.gene}, and the recorded genotype predicts a ` +
          `${fastGene.geneticPhenotype}. That result raises an exposure and dosing question. It does not ` +
          `establish why the medicine did not help without the actual dose, duration, adherence, indication ` +
          `and medicines taken during the trial.`,
        citationIds: ['cpic-2023-sri'],
      },
      supporting: fastGene.confidence.reasons,
      patientSummary:
        `Your PGx result raises an exposure question worth reviewing for ${trial.drug}. It cannot show ` +
        `that metabolism caused the lack of benefit you recorded.`,
    }
  }

  const slowGene = relevant.find((g) => isSlow(g.geneticPhenotype))
  if (slowGene) {
    return {
      explanation: 'not_explained_by_genetics',
      mechanism: {
        text:
          `${cap(trial.drug)} has CPIC guidance for ${slowGene.gene}, and the recorded genotype predicts a ` +
          `${slowGene.geneticPhenotype}. That finding is relevant to exposure and dosing, but it does not ` +
          `establish why the medicine did not help.`,
        citationIds: ['cpic-2023-sri'],
      },
      supporting: [],
      patientSummary:
        `This PGx result raises a dosing question for ${trial.drug}, but it does not explain why the ` +
        `medicine did not help. Dose, duration, adherence and other clinical details remain unknown.`,
    }
  }

  return {
    explanation: 'not_explained_by_genetics',
    mechanism: null,
    supporting: [],
    patientSummary:
      `Your PGx result does not explain why ${trial.drug} did not help. The report leaves the reason unknown.`,
  }
}

function analyseHelped(trial: PastTrial, relevant: GenePhenotypeResult[]): Analysis {
  const notable = relevant.find((g) => isSlow(g.geneticPhenotype) || isFast(g.geneticPhenotype))
  return {
    explanation: notable ? 'possible' : 'not_explained_by_genetics',
    mechanism: notable
      ? {
          text:
            `${cap(trial.drug)} is recorded as having helped, alongside a ${notable.geneticPhenotype} ` +
            `${notable.gene} result. The response history and PGx result are separate evidence for the ` +
            `clinician to interpret; this report does not prescribe a dose or treatment change.`,
          citationIds: ['cpic-2023-sri'],
        }
      : null,
    supporting: [],
    patientSummary:
      `${cap(trial.drug)} is recorded as having helped before. That is important clinical history, but the ` +
      `app cannot determine whether it remains the right option now.`,
  }
}

export function reconstructTrials(
  trials: PastTrial[],
  genes: GenePhenotypeResult[],
  profileOf: (drug: string) => DrugProfile | undefined,
): TrialReconstruction[] {
  return trials.map((trial) => {
    const profile = profileOf(trial.drug)
    const relevantGeneNames = profile?.primaryGenes ?? []
    const relevant = genes.filter((g) => relevantGeneNames.includes(g.gene))

    let analysis: Analysis
    switch (trial.outcome) {
      case 'side_effects':
        analysis = analyseSideEffects(trial, relevant)
        break
      case 'no_effect':
        analysis = analyseNoEffect(trial, relevant)
        break
      case 'helped':
        analysis = analyseHelped(trial, relevant)
        break
      default:
        analysis = {
          explanation: 'not_explained_by_genetics',
          mechanism: null,
          supporting: [],
          patientSummary: `You recorded stopping ${trial.drug} for another reason. No cause is inferred.`,
        }
    }

    return {
      drug: trial.drug,
      outcome: trial.outcome,
      explanation: analysis.explanation,
      mechanism: analysis.mechanism,
      supporting: analysis.supporting,
      patientSummary: analysis.patientSummary,
    }
  })
}
