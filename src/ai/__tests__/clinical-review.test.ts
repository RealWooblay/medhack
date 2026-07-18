import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureById, FixturePharmCATAdapter } from '../../engine/pharmcat/fixtures'
import { runAnalysis } from '../../engine/pipeline'
import type { AnalysisResult, PatientInput } from '../../engine/types'
import {
  buildClinicalReviewContext,
  createClinicalReviewProvider,
  MedGemmaClinicalReviewProvider,
  NotConnectedClinicalReviewProvider,
  validateClinicalReviewOutput,
} from '../clinical-review'

async function runPrivateFixture(): Promise<AnalysisResult> {
  const fixture = fixtureById('demo-phenoconversion')!
  const input: PatientInput = {
    genomeFileName: 'Jane-Doe-direct-identifier-raw-genome.txt',
    assayType: fixture.assayType,
    currentMedications: fixture.suggestedMedications,
    pastTrials: [
      {
        drug: 'paroxetine',
        outcome: 'side_effects',
        note: 'DIRECT_IDENTIFIER_JANE private free-text history',
      },
    ],
  }
  return runAnalysis({
    adapter: new FixturePharmCATAdapter(fixture),
    genome: { fileName: input.genomeFileName, assayType: input.assayType },
    input,
  })
}

describe('privacy-minimised clinical review context', () => {
  let result: AnalysisResult

  beforeAll(async () => {
    result = await runPrivateFixture()
  })

  it('keeps raw genome metadata, direct identifiers and granular genetic data out of the payload', () => {
    const context = buildClinicalReviewContext(result, { selectedDrug: 'sertraline' })
    const serialised = JSON.stringify(context)

    expect(context.privacy).toBe('derived-clinical-facts-only')
    expect(serialised).not.toContain('Jane-Doe')
    expect(serialised).not.toContain('DIRECT_IDENTIFIER_JANE')
    expect(serialised).not.toContain('genomeFileName')
    expect(serialised).not.toContain('reportId')
    expect(serialised).not.toContain('diplotype')
    expect(serialised).not.toContain('activityScore')
    expect(serialised).not.toContain('missingPosition')
    expect(serialised).not.toMatch(/rs\d+/i)
    expect(serialised).toContain('Poor Metabolizer')
    expect(context.selectedDrug).toBe('sertraline')
    expect(context.facts.some((fact) => fact.domain === 'lifestyle_requirement')).toBe(true)
  })

  it('sends only confirmed lifestyle dimensions and recomputes their selected-drug match', () => {
    const withoutAnswers = buildClinicalReviewContext(result, { selectedDrug: 'mirtazapine' })
    expect(withoutAnswers.facts.some((fact) => fact.id === 'LIFESTYLE-CONTEXT:sleep')).toBe(false)
    expect(withoutAnswers.facts.some((fact) => fact.id === 'LIFESTYLE-CONTEXT:mealRoutine')).toBe(false)
    expect(withoutAnswers.facts.some((fact) => fact.id === 'LIFESTYLE-CONTEXT:NOT-CONFIRMED')).toBe(true)
    expect(withoutAnswers.facts.some((fact) => fact.id === 'SYMPTOM-CONTEXT')).toBe(false)

    const confirmed = buildClinicalReviewContext(result, {
      selectedDrug: 'mirtazapine',
      confirmedLifestyle: { sleep: 'sleeping_too_much' },
      includeSymptomContext: true,
    })
    expect(confirmed.facts.some((fact) => fact.id === 'LIFESTYLE-CONTEXT:sleep')).toBe(true)
    expect(confirmed.facts.some((fact) => fact.id === 'LIFESTYLE-CONTEXT:mealRoutine')).toBe(false)
    expect(
      confirmed.facts.some(
        (fact) => fact.domain === 'lifestyle_match' && fact.drugNames.includes('mirtazapine'),
      ),
    ).toBe(true)
    expect(confirmed.facts.some((fact) => fact.id === 'SYMPTOM-CONTEXT')).toBe(true)
  })

  it('returns an explicit not-connected result instead of simulated AI output', async () => {
    const provider = new NotConnectedClinicalReviewProvider()
    const review = await provider.review(result, { selectedDrug: 'sertraline' })

    expect(review.status).toBe('not_connected')
    expect(review.items).toEqual([])
    expect(review.message).toMatch(/No AI review was run/)
    expect(createClinicalReviewProvider({ endpoint: '' }).mode).toBe('not_connected')
  })

  it('accepts only grounded questions and lifestyle synthesis', () => {
    const context = buildClinicalReviewContext(result, {
      selectedDrug: 'sertraline',
      confirmedLifestyle: { dailySchedule: 'variable' },
    })
    const lifestyleFact = context.facts.find(
      (fact) => fact.domain === 'lifestyle_requirement' && fact.drugNames.includes('sertraline') && fact.sourceIds.length,
    )!
    const routineFact = context.facts.find((fact) => fact.id === 'LIFESTYLE-CONTEXT:dailySchedule')!
    const geneFact = context.facts.find(
      (fact) => fact.id === 'GENE:CYP2D6' && fact.drugNames.includes('fluoxetine'),
    )!

    const review = validateClinicalReviewOutput(
      {
        items: [
          {
            action: 'lifestyle_constraint',
            summary: 'The sertraline protocol has a sourced daily-life requirement to compare with the recorded routine.',
            factIds: [lifestyleFact.id, routineFact.id],
            drugNames: ['sertraline'],
            sourceIds: [lifestyleFact.sourceIds[0]],
          },
          {
            action: 'clinician_question',
            summary: 'Could the prescriber review how fluoxetine affects the recorded CYP2D6 result?',
            factIds: [geneFact.id],
            drugNames: ['fluoxetine'],
            sourceIds: geneFact.sourceIds.slice(0, 1),
          },
        ],
      },
      context,
    )

    expect(review.status).toBe('complete')
    expect(review.items).toHaveLength(2)
    expect(review.rejections).toEqual([])
  })

  it('rejects unknown actions, facts, drugs, sources, numbers and treatment claims', () => {
    const context = buildClinicalReviewContext(result, { selectedDrug: 'sertraline' })
    const fact = context.facts.find((value) => value.id === 'GENE:CYP2D6')!
    const base = {
      factIds: [fact.id],
      drugNames: ['fluoxetine'],
      sourceIds: fact.sourceIds.slice(0, 1),
    }

    const review = validateClinicalReviewOutput(
      {
        items: [
          { ...base, action: 'recommend_drug', summary: 'Choose fluoxetine.' },
          { ...base, action: 'evidence_gap', summary: 'A fact is missing.', factIds: ['FACT:MADE-UP'] },
          { ...base, action: 'evidence_gap', summary: 'Lamotrigine has a gap.', drugNames: ['lamotrigine'] },
          { ...base, action: 'evidence_gap', summary: 'The source is missing.', sourceIds: ['invented-source'] },
          { ...base, action: 'evidence_gap', summary: 'A 37 mg dose is missing.' },
          { ...base, action: 'evidence_gap', summary: 'Fluoxetine is better and likely to work.' },
        ],
      },
      context,
    )

    expect(review.status).toBe('rejected')
    expect(review.items).toEqual([])
    expect(new Set(review.rejections.map((entry) => entry.kind))).toEqual(
      new Set([
        'unsupported_action',
        'unknown_fact',
        'unknown_drug',
        'unknown_source',
        'unknown_number',
        'unsupported_claim',
        'ungrounded_reference',
      ]),
    )
  })

  it('can request a counterfactual but cannot answer it or invent a rerun operation', () => {
    const context = buildClinicalReviewContext(result, { selectedDrug: 'sertraline' })
    const current = context.facts.find(
      (fact) => fact.domain === 'current_medication' && fact.drugNames.includes('fluoxetine'),
    )!

    const accepted = validateClinicalReviewOutput(
      {
        items: [
          {
            action: 'request_counterfactual',
            summary: 'Re-run the deterministic analysis without fluoxetine before answering how the recorded medicine effect changes.',
            factIds: [current.id],
            drugNames: ['fluoxetine'],
            sourceIds: [],
            rerunRequest: { operation: 'remove_current_medication', drug: 'fluoxetine' },
          },
        ],
      },
      context,
    )
    expect(accepted.status).toBe('complete')
    expect(accepted.items[0].rerunRequest).toEqual({
      operation: 'remove_current_medication',
      drug: 'fluoxetine',
    })

    const rejected = validateClinicalReviewOutput(
      {
        items: [
          {
            action: 'request_counterfactual',
            summary: 'Calculate a new fluoxetine dose.',
            factIds: [current.id],
            drugNames: ['fluoxetine'],
            sourceIds: [],
            rerunRequest: { operation: 'calculate_dose', drug: 'fluoxetine' },
          },
        ],
      },
      context,
    )
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejections.map((entry) => entry.kind)).toContain('invalid_counterfactual')
  })

  it('calls only a same-origin endpoint and sends the minimised context as JSON', async () => {
    let requestBody = ''
    let requestInit: RequestInit | undefined
    const context = buildClinicalReviewContext(result, { selectedDrug: 'sertraline' })
    const fact = context.facts.find(
      (value) => value.domain === 'lifestyle_requirement' && value.drugNames.includes('sertraline'),
    )!
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? '')
      requestInit = init
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      action: 'clinician_question',
                      summary: 'Could the prescriber review the sourced sertraline lifestyle requirement?',
                      factIds: [fact.id],
                      drugNames: ['sertraline'],
                      sourceIds: fact.sourceIds.slice(0, 1),
                    },
                  ],
                }),
              },
            },
          ],
        }),
      } as Response
    })
    const provider = new MedGemmaClinicalReviewProvider({
      endpoint: '/api/clinical-review',
      origin: 'https://pgx.example',
      fetchImpl,
    })

    const review = await provider.review(result, { selectedDrug: 'sertraline' })
    const outer = JSON.parse(requestBody) as { messages: Array<{ role: string; content: string }> }
    const sent = JSON.parse(outer.messages.find((message) => message.role === 'user')!.content) as unknown
    const serialised = JSON.stringify(sent)

    expect(review.status).toBe('complete')
    expect(fetchImpl).toHaveBeenCalledWith('/api/clinical-review', expect.any(Object))
    expect(requestInit?.credentials).toBe('same-origin')
    expect(requestInit?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(serialised).not.toContain('Jane-Doe')
    expect(serialised).not.toContain('DIRECT_IDENTIFIER_JANE')
    expect(serialised).not.toContain('diplotype')
  })

  it('refuses cross-origin model endpoints and non-JSON model text', async () => {
    expect(
      () => new MedGemmaClinicalReviewProvider({ endpoint: 'https://other.example/review', origin: 'https://pgx.example' }),
    ).toThrow(/same-origin/)

    const provider = new MedGemmaClinicalReviewProvider({
      endpoint: '/api/clinical-review',
      origin: 'https://pgx.example',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '```json\n{"items":[]}\n```' } }] }),
      }) as Response),
    })
    const review = await provider.review(result)
    expect(review.status).toBe('rejected')
    expect(review.rejections[0].kind).toBe('malformed_response')
  })
})
