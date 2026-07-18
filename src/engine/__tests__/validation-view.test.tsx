import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { runAnalysis } from '../pipeline'
import {
  CAPTURED_EXAMPLE_ASSAY,
  CapturedPharmCATExampleAdapter,
} from '../pharmcat/fixtures'
import type { CareContext } from '../types'
import {
  buildValidationChecks,
  sourceIdsForGene,
  sourceIdsForMedication,
} from '../../validation/view-model'

const care: CareContext = {
  checkIn: {
    responses: [2, 2, 2, 2, 1, 1, 1, 0, 0],
    functionalImpact: 'very_difficult',
  },
  goals: ['feel_more_like_myself', 'restore_energy', 'reduce_side_effects'],
  lifestyle: {
    sleep: 'trouble_sleeping',
    mealRoutine: 'variable',
    dailySchedule: 'regular',
    alcohol: 'occasional',
    drivingOrMachinery: true,
    missedDoses: 'sometimes',
    eatingDisorderHistory: false,
  },
  needsImmediateSupport: false,
}

async function validationResult() {
  return runAnalysis({
    adapter: new CapturedPharmCATExampleAdapter(),
    genome: {
      fileName: 'pharmcat.example.report.json',
      assayType: CAPTURED_EXAMPLE_ASSAY,
    },
    input: {
      genomeFileName: 'pharmcat.example.report.json',
      assayType: CAPTURED_EXAMPLE_ASSAY,
      currentMedications: ['fluoxetine'],
      pastTrials: [],
      careContext: care,
    },
  })
}

describe('simplified validation surface', () => {
  it('renders the explicit six-part validation flow', () => {
    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('File')
    expect(markup).toContain('Genes')
    expect(markup).toContain('Medicines')
    expect(markup).toContain('Daily life')
    expect(markup).toContain('AI review')
    expect(markup).toContain('Evidence')
    expect(markup).toContain('Start with a result')
    expect(markup).toContain('Official example')
    expect(markup).not.toContain('Report sections')
    expect(markup).not.toContain('Sample journey')
    expect(markup).not.toContain('PHQ-9')
    expect(markup).not.toContain('preferred')
    expect(markup).not.toContain('shortlist')
  })

  it('runs only the captured official PharmCAT report through the real parser', async () => {
    const result = await validationResult()

    expect(result.pharmcat.provenance).toBe('pharmcat-json')
    expect(result.pharmcat.reportId).toMatch(/^pharmcat-/)
    expect(result.pharmcat.pharmcatVersion).toBe('v3.3.0-8-g8ff5870f')
    expect(result.genes).toHaveLength(3)
    expect(result.pharmcat.genes.find((gene) => gene.gene === 'CYP2D6')?.structuralVariationUnresolved).toBe(true)
  })

  it('resolves source records across every clinical output lane', async () => {
    const result = await validationResult()
    const known = new Set(Object.keys(result.citations))
    const expectKnown = (ids: string[]) => {
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect(known.has(id), `missing source ${id}`).toBe(true)
    }

    if (result.depression) {
      expectKnown(result.depression.interpretation.citationIds)
      expectKnown(result.depression.monitoringNote.citationIds)
    }
    result.genes.forEach((gene) => expectKnown(sourceIdsForGene(gene)))
    result.excludedGenes.forEach((gene) => expectKnown(gene.rationale.citationIds))
    result.shortlist.forEach((drug) => {
      expectKnown(sourceIdsForMedication(drug))
      drug.geneFindings.forEach((finding) => expectKnown(finding.citationIds))
      drug.interactionFlags.forEach((flag) => expectKnown(flag.citationIds))
      drug.confidenceCaveats.forEach((claim) => expectKnown(claim.citationIds))
    })
    result.history.forEach((trial) => {
      if (trial.mechanism) expectKnown(trial.mechanism.citationIds)
      trial.supporting.forEach((claim) => expectKnown(claim.citationIds))
    })
    Object.values(result.protocolsByDrug).forEach((protocol) => {
      protocol.items.forEach((item) => expectKnown(item.citationIds))
      protocol.interactionItems.forEach((item) => expectKnown(item.citationIds))
    })
    Object.values(result.lifestyleMatches).forEach((match) => {
      match.facts.forEach((fact) => expectKnown(fact.citationIds))
    })
    result.pharmcat.recommendations.forEach((recommendation) => expectKnown(recommendation.citationIds))
  })

  it('passes all software lineage checks with live AI disabled', async () => {
    const result = await validationResult()
    const checks = buildValidationChecks(result)

    expect(checks.length).toBeGreaterThan(0)
    expect(checks.every((check) => check.passed)).toBe(true)
    expect(result.narrative.generator).toBe('deterministic-template')
    expect(result.narrative.rejections).toEqual([])
  })
})
