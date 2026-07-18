/**
 * CYP modifier data used for conservative phenoconversion checks.
 *
 * The lists are generated from the complete CYP2D6/CYP2C19/CYP2B6 inhibitor and inducer
 * columns of a dated FDA table snapshot. They are not hand-maintained drug lists. The FDA
 * describes its own table as examples rather than an exhaustive interaction database, so a
 * missing drug is always "no classification in this source", never "no interaction".
 */

import source from './sources/fda-cyp-modifiers.json'
import type { ModifierEffect } from '../engine/types'

type SourceEffect = ModifierEffect | 'weak_inducer'

interface SourceModifier {
  drug: string
  effects: Array<{ gene: string; effect: SourceEffect }>
}

interface ModifierSource {
  schemaVersion: number
  authority: string
  title: string
  sourceUrl: string
  contentCurrentAsOf: string
  scope: string[]
  completeness: string
  modifiers: SourceModifier[]
  sourceDigestSha256: string
}

const snapshot = source as unknown as ModifierSource

if (
  snapshot.schemaVersion !== 1 ||
  !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.contentCurrentAsOf) ||
  !/^[0-9a-f]{64}$/i.test(snapshot.sourceDigestSha256)
) {
  throw new Error('The FDA CYP modifier snapshot is not versioned or integrity-labelled.')
}

export const FDA_CYP_SOURCE = {
  authority: snapshot.authority,
  title: snapshot.title,
  sourceUrl: snapshot.sourceUrl,
  contentCurrentAsOf: snapshot.contentCurrentAsOf,
  completeness: snapshot.completeness,
  sourceDigestSha256: snapshot.sourceDigestSha256,
} as const

export interface EnzymeModifierTable {
  enzyme: string
  strongInhibitors: string[]
  moderateInhibitors: string[]
  weakInhibitors: string[]
  strongInducers: string[]
  moderateInducers: string[]
  /** Retained for source completeness; no phenotype operation is applied. */
  weakInducers: string[]
  note: string
  citationIds: string[]
}

function names(gene: string, effect: SourceEffect): string[] {
  return snapshot.modifiers
    .filter((row) => row.effects.some((item) => item.gene === gene && item.effect === effect))
    .map((row) => row.drug)
    .sort((a, b) => a.localeCompare(b))
}

function table(gene: string, note: string): EnzymeModifierTable {
  return {
    enzyme: gene,
    strongInhibitors: names(gene, 'strong_inhibitor'),
    moderateInhibitors: names(gene, 'moderate_inhibitor'),
    weakInhibitors: names(gene, 'weak_inhibitor'),
    strongInducers: names(gene, 'strong_inducer'),
    moderateInducers: names(gene, 'moderate_inducer'),
    weakInducers: names(gene, 'weak_inducer'),
    note,
    citationIds: ['fda-interaction-table'],
  }
}

export const ENZYME_MODIFIERS: EnzymeModifierTable[] = [
  table(
    'CYP2D6',
    'The dated FDA source contains no CYP2D6 inducer examples. Weak inhibitors are recorded but do not produce a modeled phenotype.',
  ),
  table(
    'CYP2C19',
    'No numeric or categorical CYP2C19 phenoconversion rule is applied. Classified modifiers are shown as unresolved context only.',
  ),
  table(
    'CYP2B6',
    'No numeric or categorical CYP2B6 phenoconversion rule is applied. Classified modifiers are shown as unresolved context only.',
  ),
]

/**
 * Research-convention factors for CYP2D6 only. The result is an explicitly uncertain
 * estimate and never replaces the imported PharmCAT phenotype or recommendation.
 */
export const EFFECT_MULTIPLIERS: Record<ModifierEffect, number> = {
  strong_inhibitor: 0,
  moderate_inhibitor: 0.5,
  weak_inhibitor: 1,
  moderate_inducer: 1,
  strong_inducer: 1,
}

export const EFFECT_LABELS: Record<ModifierEffect, string> = {
  strong_inhibitor: 'strong inhibitor',
  moderate_inhibitor: 'moderate inhibitor',
  weak_inhibitor: 'weak inhibitor',
  moderate_inducer: 'moderate inducer',
  strong_inducer: 'strong inducer',
}

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
  return ENZYME_MODIFIERS.find((entry) => entry.enzyme === enzyme)
}

/** FDA classification for this drug/enzyme in the pinned snapshot, if represented. */
export function effectOf(drug: string, enzyme: string): ModifierEffect | null {
  const entry = tableFor(enzyme)
  if (!entry) return null
  const value = drug.trim().toLowerCase()
  const has = (list: string[]) => list.some((candidate) => candidate.toLowerCase() === value)

  if (has(entry.strongInhibitors)) return 'strong_inhibitor'
  if (has(entry.moderateInhibitors)) return 'moderate_inhibitor'
  if (has(entry.strongInducers)) return 'strong_inducer'
  if (has(entry.moderateInducers)) return 'moderate_inducer'
  if (has(entry.weakInhibitors)) return 'weak_inhibitor'
  return null
}
