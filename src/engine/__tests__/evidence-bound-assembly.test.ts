import { describe, expect, it } from 'vitest'
import { reconstructTrials } from '../history'
import { assembleDrugFindings } from '../ranking'
import type { PharmCATDrugRecommendation } from '../types'

function recommendation(
  drug: string,
  action: PharmCATDrugRecommendation['action'] = 'decrease_start',
  citationIds: string[] = ['cpic-2016-tca'],
): PharmCATDrugRecommendation {
  return {
    drug,
    geneResults: [{ gene: 'CYP2D6', phenotype: 'Intermediate Metabolizer' }],
    gene: 'CYP2D6',
    phenotype: 'Intermediate Metabolizer',
    action,
    text: 'Imported guideline text.',
    population: null,
    dosingInformation: true,
    alternateDrugAvailable: false,
    otherPrescribingGuidance: false,
    source: 'CPIC',
    citationIds,
  }
}

describe('evidence-bound medicine assembly', () => {
  it('does not create a fixed antidepressant list when the upload contains no rows', () => {
    expect(assembleDrugFindings({
      genes: [],
      recommendations: [],
      currentMedications: [],
      history: [],
    })).toEqual([])
  })

  it('adds only recognised antidepressants from current medication input', () => {
    const rows = assembleDrugFindings({
      genes: [],
      recommendations: [],
      currentMedications: ['Zoloft', 'omeprazole'],
      history: [],
    })
    expect(rows.map((row) => row.drug)).toEqual(['sertraline'])
    expect(rows[0].geneFindings).toEqual([])
    expect(rows[0].reason).toBe('no matched PharmCAT guidance')
  })

  it('uses an exact imported annotation for a TCA absent from static profiles', () => {
    const rows = assembleDrugFindings({
      genes: [],
      recommendations: [recommendation('clomipramine')],
      currentMedications: [],
      history: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ drug: 'clomipramine', drugClass: 'TCA' })
    expect(rows[0].geneFindings[0].citationIds).toEqual(['cpic-2016-tca'])
  })
})

describe('evidence-bound treatment history', () => {
  it('uses the exact TCA source and does not substitute the SRI guideline', () => {
    const history = reconstructTrials(
      [{ drug: 'amitriptyline', outcome: 'side_effects' }],
      [],
      [recommendation('amitriptyline')],
    )
    expect(history[0].mechanism?.citationIds).toEqual(['cpic-2016-tca'])
    expect(history[0].mechanism?.citationIds).not.toContain('cpic-2023-sri')
    expect(history[0].patientSummary).toMatch(/cannot show what caused/i)
  })

  it('does not infer a genetic explanation without an actionable matched annotation', () => {
    const noMatch = reconstructTrials(
      [{ drug: 'fluoxetine', outcome: 'no_effect' }],
      [],
      [],
    )
    const standard = reconstructTrials(
      [{ drug: 'sertraline', outcome: 'helped' }],
      [],
      [recommendation('sertraline', 'standard', ['cpic-2023-sri'])],
    )
    expect(noMatch[0]).toMatchObject({ explanation: 'not_explained_by_genetics', mechanism: null })
    expect(standard[0]).toMatchObject({ explanation: 'not_explained_by_genetics', mechanism: null })
  })
})
