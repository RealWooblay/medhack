/**
 * Extension 4 — treatment-history reconstruction.
 *
 * "You tried paroxetine and stopped in week two" is the single most informative thing a
 * patient brings to an appointment, and no genotype tool does anything with it. This
 * module asks one narrow question per past trial: is what happened consistent with what
 * this person's metabolism predicts?
 *
 * The answer is allowed to be no. A reconstruction that returns `not_explained_by_genetics`
 * is not a failure of the product — it is the product refusing to overclaim, and it keeps
 * the honest boundary visible: genetics can speak to exposure, not to whether a drug will
 * lift someone's depression.
 *
 * Assumption, stated wherever it is used: past trials are evaluated against the GENETIC
 * phenotype, not the current functional one, because we do not know what else the patient
 * was taking at the time. Drug-specific auto-inhibition is applied because that effect is
 * intrinsic to the drug and holds regardless of co-medication.
 */

import { autoInhibitorFor } from '../data/pharmacology'
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
      explanation: 'consistent',
      mechanism: {
        text:
          `${cap(trial.drug)} is cleared by ${slowGene.gene}, and this patient's ${slowGene.gene} genotype ` +
          `predicts a ${slowGene.geneticPhenotype}. Reduced clearance raises plasma concentration at any ` +
          `given dose, which concentrates dose-related adverse effects into the first weeks of treatment — ` +
          `the period when a patient is most likely to stop.`,
        citationIds: ['cpic-2023-sri'],
      },
      supporting: slowGene.confidence.reasons,
      patientSummary:
        `Your body clears ${trial.drug} more slowly than average, so a standard dose would have built up ` +
        `higher than intended. That fits side effects arriving early.`,
    }
  }

  const auto = autoInhibitorFor(trial.drug)
  if (auto) {
    return {
      explanation: 'consistent',
      mechanism: {
        text: auto.note,
        citationIds: auto.citationIds,
      },
      supporting: [],
      patientSummary:
        `${cap(trial.drug)} slows down the very enzyme that removes it from your body, so its level climbs ` +
        `faster than the dose suggests. Side effects early on are a common result, and it does not mean ` +
        `you react badly to antidepressants generally.`,
    }
  }

  return {
    explanation: 'not_explained_by_genetics',
    mechanism: null,
    supporting: [],
    patientSummary:
      `Nothing in your genetic results explains why ${trial.drug} caused side effects. Plenty of side ` +
      `effects have nothing to do with metabolism, so this one stays unexplained rather than guessed at.`,
  }
}

function analyseNoEffect(trial: PastTrial, relevant: GenePhenotypeResult[]): Analysis {
  const fastGene = relevant.find((g) => isFast(g.geneticPhenotype))

  if (fastGene) {
    return {
      explanation: 'consistent',
      mechanism: {
        text:
          `${cap(trial.drug)} is cleared by ${fastGene.gene}, and this patient's ${fastGene.gene} genotype ` +
          `predicts a ${fastGene.geneticPhenotype}. Accelerated clearance can leave plasma concentrations ` +
          `below the therapeutic range at a standard dose, which presents clinically as non-response and ` +
          `is frequently recorded as a treatment failure.`,
        citationIds: ['cpic-2023-sri'],
      },
      supporting: fastGene.confidence.reasons,
      patientSummary:
        `You clear ${trial.drug} unusually fast, so a standard dose may never have reached a level that ` +
        `could work. That looks identical to "the drug didn't help", but it is a dosing problem, not a ` +
        `sign the drug was wrong for you.`,
    }
  }

  const slowGene = relevant.find((g) => isSlow(g.geneticPhenotype))
  if (slowGene) {
    // The important honest case: the genetics point the other way.
    return {
      explanation: 'not_explained_by_genetics',
      mechanism: {
        text:
          `${cap(trial.drug)} is cleared by ${slowGene.gene}, and this patient is a ${slowGene.geneticPhenotype}. ` +
          `That predicts higher, not lower, ${trial.drug} exposure at a standard dose, so underexposure from ` +
          `rapid metabolism cannot account for the reported lack of effect. Pharmacogenomics does not ` +
          `explain this trial.`,
        citationIds: ['cpic-2023-sri'],
      },
      supporting: [],
      patientSummary:
        `This one your genes do not explain. If anything, you would have had more ${trial.drug} in your ` +
        `system than average, not less — so a dosing problem is unlikely to be the reason it did not help. ` +
        `Genetics can tell you about dose and safety, but it cannot predict which antidepressant will lift ` +
        `low mood, and it would be dishonest to invent a reason here.`,
    }
  }

  return {
    explanation: 'not_explained_by_genetics',
    mechanism: null,
    supporting: [],
    patientSummary:
      `Your genetic results do not explain why ${trial.drug} did not help. Most non-response has causes ` +
      `that genetics cannot see.`,
  }
}

function analyseHelped(trial: PastTrial, relevant: GenePhenotypeResult[]): Analysis {
  const notable = relevant.find((g) => isSlow(g.geneticPhenotype) || isFast(g.geneticPhenotype))
  return {
    explanation: notable ? 'possible' : 'consistent',
    mechanism: notable
      ? {
          text:
            `${cap(trial.drug)} helped despite a ${notable.geneticPhenotype} ${notable.gene} phenotype. Where a ` +
            `drug has previously been effective, that clinical response is stronger evidence than any ` +
            `genotype prediction, and dose adjustment rather than a switch is usually the relevant question.`,
          citationIds: ['cpic-2023-sri'],
        }
      : null,
    supporting: [],
    patientSummary:
      `${cap(trial.drug)} worked for you before. That is the most useful single fact in this whole report — ` +
      `a drug that has already helped you outranks anything a genetic test can predict.`,
  }
}

export function reconstructTrials(
  trials: PastTrial[],
  genes: GenePhenotypeResult[],
  profileOf: (drug: string) => DrugProfile | undefined,
): TrialReconstruction[] {
  return trials.map((trial) => {
    const profile = profileOf(trial.drug)
    const relevantGeneNames = profile ? [...profile.primaryGenes, ...profile.secondaryGenes] : []
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
          patientSummary: `You stopped ${trial.drug} for reasons unrelated to how it was working.`,
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
