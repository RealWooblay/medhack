/**
 * Extension 1 — the phenoconversion engine.
 *
 * PharmCAT tells you what a patient's genes say. It does not know what else the patient is
 * swallowing every morning. A genetically normal CYP2D6 metaboliser taking fluoxetine is,
 * functionally, a poor metaboliser — and the next CYP2D6-dependent drug prescribed at a
 * standard dose is effectively an overdose.
 *
 * Where this engine deliberately does LESS than it could:
 *
 *   CPIC states, verbatim, that "consensus approaches for adjusting CYP2D6, CYP2C19, or
 *   CYP2B6 predicted phenotypes in the presence of inhibitors or inducers have not been
 *   established." A validated method does exist for CYP2D6 specifically — CPIC
 *   operationalises it in its own guidelines as: for a strong inhibitor the activity score
 *   is adjusted to 0 and the predicted phenotype is poor metaboliser; for a moderate
 *   inhibitor the score is multiplied by 0.5 and re-mapped. There is no such method for
 *   CYP2C19 or CYP2B6.
 *
 *   So this engine applies the multiplier to CYP2D6 and, for the other genes, raises a
 *   prominent unresolved-interaction warning instead of stepping the phenotype down a tier.
 *   Inventing a converted phenotype for CYP2C19 would be exactly the failure mode the
 *   product exists to prevent, one layer below where anyone would think to look for it.
 */

import { EFFECT_LABELS, EFFECT_MULTIPLIERS, effectOf, severityRank, tableFor } from '../data/interactions'
import { canonicalDrug } from '../data/drug-lexicon'
import type {
  Claim,
  GeneCall,
  ModifierEffect,
  Phenotype,
  PhenoconversionModifier,
  PhenoconversionStatus,
} from './types'

/** Sentence-initial capitalisation for generic drug names, which are stored lowercase. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Genes for which a validated, guideline-operationalised adjustment method exists. */
const VALIDATED_ADJUSTMENT_GENES = new Set(['CYP2D6'])

/** CPIC / DPWG consensus activity-score cut-offs for CYP2D6. */
export function activityScoreToPhenotype(score: number): Phenotype {
  if (score === 0) return 'Poor Metabolizer'
  if (score < 1.25) return 'Intermediate Metabolizer'
  if (score <= 2.25) return 'Normal Metabolizer'
  return 'Ultrarapid Metabolizer'
}

export interface PhenoconversionOutcome {
  functionalPhenotype: Phenotype
  functionalActivityScore: number | null
  modifiers: PhenoconversionModifier[]
  converted: boolean
  status: PhenoconversionStatus
  explanation: Claim | null
  unresolvedWarning: Claim | null
}

function findModifiers(gene: string, medications: string[]): PhenoconversionModifier[] {
  const table = tableFor(gene)
  const mods: PhenoconversionModifier[] = []

  for (const raw of medications) {
    const generic = canonicalDrug(raw) ?? raw
    const effect = effectOf(generic, gene)
    if (!effect) continue
    mods.push({
      drug: generic,
      enzyme: gene,
      effect,
      multiplier: EFFECT_MULTIPLIERS[effect],
      citationIds: table?.citationIds ?? ['fda-interaction-table'],
    })
  }

  // Strongest effect first, so the dominant modifier is always mods[0].
  return mods.sort((a, b) => severityRank(a.effect) - severityRank(b.effect))
}

function isActionable(effect: ModifierEffect): boolean {
  return effect === 'strong_inhibitor' || effect === 'moderate_inhibitor'
}

/* ------------------------------------------------------------------ */

function convertedExplanation(
  gene: string,
  dominant: PhenoconversionModifier,
  genetic: Phenotype,
  functional: Phenotype,
  geneticScore: number,
  functionalScore: number,
): Claim {
  return {
    text:
      `${cap(dominant.drug)} is a ${EFFECT_LABELS[dominant.effect]} of ${gene}. CPIC's method for ${gene} is to ` +
      `adjust the activity score for a concurrent inhibitor and re-map it: a genetic ${gene} activity score of ` +
      `${geneticScore} becomes an effective score of ${functionalScore}, which corresponds to a ${functional}. ` +
      `The patient's ${gene} genotype predicts a ${genetic}, so while ${dominant.drug} is taken concurrently, ` +
      `${gene} dosing decisions should follow the functional phenotype rather than the genetic one.`,
    citationIds: [...dominant.citationIds, 'cpic-activity-score'],
  }
}

function unvalidatedWarning(gene: string, dominant: PhenoconversionModifier, genetic: Phenotype): Claim {
  return {
    text:
      `${cap(dominant.drug)} is a ${EFFECT_LABELS[dominant.effect]} of ${gene}, so this patient's true ${gene} ` +
      `activity is very likely lower than their genotype alone suggests. CPIC states that consensus approaches ` +
      `for adjusting ${gene} predicted phenotypes in the presence of inhibitors or inducers have not been ` +
      `established, so no adjusted phenotype is calculated here — the reported ${gene} phenotype remains the ` +
      `genetic ${genetic}, and this interaction is flagged for prescriber judgement instead of being resolved ` +
      `by a rule that no guideline supports.`,
    citationIds: [...dominant.citationIds, 'cpic-2023-sri'],
  }
}

function uncertainExtentWarning(gene: string, dominant: PhenoconversionModifier): Claim {
  return {
    text:
      `This patient is a genetic ${gene} ultrarapid metaboliser taking ${dominant.drug}, a ` +
      `${EFFECT_LABELS[dominant.effect]}. CPIC notes that the extent to which ultrarapid metabolisers ` +
      `phenoconvert under a strong inhibitor is unclear, so the resulting functional phenotype is reported ` +
      `with that uncertainty attached rather than as a settled poor-metaboliser result.`,
    citationIds: [...dominant.citationIds, 'cpic-2023-sri'],
  }
}

function noChangeExplanation(gene: string, mods: PhenoconversionModifier[]): Claim {
  const names = mods.map((m) => `${m.drug} (${EFFECT_LABELS[m.effect]})`).join(', ')
  return {
    text:
      `${cap(names)} act on ${gene}, but not strongly enough for any validated adjustment to apply, so the ` +
      `functional phenotype matches the genetic one. They are recorded because adding a further inhibitor ` +
      `could change that.`,
    citationIds: mods[0].citationIds,
  }
}

/* ------------------------------------------------------------------ */

export function computePhenoconversion(
  gene: GeneCall,
  currentMedications: string[],
): PhenoconversionOutcome {
  const modifiers = findModifiers(gene.gene, currentMedications)
  const genetic = gene.phenotype

  const base: PhenoconversionOutcome = {
    functionalPhenotype: genetic,
    functionalActivityScore: gene.activityScore,
    modifiers,
    converted: false,
    status: 'no_modifiers',
    explanation: null,
    unresolvedWarning: null,
  }

  if (!modifiers.length) return base

  const dominant = modifiers[0]

  if (!isActionable(dominant.effect)) {
    return { ...base, status: 'no_change', explanation: noChangeExplanation(gene.gene, modifiers) }
  }

  // No validated adjustment method for this gene — flag, do not convert.
  if (!VALIDATED_ADJUSTMENT_GENES.has(gene.gene) || gene.activityScore === null) {
    return {
      ...base,
      status: 'unvalidated_method',
      unresolvedWarning: unvalidatedWarning(gene.gene, dominant, genetic),
    }
  }

  // CYP2D6 — CPIC's activity-score multiplier.
  const functionalScore = Math.round(gene.activityScore * dominant.multiplier * 100) / 100
  const functional = activityScoreToPhenotype(functionalScore)
  const converted = functional !== genetic

  if (genetic === 'Ultrarapid Metabolizer') {
    return {
      ...base,
      functionalPhenotype: functional,
      functionalActivityScore: functionalScore,
      converted,
      status: 'uncertain_extent',
      explanation: converted
        ? convertedExplanation(gene.gene, dominant, genetic, functional, gene.activityScore, functionalScore)
        : null,
      unresolvedWarning: uncertainExtentWarning(gene.gene, dominant),
    }
  }

  return {
    ...base,
    functionalPhenotype: functional,
    functionalActivityScore: functionalScore,
    converted,
    status: converted ? 'converted' : 'no_change',
    explanation: converted
      ? convertedExplanation(gene.gene, dominant, genetic, functional, gene.activityScore, functionalScore)
      : noChangeExplanation(gene.gene, modifiers),
    unresolvedWarning: null,
  }
}
