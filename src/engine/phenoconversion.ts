/**
 * Extension 1 — the phenoconversion engine.
 *
 * PharmCAT tells you what a patient's genes say. It does not know what else the patient is
 * taking. A supported CYP2D6 inhibitor adjustment can therefore differ from the genetic
 * phenotype and change the applicable gene–drug guidance. It does not by itself establish
 * exposure, toxicity or a treatment decision.
 *
 * Where this engine deliberately does LESS than it could:
 *
 *   CPIC states, verbatim, that "consensus approaches for adjusting CYP2D6, CYP2C19, or
 *   CYP2B6 predicted phenotypes in the presence of inhibitors or inducers have not been
 *   established." CYP2D6 studies often model a strong inhibitor by setting activity score
 *   to 0 and a moderate inhibitor by multiplying it by 0.5. That convention is useful for
 *   exposing a possible interaction, but it is not treated here as a validated patient
 *   phenotype or as dosing authority. There is no equivalent numeric convention for
 *   CYP2C19 or CYP2B6.
 *
 *   So this engine may show the CYP2D6 research-convention estimate beside the reported
 *   genotype result, with uncertainty attached. It never replaces the reported phenotype or
 *   PharmCAT recommendation. For the other genes it raises an unresolved-interaction warning.
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

/** Genes for which this build has a sourced research convention it can show as an estimate. */
const MODELED_ADJUSTMENT_GENES = new Set(['CYP2D6'])

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
  modeledFunctionalPhenotype: Phenotype | null
  modeledFunctionalActivityScore: number | null
  modifiers: PhenoconversionModifier[]
  converted: boolean
  status: PhenoconversionStatus
  explanation: Claim | null
  unresolvedWarning: Claim | null
}

function findModifiers(gene: string, medications: string[]): PhenoconversionModifier[] {
  const table = tableFor(gene)
  const mods: PhenoconversionModifier[] = []
  const seen = new Set<string>()

  for (const raw of medications) {
    const generic = (canonicalDrug(raw) ?? raw).trim()
    const key = generic.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
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
  return effect === 'strong_inhibitor' || effect === 'moderate_inhibitor' ||
    effect === 'strong_inducer' || effect === 'moderate_inducer'
}

const isInhibitor = (effect: ModifierEffect): boolean => effect.endsWith('_inhibitor')
const isInducer = (effect: ModifierEffect): boolean => effect.endsWith('_inducer')

/* ------------------------------------------------------------------ */

function modeledEstimateExplanation(
  gene: string,
  dominant: PhenoconversionModifier,
  genetic: Phenotype,
  functional: Phenotype,
  geneticScore: number,
  functionalScore: number,
): Claim {
  return {
    text:
      `${cap(dominant.drug)} is a ${EFFECT_LABELS[dominant.effect]} of ${gene}. The CPIC antidepressant ` +
      `supplement describes a common research convention for concurrent inhibitors: a reported ${gene} activity score of ` +
      `${geneticScore} models to ${functionalScore}, which maps to ${functional}. The reported genetic result is ` +
      `${genetic}. The modeled value is an uncertain estimate, not a validated patient phenotype, and it does ` +
      `not replace the imported PharmCAT guidance or determine a dose.`,
    citationIds: [...new Set([...dominant.citationIds, 'cpic-2023-sri', 'cpic-activity-score'])],
  }
}

function unvalidatedWarning(gene: string, dominant: PhenoconversionModifier, genetic: Phenotype): Claim {
  const direction = isInducer(dominant.effect) ? 'higher' : 'lower'
  return {
    text:
      `${cap(dominant.drug)} is a ${EFFECT_LABELS[dominant.effect]} of ${gene}, so this patient's true ${gene} ` +
      `activity may be ${direction} than their genotype alone suggests. CPIC states that consensus approaches ` +
      `for adjusting ${gene} predicted phenotypes in the presence of inhibitors or inducers have not been ` +
      `established, so no adjusted phenotype is calculated here — the reported ${gene} phenotype remains the ` +
      `genetic ${genetic}, and this interaction is flagged for prescriber judgement instead of being resolved ` +
      `by a rule that no guideline supports.`,
    citationIds: [...dominant.citationIds, 'cpic-2023-sri'],
  }
}

function opposingEffectsWarning(
  gene: string,
  modifiers: PhenoconversionModifier[],
  genetic: Phenotype,
): Claim {
  const names = modifiers
    .filter((modifier) => isActionable(modifier.effect))
    .map((modifier) => `${cap(modifier.drug)} (${EFFECT_LABELS[modifier.effect]})`)
    .join(', ')
  return {
    text:
      `${names} have opposing effects on ${gene}. The reported phenotype remains ${genetic}. This build does ` +
      `not collapse opposing inhibitor and inducer effects into a phenotype or dose; the combination requires ` +
      `prescriber review.`,
    citationIds: [...new Set(modifiers.flatMap((modifier) => modifier.citationIds).concat('cpic-2023-sri'))],
  }
}

function multipleModifierWarning(
  gene: string,
  modifiers: PhenoconversionModifier[],
  genetic: Phenotype,
): Claim {
  const actionable = modifiers.filter((modifier) => isActionable(modifier.effect))
  const names = actionable
    .map((modifier) => `${cap(modifier.drug)} (${EFFECT_LABELS[modifier.effect]})`)
    .join(', ')
  return {
    text:
      `${names} are all classified modifiers of ${gene}. The reported phenotype remains ${genetic}. ` +
      `The single-inhibitor research convention is not applied to a multi-modifier regimen, because that ` +
      `would imply a precision the cited method does not establish.`,
    citationIds: [...new Set(actionable.flatMap((modifier) => modifier.citationIds).concat('cpic-2023-sri'))],
  }
}

function uncertainExtentWarning(
  gene: string,
  dominant: PhenoconversionModifier,
  genetic: Phenotype,
): Claim {
  return {
    text:
      `${cap(dominant.drug)} is recorded with a genetic ${gene} result of ${genetic}. CPIC states that ` +
      `consensus approaches for converting predicted phenotypes in the presence of inhibitors have not been ` +
      `established, and antidepressant-specific text notes uncertainty in the extent of CYP2D6 phenoconversion. ` +
      `The modeled value is therefore shown only as a research-convention estimate.`,
    citationIds: [...dominant.citationIds, 'cpic-2023-sri'],
  }
}

function noChangeExplanation(gene: string, mods: PhenoconversionModifier[]): Claim {
  const names = mods.map((m) => `${m.drug} (${EFFECT_LABELS[m.effect]})`).join(', ')
  return {
    text:
      `${cap(names)} act on ${gene}, but the captured research convention does not change the displayed ` +
      `genetic result. A stronger or opposing modifier would require a separate review.`,
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
    modeledFunctionalPhenotype: null,
    modeledFunctionalActivityScore: null,
    modifiers,
    converted: false,
    status: 'no_modifiers',
    explanation: null,
    unresolvedWarning: null,
  }

  if (!modifiers.length) return base

  const dominant = modifiers[0]
  const actionable = modifiers.filter((modifier) => isActionable(modifier.effect))
  const hasOpposingEffects = actionable.some((modifier) => isInhibitor(modifier.effect)) &&
    actionable.some((modifier) => isInducer(modifier.effect))

  if (hasOpposingEffects) {
    return {
      ...base,
      status: 'unvalidated_method',
      unresolvedWarning: opposingEffectsWarning(gene.gene, modifiers, genetic),
    }
  }

  if (actionable.length > 1) {
    return {
      ...base,
      status: 'unvalidated_method',
      unresolvedWarning: multipleModifierWarning(gene.gene, modifiers, genetic),
    }
  }

  if (!isActionable(dominant.effect)) {
    return { ...base, status: 'no_change', explanation: noChangeExplanation(gene.gene, modifiers) }
  }

  // No sourced numeric convention for this gene — flag, do not estimate.
  if (
    !MODELED_ADJUSTMENT_GENES.has(gene.gene) ||
    gene.activityScore === null ||
    !Number.isFinite(gene.activityScore) ||
    gene.activityScore < 0 ||
    genetic === 'Indeterminate'
  ) {
    return {
      ...base,
      status: 'unvalidated_method',
      unresolvedWarning: unvalidatedWarning(gene.gene, dominant, genetic),
    }
  }

  // CYP2D6 research convention — calculate an estimate but never replace the reported call.
  const modeledScore = Math.round(gene.activityScore * dominant.multiplier * 100) / 100
  const modeledPhenotype = activityScoreToPhenotype(modeledScore)
  return {
    ...base,
    modeledFunctionalPhenotype: modeledPhenotype,
    modeledFunctionalActivityScore: modeledScore,
    converted: false,
    status: 'uncertain_extent',
    explanation: modeledEstimateExplanation(
      gene.gene,
      dominant,
      genetic,
      modeledPhenotype,
      gene.activityScore,
      modeledScore,
    ),
    unresolvedWarning: uncertainExtentWarning(gene.gene, dominant, genetic),
  }
}
