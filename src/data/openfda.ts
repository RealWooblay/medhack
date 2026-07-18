/**
 * openFDA drug label excerpts.
 *
 * Captured from `api.fda.gov/drug/label.json` and stored under `sources/` rather than
 * fetched at runtime, for two reasons: a demo should not fail because a public API is rate
 * limiting, and a citation should point at the exact text that was read when the rule was
 * written, not at whatever the endpoint returns today.
 *
 * Every excerpt registers its own citation, section by section, so a rule can cite
 * "FDA label §2 Dosage and Administration" for sertraline specifically rather than
 * gesturing at a class.
 */

import ssri from './sources/openfda-ssri.json'
import snri from './sources/openfda-snri-atypical.json'
import protocolDrugs from './sources/openfda-protocol-drugs.json'
import { registerLabelCitation } from './citations'

export interface LabelExcerpts {
  generic: string
  brands: string[]
  fetched: boolean
  sourceUrl: string
  dosage_and_administration?: string
  drug_interactions?: string
  warnings_and_cautions?: string
  food_effect?: string
  common_adverse_reactions?: string
  boxed_warning?: string
}

export type LabelSection = Exclude<keyof LabelExcerpts, 'generic' | 'brands' | 'fetched' | 'sourceUrl'>

const SECTION_LABEL: Record<LabelSection, string> = {
  dosage_and_administration: '§2 Dosage and Administration',
  drug_interactions: '§7 Drug Interactions',
  warnings_and_cautions: '§5 Warnings and Precautions',
  food_effect: '§12.3 Clinical Pharmacology',
  common_adverse_reactions: '§6 Adverse Reactions',
  boxed_warning: 'Boxed Warning',
}

const ALL_SECTIONS = Object.keys(SECTION_LABEL) as LabelSection[]

const raw: LabelExcerpts[] = [
  ...(ssri.drugs as LabelExcerpts[]),
  ...(snri.drugs as LabelExcerpts[]),
  ...(protocolDrugs.drugs as LabelExcerpts[]),
]

export const LABELS: Record<string, LabelExcerpts> = {}

for (const label of raw) {
  if (!label.fetched) continue
  const key = label.generic.toLowerCase()
  LABELS[key] = label

  for (const section of ALL_SECTIONS) {
    const text = label[section]
    if (!text) continue
    registerLabelCitation({
      id: labelCitationId(label.generic, section),
      label: `FDA label ${SECTION_LABEL[section]}`,
      kind: 'fda-label',
      title: `US prescribing information for ${label.generic} — ${SECTION_LABEL[section]}: "${text.trim()}"`,
      url: label.sourceUrl,
      section: SECTION_LABEL[section],
    })
  }
}

export function labelCitationId(generic: string, section: LabelSection): string {
  return `fda-label-${generic.toLowerCase().replace(/\s+/g, '-')}-${section.replace(/_/g, '-')}`
}

export function labelFor(generic: string): LabelExcerpts | undefined {
  return LABELS[generic.toLowerCase()]
}

/** True when we actually captured that section, so a rule can avoid citing a gap. */
export function hasLabelSection(generic: string, section: LabelSection): boolean {
  return Boolean(labelFor(generic)?.[section])
}

/**
 * Cite a label section only if it was actually captured. Returns an empty array otherwise,
 * which causes the rule carrying it to fall back to its other sources rather than render a
 * badge that points at nothing.
 */
export function citeLabel(generic: string, section: LabelSection): string[] {
  return hasLabelSection(generic, section) ? [labelCitationId(generic, section)] : []
}
