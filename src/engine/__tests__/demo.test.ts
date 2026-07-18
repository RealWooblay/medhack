import { describe, expect, it } from 'vitest'
import { CITATIONS } from '../../data/citations'
import {
  CAPTURED_EXAMPLE_ASSAY,
  CapturedPharmCATExampleAdapter,
} from '../pharmcat/fixtures'
import { runAnalysis } from '../pipeline'
import type { AnalysisResult } from '../types'

async function runCaptured(currentMedications: string[] = ['fluoxetine']): Promise<AnalysisResult> {
  return runAnalysis({
    adapter: new CapturedPharmCATExampleAdapter(),
    genome: {
      fileName: 'pharmcat.example.report.json',
      assayType: CAPTURED_EXAMPLE_ASSAY,
    },
    input: {
      genomeFileName: 'pharmcat.example.report.json',
      assayType: CAPTURED_EXAMPLE_ASSAY,
      currentMedications,
      pastTrials: [],
    },
  })
}

describe('real PharmCAT example flow', () => {
  it('keeps every unasked routine and safety field unknown', async () => {
    const result = await runCaptured([])

    expect(result.care.lifestyle).toEqual({})
    expect(result.care.needsImmediateSupport).toBeNull()
    for (const match of Object.values(result.lifestyleMatches)) {
      expect(match.verdict).toBe('unknown')
      expect(match.facts).toEqual([])
    }
  })

  it('preserves official software, data and genotype provenance', async () => {
    const result = await runCaptured([])
    expect(result.pharmcat).toMatchObject({
      provenance: 'pharmcat-json',
      pharmcatVersion: 'v3.3.0-8-g8ff5870f',
      pharmcatDataVersion: '2026-07-13-11-40',
      reportTimestamp: '2026-07-13T22:32:26.437Z',
    })
    expect(result.genes.find((gene) => gene.gene === 'CYP2C19')).toMatchObject({
      diplotype: '*38/*38',
      geneticPhenotype: 'Normal Metabolizer',
    })
    expect(result.genes.find((gene) => gene.gene === 'CYP2D6')).toMatchObject({
      diplotype: '*1/*3',
      geneticPhenotype: 'Intermediate Metabolizer',
      geneticActivityScore: 1,
    })
  })

  it('does not pretend Reporter JSON proves coverage or CYP2D6 structural calling', async () => {
    const result = await runCaptured([])
    const rawD6 = result.pharmcat.genes.find((gene) => gene.gene === 'CYP2D6')!
    const d6 = result.genes.find((gene) => gene.gene === 'CYP2D6')!
    expect(rawD6.positionsMissing).toBeNull()
    expect(rawD6.structuralVariationUnresolved).toBe(true)
    expect(d6.confidence.level).toBe('low')
    expect(d6.confidence.reasons.map((reason) => reason.text).join(' ')).toMatch(/structural variation.*unresolved/i)
  })

  it('keeps the current-medicine calculation separate from PharmCAT guidance', async () => {
    const result = await runCaptured(['fluoxetine'])
    const d6 = result.genes.find((gene) => gene.gene === 'CYP2D6')!
    const reportParoxetine = result.pharmcat.recommendations.find((item) => item.drug === 'paroxetine')!
    const shownParoxetine = result.shortlist.find((item) => item.drug === 'paroxetine')!

    expect(d6.geneticPhenotype).toBe('Intermediate Metabolizer')
    expect(d6.functionalPhenotype).toBe('Intermediate Metabolizer')
    expect(d6.modeledFunctionalPhenotype).toBe('Poor Metabolizer')
    expect(d6.converted).toBe(false)
    expect(reportParoxetine.phenotype).toBe('Intermediate Metabolizer')
    expect(reportParoxetine.action).toBe('decrease_start')
    expect(shownParoxetine.geneFindings[0]).toMatchObject({
      phenotypeUsed: 'Intermediate Metabolizer',
      usedFunctionalPhenotype: false,
      action: 'decrease_start',
    })
    expect(shownParoxetine.interactionFlags[0].text).toMatch(/prescriber must reconcile/i)
  })

  it('uses PharmCAT combined annotations for sertraline and amitriptyline', async () => {
    const result = await runCaptured([])
    const sertraline = result.shortlist.find((drug) => drug.drug === 'sertraline')!
    const amitriptyline = result.shortlist.find((drug) => drug.drug === 'amitriptyline')!

    expect(sertraline.geneFindings[0].geneResults).toEqual([
      { gene: 'CYP2B6', phenotype: 'Normal Metabolizer' },
      { gene: 'CYP2C19', phenotype: 'Normal Metabolizer' },
    ])
    expect(amitriptyline.geneFindings[0].geneResults.map((item) => item.gene)).toEqual([
      'CYP2C19',
      'CYP2D6',
    ])
    expect(amitriptyline.geneFindings[0].guidelineText).toMatch(/25% reduction/)
  })

  it('does not turn a PharmCAT no-recommendation annotation into standard dosing', async () => {
    const result = await runCaptured([])
    const venlafaxine = result.shortlist.find((drug) => drug.drug === 'venlafaxine')!
    expect(venlafaxine.geneFindings[0].action).toBe('no_recommendation')
    expect(venlafaxine.pgxCategory).toBe('no_gene_based_guidance')
  })

  it('keeps candidate rows alphabetical and never creates an efficacy rank', async () => {
    const result = await runCaptured([])
    const names = result.shortlist.map((drug) => drug.drug)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(JSON.stringify(result.shortlist)).not.toMatch(/likely to work|best medicine|most effective/i)
  })

  it('keeps every displayed clinical fact linked to a resolvable source', async () => {
    const result = await runCaptured([])
    for (const drug of result.shortlist) {
      for (const finding of drug.geneFindings) {
        expect(finding.citationIds.length).toBeGreaterThan(0)
        finding.citationIds.forEach((id) => expect(CITATIONS[id]).toBeDefined())
      }
    }
    for (const protocol of Object.values(result.protocolsByDrug)) {
      for (const item of [...protocol.items, ...protocol.interactionItems]) {
        expect(item.citationIds.length).toBeGreaterThan(0)
        item.citationIds.forEach((id) => expect(CITATIONS[id]).toBeDefined())
      }
    }
  })
})
