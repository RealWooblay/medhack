/**
 * Phenoconversion reference data — extension 1, the technical centrepiece.
 *
 * Classifications are taken from the FDA healthcare-professional examples table. Absence
 * from that non-exhaustive table is kept distinct from evidence of no interaction.
 *
 * Two classifications here are worth reading twice, because they are the reason the demo
 * patient's result looks the way it does:
 *
 *  - The captured table classifies fluoxetine as a strong inhibitor of CYP2D6 and CYP2C19.
 *    This engine may show the CYP2D6 research-convention estimate with uncertainty. CYP2C19
 *    is flagged as unresolved; neither result replaces the imported PharmCAT guidance.
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
    weakInhibitors: ['amiodarone', 'celecoxib', 'cimetidine', 'escitalopram', 'sertraline'],
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
    weakInhibitors: ['omeprazole'],
    strongInducers: ['rifampin'],
    moderateInducers: ['apalutamide', 'efavirenz', 'enzalutamide', 'phenytoin'],
    note:
      'The FDA table lists omeprazole as a weak CYP2C19 inhibitor. Esomeprazole is absent from the ' +
      'captured table and is not inferred here.',
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
      'The FDA table lists no strong or moderate CYP2B6 inhibitors. It lists clopidogrel and ticlopidine ' +
      'as weak inhibitors, so this build records them without applying a phenotype estimate.',
    citationIds: ['fda-interaction-table'],
  },
  {
    /**
     * Not a CPIC-actionable antidepressant gene, so it never drives a dosing recommendation
     * here. It is carried because St John's Wort induction of CYP3A4 is a real, common and
     * citable interaction that belongs in the lifestyle layer. FDA reports the combined
     * CYP3A pathway rather than CYP3A4 and CYP3A5 separately.
     */
    enzyme: 'CYP3A',
    strongInhibitors: ['clarithromycin', 'itraconazole', 'ketoconazole', 'nefazodone', 'ritonavir', 'voriconazole'],
    moderateInhibitors: ['aprepitant', 'ciprofloxacin', 'diltiazem', 'erythromycin', 'fluconazole', 'verapamil'],
    weakInhibitors: ['cimetidine'],
    strongInducers: ['carbamazepine', 'phenytoin', 'rifampin', "St John's Wort"],
    moderateInducers: ['efavirenz', 'phenobarbital'],
    citationIds: ['fda-interaction-table'],
  },
  {
    enzyme: 'CYP1A2',
    strongInhibitors: ['fluvoxamine'],
    moderateInhibitors: ['ciprofloxacin', 'oral contraceptive', 'mexiletine'],
    weakInhibitors: [],
    strongInducers: [],
    moderateInducers: ['phenytoin', 'rifampin'],
    note:
      'Ciprofloxacin is classified as moderate in the FDA table, with a note that it can behave as a strong ' +
      'inhibitor for highly sensitive substrates. Tobacco smoke is a clinically significant CYP1A2 inducer, but it is a behaviour rather than a ' +
      'medication, so it is handled in the lifestyle layer instead of here.',
    citationIds: ['fda-interaction-table'],
  },
]

/**
 * Multiplier applied to a genetic activity score.
 *
 * Research convention described in the CPIC antidepressant supplement: a strong inhibitor
 * is modeled with CYP2D6 activity score 0 and a moderate inhibitor with score x 0.5. The
 * result is an uncertain estimate in this build, not a validated prescribing phenotype.
 */
export const EFFECT_MULTIPLIERS: Record<ModifierEffect, number> = {
  strong_inhibitor: 0,
  moderate_inhibitor: 0.5,
  weak_inhibitor: 1,
  moderate_inducer: 1,
  // No numeric inducer conversion is claimed; these values are never used as estimates.
  strong_inducer: 1,
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
  'strong_inducer',
  'moderate_inhibitor',
  'moderate_inducer',
  'weak_inhibitor',
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
