/**
 * Phenoconversion reference data — extension 1, the technical centrepiece.
 *
 * Classifications are taken from the FDA's table of clinical index inhibitors and
 * inducers, which is the same source CPIC uses when it operationalises phenoconversion.
 * Where a drug is commonly described as an inhibitor in the wider literature but is not
 * in the FDA index list, it is recorded as weak and annotated rather than promoted — the
 * engine follows one source rather than blending several.
 *
 * Two classifications here are worth reading twice, because they are the reason the demo
 * patient's result looks the way it does:
 *
 *  - Fluoxetine is a strong inhibitor of BOTH CYP2D6 and CYP2C19. A patient on fluoxetine
 *    is therefore functionally a poor metaboliser on both of the enzymes that drive almost
 *    every CPIC antidepressant recommendation, at once.
 *  - CYP2D6 has no clinically relevant inducers at all. The engine never shifts a CYP2D6
 *    phenotype upward on the basis of a co-medication, because there is nothing to shift it.
 */

import type { ModifierEffect } from '../engine/types'

export interface EnzymeModifierTable {
  enzyme: string
  strongInhibitors: string[]
  moderateInhibitors: string[]
  weakInhibitors: string[]
  strongInducers: string[]
  moderateInducers: string[]
  /** Rendered in the clinician view wherever this enzyme is discussed. */
  note?: string
  citationIds: string[]
}

export const ENZYME_MODIFIERS: EnzymeModifierTable[] = [
  {
    enzyme: 'CYP2D6',
    strongInhibitors: ['bupropion', 'fluoxetine', 'paroxetine', 'quinidine', 'terbinafine'],
    moderateInhibitors: ['abiraterone', 'cinacalcet', 'duloxetine', 'lorcaserin', 'mirabegron', 'rolapitant'],
    weakInhibitors: ['amiodarone', 'celecoxib', 'cimetidine', 'escitalopram', 'hydroxyzine', 'sertraline'],
    strongInducers: [],
    moderateInducers: [],
    note:
      'CYP2D6 is not appreciably inducible — CPIC states that there does not appear to be any clinically ' +
      'relevant induction of CYP2D6 activity by any medication, and the FDA table lists no CYP2D6 inducers ' +
      'of any strength. Sertraline inhibits CYP2D6 weakly and dose-dependently; it is not in the FDA ' +
      'moderate-inhibitor list, so this engine applies no adjustment for it.',
    citationIds: ['fda-interaction-table', 'cpic-activity-score'],
  },
  {
    enzyme: 'CYP2C19',
    strongInhibitors: ['fluconazole', 'fluoxetine', 'fluvoxamine', 'ticlopidine'],
    moderateInhibitors: ['cenobamate', 'felbamate', 'voriconazole'],
    weakInhibitors: ['omeprazole', 'esomeprazole', 'cimetidine'],
    strongInducers: ['rifampin'],
    moderateInducers: ['apalutamide', 'efavirenz', 'enzalutamide', 'phenytoin'],
    note:
      'Proton pump inhibitors are frequently described as CYP2C19 inhibitors and are themselves CYP2C19 ' +
      'substrates, but omeprazole and esomeprazole are not in the FDA index list of moderate CYP2C19 ' +
      'inhibitors, so they are carried here as weak and produce no phenotype shift on their own.',
    citationIds: ['fda-interaction-table'],
  },
  {
    enzyme: 'CYP2B6',
    strongInhibitors: [],
    moderateInhibitors: [],
    weakInhibitors: ['clopidogrel', 'ticlopidine'],
    strongInducers: ['carbamazepine'],
    moderateInducers: ['efavirenz', 'rifampin'],
    note:
      'The FDA table lists no clinical index inhibitors of CYP2B6. Clopidogrel and ticlopidine are reported ' +
      'as CYP2B6 inhibitors in the literature but are not FDA-indexed, so they are recorded without applying ' +
      'a phenotype shift rather than being promoted on weaker evidence.',
    citationIds: ['fda-interaction-table'],
  },
  {
    /**
     * Not a CPIC-actionable antidepressant gene, so it never drives a dosing recommendation
     * here. It is carried because St John's Wort induction of CYP3A4 is a real, common and
     * citable interaction that belongs in the lifestyle layer.
     */
    enzyme: 'CYP3A4',
    strongInhibitors: ['clarithromycin', 'itraconazole', 'ketoconazole', 'nefazodone', 'ritonavir', 'voriconazole'],
    moderateInhibitors: ['aprepitant', 'ciprofloxacin', 'diltiazem', 'erythromycin', 'fluconazole', 'verapamil'],
    weakInhibitors: ['cimetidine'],
    strongInducers: ['carbamazepine', 'phenytoin', 'rifampin', "St John's Wort"],
    moderateInducers: ['efavirenz', 'phenobarbital', 'modafinil'],
    citationIds: ['fda-interaction-table'],
  },
  {
    enzyme: 'CYP1A2',
    strongInhibitors: ['fluvoxamine', 'ciprofloxacin'],
    moderateInhibitors: ['oral contraceptive', 'mexiletine'],
    weakInhibitors: [],
    strongInducers: [],
    moderateInducers: ['phenytoin', 'rifampin'],
    note:
      'Tobacco smoke is a clinically significant CYP1A2 inducer, but it is a behaviour rather than a ' +
      'medication, so it is handled in the lifestyle layer instead of here.',
    citationIds: ['fda-interaction-table'],
  },
]

/**
 * Multiplier applied to a genetic activity score.
 *
 * CPIC's operational rule, used verbatim in its own guidelines: for a strong inhibitor the
 * CYP2D6 activity score is adjusted to 0 and the predicted phenotype is poor metaboliser;
 * for a moderate inhibitor the score is multiplied by 0.5 and re-mapped. Weak inhibitors
 * get no adjustment, because the exposure change was judged not clinically actionable.
 */
export const EFFECT_MULTIPLIERS: Record<ModifierEffect, number> = {
  strong_inhibitor: 0,
  moderate_inhibitor: 0.5,
  weak_inhibitor: 1,
  moderate_inducer: 1,
  strong_inducer: 1.5,
}

export const EFFECT_LABELS: Record<ModifierEffect, string> = {
  strong_inhibitor: 'strong inhibitor',
  moderate_inhibitor: 'moderate inhibitor',
  weak_inhibitor: 'weak inhibitor',
  moderate_inducer: 'moderate inducer',
  strong_inducer: 'strong inducer',
}

/** Ranked worst-to-best so the engine can pick a single dominant modifier. */
const EFFECT_SEVERITY: ModifierEffect[] = [
  'strong_inhibitor',
  'moderate_inhibitor',
  'weak_inhibitor',
  'moderate_inducer',
  'strong_inducer',
]

export function severityRank(effect: ModifierEffect): number {
  return EFFECT_SEVERITY.indexOf(effect)
}

export function tableFor(enzyme: string): EnzymeModifierTable | undefined {
  return ENZYME_MODIFIERS.find((t) => t.enzyme === enzyme)
}

/** How does `drug` act on `enzyme`, if at all? */
export function effectOf(drug: string, enzyme: string): ModifierEffect | null {
  const table = tableFor(enzyme)
  if (!table) return null
  const d = drug.toLowerCase()
  const has = (list: string[]) => list.some((x) => x.toLowerCase() === d)

  if (has(table.strongInhibitors)) return 'strong_inhibitor'
  if (has(table.moderateInhibitors)) return 'moderate_inhibitor'
  if (has(table.strongInducers)) return 'strong_inducer'
  if (has(table.moderateInducers)) return 'moderate_inducer'
  if (has(table.weakInhibitors)) return 'weak_inhibitor'
  return null
}

/** Every enzyme this drug acts on, used for the interaction panel. */
export function effectsOfDrug(drug: string): Array<{ enzyme: string; effect: ModifierEffect }> {
  return ENZYME_MODIFIERS.map((t) => ({ enzyme: t.enzyme, effect: effectOf(drug, t.enzyme) }))
    .filter((e): e is { enzyme: string; effect: ModifierEffect } => e.effect !== null)
}
