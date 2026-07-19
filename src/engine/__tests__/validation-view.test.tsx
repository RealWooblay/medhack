import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '../../App'
import { currentMedicinesResolved, exactDoseSentence } from '../../ui/ValidationConsole'
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
  it('renders the explicit product flow', () => {
    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('DNA')
    expect(markup).toContain('Gene results')
    expect(markup).toContain('Medicines')
    expect(markup).toContain('Daily life')
    expect(markup).toContain('AI review')
    expect(markup).toContain('Sources')
    expect(markup).toContain('Current medicines and supplements')
    expect(markup).toContain('I take none')
    // The switcher offers the modes you are not currently in; example mode is the default.
    expect(markup).toContain('Other ways to start')
    expect(markup).toContain('Import PharmCAT report')
    expect(markup).not.toContain('Report sections')
    expect(markup).not.toContain('Sample journey')
    expect(markup).not.toContain('PHQ-9')
    expect(markup).not.toContain('preferred')
    expect(markup).not.toContain('shortlist')
  })

  it('opens on a mode that works without a deployed backend', () => {
    // Genome upload needs the private worker. Defaulting to it meant a new visitor's first
    // action failed against any deployment without the full backend.
    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('Use a published example')
    expect(markup).toContain('Published report')
    // The genome route stays reachable from the mode switcher, just not as the landing state.
    expect(markup).toContain('Upload your DNA')
  })

  it('always shows the safety notice and crisis contacts', () => {
    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('not medical advice')
    expect(markup).toContain('Lifeline')
    expect(markup).toContain('13 11 14')
  })

  it('requires medicines or an explicit confirmation of none', () => {
    expect(currentMedicinesResolved('', false)).toBe(false)
    expect(currentMedicinesResolved('', true)).toBe(true)
    expect(currentMedicinesResolved('fluoxetine, ibuprofen', false)).toBe(true)
    expect(currentMedicinesResolved('fluoxetine', true)).toBe(false)
    expect(currentMedicinesResolved('not-a-real-medicine', false)).toBe(false)
  })

  it('runs only the captured official PharmCAT report through the real parser', async () => {
    const result = await validationResult()

    expect(result.pharmcat.provenance).toBe('pharmcat-json')
    expect(result.pharmcat.reportId).toMatch(/^pharmcat-/)
    expect(result.pharmcat.pharmcatVersion).toBe('v3.3.0-8-g8ff5870f')
    expect(result.genes).toHaveLength(3)
    expect(result.pharmcat.genes.find((gene) => gene.gene === 'CYP2D6')?.structuralVariationUnresolved).toBe(true)
  })

  it('surfaces exact quantitative dose wording when PharmCAT supplies it', async () => {
    const result = await validationResult()
    const amitriptyline = result.shortlist.find((drug) => drug.drug === 'amitriptyline')!

    expect(exactDoseSentence(amitriptyline)).toBe('Consider a 25% reduction of recommended starting dose.')
  })

  it('does not headline a lower-priority percentage when another rule says avoid', async () => {
    const result = await validationResult()
    const amitriptyline = result.shortlist.find((drug) => drug.drug === 'amitriptyline')!
    const avoidFinding = {
      ...amitriptyline.geneFindings[0],
      action: 'avoid' as const,
      guidelineText: 'Avoid this medicine for this phenotype.',
    }

    expect(exactDoseSentence({
      ...amitriptyline,
      headline: 'avoid',
      pgxCategory: 'alternative_discussion',
      geneFindings: [...amitriptyline.geneFindings, avoidFinding],
    })).toBeNull()
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
      const medicationSources = sourceIdsForMedication(drug)
      const hasSourceBoundClaim =
        drug.geneFindings.length > 0 ||
        drug.interactionFlags.length > 0 ||
        drug.confidenceCaveats.length > 0 ||
        drug.enzymeIndependence.length > 0 ||
        drug.retryRationale !== null
      if (hasSourceBoundClaim) expectKnown(medicationSources)
      else expect(medicationSources).toEqual([])
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

  it('passes all deterministic software-lineage checks', async () => {
    const result = await validationResult()
    const checks = buildValidationChecks(result)

    expect(checks.length).toBeGreaterThan(0)
    expect(checks.every((check) => check.passed)).toBe(true)
  })
})
