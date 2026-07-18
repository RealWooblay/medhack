/**
 * Optional MedGemma narrative adapter.
 *
 * This expects an operator-controlled, OpenAI-compatible MedGemma endpoint. It deliberately
 * has no browser API-key support: production deployments must proxy through a governed
 * backend or use a local endpoint. Patient data is transmitted only when an endpoint is
 * explicitly configured by the deployer.
 *
 * MedGemma is a developer model, not the clinical authority. It may translate and organise
 * fixed facts. It must not diagnose, rank drugs, calculate a dose or perform crisis triage.
 */

import type { NarrativeProvider } from './provider'
import type { NarrativeFacts } from '../engine/orchestrator'
import type { Draft, DraftClaim, NarrativeSection } from '../engine/types'

const ALLOWED_SECTIONS = new Set<NarrativeSection>([
  'journey_summary',
  'monitoring_plan',
  'phenoconversion_explainer',
  'treatment_history',
  'what_next',
  'protocol_intro',
  'clinician_rationale',
])

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

function parseDraft(raw: string, model: string): Draft {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(cleaned) as { claims?: unknown }
  if (!Array.isArray(parsed.claims)) throw new Error('MedGemma response did not contain a claims array.')

  const claims: DraftClaim[] = parsed.claims.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('MedGemma returned an invalid claim.')
    const claim = value as Record<string, unknown>
    if (typeof claim.section !== 'string' || !ALLOWED_SECTIONS.has(claim.section as NarrativeSection)) {
      throw new Error('MedGemma returned an unknown narrative section.')
    }
    if (typeof claim.text !== 'string' || !Array.isArray(claim.citationIds)) {
      throw new Error('MedGemma returned a malformed narrative claim.')
    }
    if (!claim.citationIds.every((id) => typeof id === 'string')) {
      throw new Error('MedGemma returned a malformed citation list.')
    }
    return {
      section: claim.section as NarrativeSection,
      text: claim.text,
      citationIds: claim.citationIds as string[],
    }
  })

  return { generator: 'live-model', model, claims }
}

export interface MedGemmaProviderOptions {
  endpoint: string
  model?: string
}

function minimiseFacts(facts: NarrativeFacts) {
  return {
    depression: {
      score: facts.depression.score,
      severity: facts.depression.severity,
      interpretation: facts.depression.interpretation,
      monitoringNote: facts.depression.monitoringNote,
    },
    goals: facts.care.goals,
    currentMedications: facts.currentMedications,
    genes: facts.genes.map((gene) => ({
      gene: gene.gene,
      diplotype: gene.diplotype,
      geneticPhenotype: gene.geneticPhenotype,
      functionalPhenotype: gene.functionalPhenotype,
      geneticActivityScore: gene.geneticActivityScore,
      functionalActivityScore: gene.functionalActivityScore,
      status: gene.status,
      explanation: gene.explanation,
      unresolvedWarning: gene.unresolvedWarning,
      confidence: gene.confidence,
    })),
    medicationFindings: facts.shortlist.map((drug) => ({
      drug: drug.drug,
      isCurrentMedication: drug.isCurrentMedication,
      headline: drug.headline,
      geneFindings: drug.geneFindings,
      interactionFlags: drug.interactionFlags,
      confidenceCaveats: drug.confidenceCaveats,
      pastTrial: drug.pastTrial,
    })),
    history: facts.history,
    protocol: facts.protocol,
  }
}

export class MedGemmaNarrativeProvider implements NarrativeProvider {
  readonly name: string
  readonly mode = 'ai' as const
  private readonly model: string

  constructor(private readonly options: MedGemmaProviderOptions) {
    const endpoint = new URL(options.endpoint, window.location.origin)
    if (import.meta.env.PROD && endpoint.origin !== window.location.origin) {
      throw new Error('Production MedGemma must be reached through a same-origin governed backend.')
    }
    this.model = options.model ?? 'google/medgemma-27b-text-it'
    this.name = `MedGemma · ${this.model}`
  }

  async compose(facts: NarrativeFacts): Promise<Draft> {
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are the constrained explanation layer in a depression decision-support system. ' +
              'Use only the supplied structured facts. Do not diagnose, choose or rank a medicine, invent a dose, ' +
              'infer suicide risk, or add clinical advice. Return JSON only: {"claims":[{"section":string,' +
              '"text":string,"citationIds":string[]}]}. Every clinical sentence must cite only IDs already present ' +
              'in the supplied facts. Patient-facing text must address the reader as “you”.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: 'Organise and explain these already-decided facts without adding a comparison or recommendation',
              facts: minimiseFacts(facts),
            }),
          },
        ],
      }),
    })

    if (!response.ok) throw new Error(`MedGemma endpoint returned ${response.status}.`)
    const payload = (await response.json()) as ChatResponse
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error('MedGemma endpoint returned no narrative content.')
    return parseDraft(content, this.model)
  }
}
