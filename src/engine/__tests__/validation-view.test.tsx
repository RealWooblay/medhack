import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { runAnalysis } from '../pipeline'
import { TagSnpAdapter } from '../pharmcat/adapter'
import { FIXTURES, fixtureToFileText } from '../pharmcat/fixtures'
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
  const fixture = FIXTURES[0]
  return runAnalysis({
    adapter: new TagSnpAdapter(),
    genome: {
      fileName: fixture.fileName,
      contents: fixtureToFileText(fixture),
      assayType: fixture.assayType,
    },
    input: {
      genomeFileName: fixture.fileName,
      assayType: fixture.assayType,
      currentMedications: fixture.suggestedMedications,
      pastTrials: fixture.suggestedTrials,
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
    expect(markup).toContain('Add DNA results')
    expect(markup).toContain('Raw DNA stays on this device and never goes to the medical AI')
    expect(markup).not.toContain('Report sections')
    expect(markup).not.toContain('Sample journey')
    expect(markup).not.toContain('PHQ-9')
    expect(markup).not.toContain('preferred')
    expect(markup).not.toContain('shortlist')
  })

  it('runs fictional input through the actual reduced file parser', async () => {
    const result = await validationResult()

    expect(result.pharmcat.provenance).toBe('reduced-tagsnp')
    expect(result.pharmcat.reportId).toMatch(/^tagsnp-/)
    expect(result.pharmcat.pharmcatVersion).toMatch(/not PharmCAT/i)
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

    expectKnown(result.depression.interpretation.citationIds)
    expectKnown(result.depression.monitoringNote.citationIds)
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
    expect(result.narrative.renderedRejectionCount).toBe(0)
    expect(result.narrative.probeRejectionCount).toBeGreaterThan(0)
  })
})
