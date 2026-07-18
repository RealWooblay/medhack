import { describe, expect, it } from 'vitest'
import { DEFAULT_CARE_CONTEXT, scoreDepressionCheckIn } from '../depression'
import { buildProtocol } from '../lifestyle'
import { matchLifestyle } from '../lifestyle-fit'
import { PharmCATReportJsonAdapter } from '../pharmcat/adapter'
import type { CareContext } from '../types'

function care(overrides: Partial<CareContext['lifestyle']> = {}): CareContext {
  return {
    ...DEFAULT_CARE_CONTEXT,
    checkIn: {
      responses: [2, 2, 2, 2, 1, 1, 1, 0, 0],
      functionalImpact: 'very_difficult',
    },
    lifestyle: { ...DEFAULT_CARE_CONTEXT.lifestyle, ...overrides },
  }
}

describe('the depression journey baseline', () => {
  it('scores the PHQ-9 deterministically without turning it into a diagnosis', () => {
    const summary = scoreDepressionCheckIn(care())

    expect(summary.score).toBe(11)
    expect(summary.severity).toBe('moderate')
    expect(summary.interpretation.text).toMatch(/not a diagnosis/)
    expect(summary.interpretation.citationIds).toContain('phq9-validation')
  })

  it('raises the fixed safety flag for any positive item 9 response', () => {
    const input = care()
    input.checkIn.responses[8] = 1

    expect(scoreDepressionCheckIn(input).safetyResponsePositive).toBe(true)
  })
})

describe('daily-life matching', () => {
  it('keeps lifestyle compatibility separate and sourced', () => {
    const protocol = buildProtocol('escitalopram', [])
    const match = matchLifestyle(protocol, care({ dailySchedule: 'shift_work', drivingOrMachinery: true }))

    expect(match.facts.some((fact) => fact.title === 'The label allows morning or evening dosing')).toBe(true)
    expect(match.facts.some((fact) => fact.dimension === 'driving')).toBe(true)
    for (const fact of match.facts) expect(fact.citationIds.length).toBeGreaterThan(0)
    expect(match.unknowns.join(' ')).toMatch(/does not predict/)
  })

  it('surfaces the bupropion eating-disorder conflict for clinician review', () => {
    const protocol = buildProtocol('bupropion', [])
    const match = matchLifestyle(protocol, care({ eatingDisorderHistory: true }))

    expect(match.verdict).toBe('clinician_review')
    expect(match.facts.some((fact) => fact.dimension === 'medical_history')).toBe(true)
  })
})

describe('PharmCAT report JSON handoff', () => {
  it('preserves the real PharmCAT version and outside CYP2D6 provenance', async () => {
    const diplotype = (label: string, phenotype: string, activityScore: string | null = null) => ({
      label,
      phenotypes: [phenotype],
      activityScore,
    })
    const contents = JSON.stringify({
      title: 'test',
      timestamp: '2026-07-18T00:00:00Z',
      pharmcatVersion: 'v3.4.0',
      dataVersion: '2026-07-14',
      genes: {
        CYP2C19: { callSource: 'MATCHER', sourceDiplotypes: [diplotype('*1/*2', 'Intermediate Metabolizer')], recommendationDiplotypes: [diplotype('*1/*2', 'Intermediate Metabolizer')], variants: [{}, {}] },
        CYP2D6: { callSource: 'OUTSIDE', sourceDiplotypes: [diplotype('*1/*4', 'Intermediate Metabolizer', '1.0')], recommendationDiplotypes: [diplotype('*1/*4', 'Intermediate Metabolizer', '1.0')], variants: [] },
        CYP2B6: { callSource: 'MATCHER', sourceDiplotypes: [diplotype('*1/*1', 'Normal Metabolizer')], recommendationDiplotypes: [diplotype('*1/*1', 'Normal Metabolizer')], variants: [{}] },
      },
    })

    const report = await new PharmCATReportJsonAdapter().analyze({
      fileName: 'sample.report.json',
      contents,
      assayType: 'wgs',
    })

    expect(report.provenance).toBe('pharmcat-json')
    expect(report.pharmcatVersion).toContain('v3.4.0')
    const cyp2d6 = report.genes.find((gene) => gene.gene === 'CYP2D6')!
    expect(cyp2d6.diplotype).toBe('*1/*4')
    expect(cyp2d6.structuralVariationUnresolved).toBe(false)
    expect(cyp2d6.coverageScope).toBe('report-json-only')
    expect(cyp2d6.missingPositionLabels.join(' ')).toMatch(/coverage completeness is unknown/)
  })
})
