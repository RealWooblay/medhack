import { describe, expect, it } from 'vitest'
import {
  SUPPORT_PROTOCOLS,
  EVIDENCE_LABEL,
  PHASE_LABEL,
  protocolsForDrug,
} from '../../data/support-protocols'

describe('mechanism-based support protocols', () => {
  it('every protocol explains a body effect, a mechanism and something to do', () => {
    expect(SUPPORT_PROTOCOLS.length).toBeGreaterThan(20)
    for (const p of SUPPORT_PROTOCOLS) {
      expect(p.bodyEffect.length, p.id).toBeGreaterThan(20)
      expect(p.mechanism.length, p.id).toBeGreaterThan(20)
      expect(p.doThis.length, p.id).toBeGreaterThan(0)
      expect(p.drugs.length, p.id).toBeGreaterThan(0)
      expect(PHASE_LABEL[p.phase], p.id).toBeDefined()
      expect(EVIDENCE_LABEL[p.evidenceStrength], p.id).toBeDefined()
    }
  })

  it('every protocol names where it came from', () => {
    for (const p of SUPPORT_PROTOCOLS) {
      expect(p.source.length, `${p.id} must cite a source`).toBeGreaterThan(20)
    }
  })

  it('does not present mechanistic reasoning as trial evidence', () => {
    // The honesty property: anything claiming clinical_studies must name something
    // specific, not gesture at physiology.
    const studies = SUPPORT_PROTOCOLS.filter((p) => p.evidenceStrength === 'clinical_studies')
    expect(studies.length).toBeGreaterThan(0)
    for (const p of studies) {
      const namesSomething =
        // an accession, a study design, a sample size, or an author-year citation
        /PMC\d|PMID|trial|randomi|n\s*=\s*\d|meta-analys|cohort|polysomnograph|label/i.test(p.source) ||
        /[A-Z][a-z]+(?:\s*&\s*[A-Z][a-z]+)?,?\s+[A-Z][A-Za-z ]*\s+(?:19|20)\d{2}/.test(p.source)

      expect(namesSomething, `${p.id} claims clinical_studies but names no study`).toBe(true)
    }
  })

  it('covers the drugs the app actually recommends', () => {
    for (const drug of ['sertraline', 'fluoxetine', 'paroxetine', 'escitalopram', 'venlafaxine']) {
      expect(protocolsForDrug(drug).length, `no support content for ${drug}`).toBeGreaterThan(0)
    }
  })

  it('gives someone starting out something to read on day one', () => {
    const first = protocolsForDrug('sertraline').filter((p) => p.phase === 'first_weeks')
    expect(first.length).toBeGreaterThan(0)
    expect(first.some((p) => p.timeline.length > 10)).toBe(true)
  })
})
