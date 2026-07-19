/**
 * RESEARCH ONLY — not imported by the validation application.
 *
 * These draft mechanism-based support records are deliberately separate from the governed
 * product-label layer in `lifestyle-rules.ts`. Their prose sources are not yet claim-level
 * citations with versioned URLs, exact anchors and digests, so they cannot drive clinical UI.
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
