/**
 * Mechanism-based support protocols.
 *
 * This is deliberately NOT the label layer. `lifestyle-rules.ts` carries what the printed
 * product information says — "morning dosing", "food is optional", "avoid alcohol". Those
 * are facts about the pill.
 *
 * This file answers a different question: what is this drug actually doing to your body,
 * and what should you eat or do to support yourself through it. The distinction matters
 * because the label tells someone on day four that nausea is a known adverse reaction,
 * which is useless. Knowing that most of the body's serotonin is in the gut, that this is
 * why week one feels like a stomach bug, and that it reliably settles by week three, is the
 * thing that stops them giving up.
 *
 * Evidence strength is carried per protocol and shown in the UI. Mechanistic inference is
 * labelled as mechanistic inference — plausible physiology is not dressed up as trial data.
 */

import source from './sources/support-protocols.json'

export type SupportPhase = 'first_weeks' | 'ongoing' | 'switching'

export type EvidenceStrength =
  | 'label'
  | 'guideline'
  | 'clinical_studies'
  | 'mechanistic_inference'

export interface SupportProtocol {
  id: string
  /** Lowercase generic names. */
  drugs: string[]
  phase: SupportPhase
  /** Plain-language statement of what the drug does to the body. The headline. */
  bodyEffect: string
  /** One sentence of physiology. This is what makes it feel explained, not arbitrary. */
  mechanism: string
  /** Concrete actions. Specific and doable. */
  doThis: string[]
  /** Foods that help, with the reason. */
  eatThis: string[]
  /** Only where there is a real mechanistic reason. */
  avoidThis: string[]
  /** When it starts, when it settles. */
  timeline: string
  evidenceStrength: EvidenceStrength
  /** Named source, or an explicit statement that this is mechanistic reasoning. */
  source: string
}

interface ProtocolSource {
  schemaVersion: number
  contentCurrentAsOf: string
  protocols: SupportProtocol[]
}

const snapshot = source as unknown as ProtocolSource

if (snapshot.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.contentCurrentAsOf)) {
  throw new Error('The support protocol set is not versioned.')
}

export const SUPPORT_PROTOCOLS: SupportProtocol[] = snapshot.protocols
export const SUPPORT_PROTOCOLS_CURRENT_AS_OF = snapshot.contentCurrentAsOf

export const EVIDENCE_LABEL: Record<EvidenceStrength, string> = {
  label: 'Product label',
  guideline: 'Clinical guideline',
  clinical_studies: 'Clinical studies',
  mechanistic_inference: 'Mechanism, not trial evidence',
}

export const PHASE_LABEL: Record<SupportPhase, string> = {
  first_weeks: 'The first few weeks',
  ongoing: 'Once you have settled',
  switching: 'Changing or stopping',
}

export function protocolsForDrug(drug: string): SupportProtocol[] {
  const needle = drug.trim().toLowerCase()
  if (!needle) return []
  return SUPPORT_PROTOCOLS.filter((protocol) =>
    protocol.drugs.some((name) => name.toLowerCase() === needle),
  )
}
