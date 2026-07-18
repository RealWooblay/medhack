/**
 * Constrained MedGemma clinical review.
 *
 * This is the model's useful reasoning surface. It may connect already-established facts,
 * identify missing or conflicting context, formulate questions for a clinician, and ask the
 * deterministic engine to run a counterfactual. It cannot create a gene call, choose a
 * treatment, calculate a dose, or turn a hypothetical into a clinical conclusion.
 *
 * Privacy and authority boundary: the browser sends only a private run ID plus bounded,
 * structured patient assertions. The server loads the session-owned PharmCAT bundle and
 * independently calls `buildClinicalReviewContext`; it never accepts fact text, sources,
 * prompts, gene calls or model settings from the browser.
 */

import { canonicalDrug } from '../data/drug-lexicon'
import { matchLifestyle } from '../engine/lifestyle-fit'
import type { AnalysisResult, LifestyleContext } from '../engine/types'

export const CLINICAL_REVIEW_ACTIONS = [
  'evidence_gap',
  'input_conflict',
  'clinician_question',
  'lifestyle_constraint',
  'request_counterfactual',
] as const

export type ClinicalReviewAction = (typeof CLINICAL_REVIEW_ACTIONS)[number]

export type CurrentMedicationsStatus = 'provided' | 'confirmed_none'

export const COUNTERFACTUAL_OPERATIONS = [
  'add_current_medication',
  'remove_current_medication',
  'select_lifestyle_drug',
  'set_lifestyle_context',
] as const

export type CounterfactualOperation = (typeof COUNTERFACTUAL_OPERATIONS)[number]

export type ClinicalFactDomain =
  | 'gene_result'
  | 'gene_limit'
  | 'pgx_guidance'
  | 'medicine_interaction'
  | 'current_medication'
  | 'past_trial'
  | 'lifestyle_context'
  | 'lifestyle_requirement'
  | 'lifestyle_match'
  | 'evidence_limit'
  | 'care_goal'
  | 'symptom_context'

export interface ClinicalReviewFact {
  id: string
  domain: ClinicalFactDomain
  /** Fixed text assembled from deterministic engine fields, never model-written. */
  text: string
  drugNames: string[]
  sourceIds: string[]
}

export interface ClinicalReviewSource {
  id: string
  label: string
  title: string
}

export interface ClinicalReviewContext {
  schemaVersion: '1.0'
  privacy: 'derived-clinical-facts-only'
  selectedDrug: string | null
  currentMedications: string[]
  allowedDrugs: string[]
  availableProtocolDrugs: string[]
  facts: ClinicalReviewFact[]
  sources: ClinicalReviewSource[]
}

export type CounterfactualRequest =
  | {
      operation: 'add_current_medication' | 'remove_current_medication' | 'select_lifestyle_drug'
      drug: string
    }
  | {
      operation: 'set_lifestyle_context'
      dimension: keyof LifestyleContext
      value: LifestyleContext[keyof LifestyleContext]
    }

export interface ClinicalReviewItem {
  action: ClinicalReviewAction
  factIds: string[]
  drugNames: string[]
  sourceIds: string[]
  /** Present only when deterministic code must re-run before an answer can be shown. */
  rerunRequest?: CounterfactualRequest
}

export type ClinicalReviewRejectionKind =
  | 'malformed_response'
  | 'malformed_item'
  | 'unsupported_action'
  | 'unknown_fact'
  | 'unknown_drug'
  | 'unknown_source'
  | 'invalid_counterfactual'
  | 'ungrounded_reference'

export interface ClinicalReviewRejection {
  itemIndex: number | null
  kind: ClinicalReviewRejectionKind
  offendingToken: string
  reason: string
}

export type ClinicalReviewStatus = 'not_connected' | 'complete' | 'rejected' | 'error'

export interface ClinicalReviewResult {
  status: ClinicalReviewStatus
  provider: string
  model: string | null
  items: ClinicalReviewItem[]
  rejections: ClinicalReviewRejection[]
  message: string
}

export interface ClinicalReviewOptions {
  /**
   * Run identity issued by the private PharmCAT service. The governed provider will not
   * review an imported report or public example without this session-bound identifier.
   */
  attestedRunId?: string | null
  /** The medicine whose day-to-day protocol should be reviewed. This is not a selection. */
  selectedDrug?: string | null
  /** Only routine fields the person explicitly confirmed. Neutral engine defaults are excluded. */
  confirmedLifestyle?: Partial<LifestyleContext>
  /** Symptom context is opt-in because many validation flows do not collect a PHQ-9. */
  includeSymptomContext?: boolean
}

export interface ClinicalReviewProvider {
  readonly name: string
  readonly mode: 'not_connected' | 'ai'
  review(result: AnalysisResult, options?: ClinicalReviewOptions): Promise<ClinicalReviewResult>
}

const unique = <T>(values: T[]): T[] => [...new Set(values)]

function knownGeneric(name: string): string | null {
  return canonicalDrug(name)?.toLowerCase() ?? null
}

function knownSourceIds(result: AnalysisResult, ids: string[]): string[] {
  return unique(ids.filter((id) => Boolean(result.citations[id])))
}

function addFact(
  facts: ClinicalReviewFact[],
  result: AnalysisResult,
  fact: Omit<ClinicalReviewFact, 'drugNames' | 'sourceIds'> & {
    drugNames?: string[]
    sourceIds?: string[]
  },
): void {
  facts.push({
    ...fact,
    drugNames: unique((fact.drugNames ?? []).map(knownGeneric).filter((drug): drug is string => Boolean(drug))),
    sourceIds: knownSourceIds(result, fact.sourceIds ?? []),
  })
}

const humanise = (value: string): string => value.replaceAll('_', ' ')

const LIFESTYLE_VALUES: { [K in keyof LifestyleContext]: ReadonlySet<LifestyleContext[K]> } = {
  sleep: new Set(['settled', 'trouble_sleeping', 'sleeping_too_much', 'variable']),
  mealRoutine: new Set(['regular', 'irregular', 'variable']),
  dailySchedule: new Set(['regular', 'shift_work', 'variable']),
  alcohol: new Set(['none', 'occasional', 'regular']),
  drivingOrMachinery: new Set([true, false]),
  missedDoses: new Set(['rarely', 'sometimes', 'often']),
  eatingDisorderHistory: new Set([true, false]),
}

const LIFESTYLE_KEYS = Object.keys(LIFESTYLE_VALUES) as Array<keyof LifestyleContext>

const NEUTRAL_LIFESTYLE: LifestyleContext = {
  sleep: 'settled',
  mealRoutine: 'regular',
  dailySchedule: 'regular',
  alcohol: 'none',
  drivingOrMachinery: false,
  missedDoses: 'rarely',
  eatingDisorderHistory: false,
}

function sanitiseConfirmedLifestyle(
  supplied: Partial<LifestyleContext> | undefined,
): Partial<LifestyleContext> {
  if (!supplied) return {}
  const confirmed: Partial<LifestyleContext> = {}
  for (const dimension of LIFESTYLE_KEYS) {
    const value = supplied[dimension]
    const allowedValues = LIFESTYLE_VALUES[dimension] as ReadonlySet<unknown>
    if (value !== undefined && allowedValues.has(value)) {
      ;(confirmed as Record<string, unknown>)[dimension] = value
    }
  }
  return confirmed
}

/**
 * Produces the exact, privacy-minimised object that may be sent to the model.
 *
 * The selected protocol is included in depth; other medicines retain their PGx findings
 * but not every label paragraph. This keeps the review specific without inviting an
 * efficacy ranking across medicines.
 */
export function buildClinicalReviewContext(
  result: AnalysisResult,
  options: ClinicalReviewOptions = {},
): ClinicalReviewContext {
  const facts: ClinicalReviewFact[] = []
  const resultDrugs = unique(
    [
      ...result.shortlist.map((drug) => drug.drug),
      ...result.input.currentMedications,
      ...result.history.map((trial) => trial.drug),
    ]
      .map(knownGeneric)
      .filter((drug): drug is string => Boolean(drug)),
  ).sort()

  const protocolDrugs = Object.keys(result.protocolsByDrug)
    .map(knownGeneric)
    .filter((drug): drug is string => Boolean(drug))
    .sort()

  const requestedDrug = options.selectedDrug == null
    ? knownGeneric(result.protocol?.drug ?? '')
    : knownGeneric(options.selectedDrug)
  const selectedDrug = requestedDrug && protocolDrugs.includes(requestedDrug) ? requestedDrug : null

  const currentMedications = unique(
    result.input.currentMedications
      .map(knownGeneric)
      .filter((drug): drug is string => Boolean(drug)),
  ).sort()
  const confirmedLifestyle = sanitiseConfirmedLifestyle(options.confirmedLifestyle)

  for (const gene of result.genes) {
    const modifierText = gene.modifiers.length
      ? ` Recorded medicine effects: ${gene.modifiers
          .map((modifier) => `${knownGeneric(modifier.drug) ?? 'unrecognised medicine'} is a ${humanise(modifier.effect)}`)
          .join('; ')}.`
      : ''
    const geneSources = [
      ...(gene.explanation?.citationIds ?? []),
      ...(gene.unresolvedWarning?.citationIds ?? []),
      ...gene.modifiers.flatMap((modifier) => modifier.citationIds),
      ...gene.confidence.reasons.flatMap((reason) => reason.citationIds),
      'pharmcat',
    ]

    addFact(facts, result, {
      id: `GENE:${gene.gene}`,
      domain: 'gene_result',
      text:
        `${gene.gene} phenotype imported from PharmCAT: ${gene.geneticPhenotype}. ` +
        `Medicine-adjustment status: ${humanise(gene.status)}.` +
        `${gene.modeledFunctionalPhenotype
          ? ` Research-convention estimate: ${gene.modeledFunctionalPhenotype} at activity score ${gene.modeledFunctionalActivityScore}; this estimate does not replace PharmCAT guidance.`
          : ''}${modifierText}`,
      drugNames: gene.modifiers.map((modifier) => modifier.drug),
      sourceIds: geneSources,
    })

    addFact(facts, result, {
      id: `GENE-LIMIT:${gene.gene}`,
      domain: 'gene_limit',
      text:
        `${gene.gene} evidence confidence is ${gene.confidence.level}. ` +
        `${gene.confidence.headline}. This confidence label is not a probability and must not be used to call a variant.`,
      sourceIds: geneSources,
    })
  }

  for (const excluded of result.excludedGenes) {
    addFact(facts, result, {
      id: `GENE-LIMIT:${excluded.gene}`,
      domain: 'evidence_limit',
      text:
        `${excluded.gene} was reviewed but is not used for antidepressant guidance because the captured ` +
        'evidence does not support a clinical recommendation.',
      sourceIds: excluded.rationale.citationIds,
    })
  }

  for (const drug of result.shortlist) {
    const generic = knownGeneric(drug.drug)
    if (!generic) continue

    drug.geneFindings.forEach((finding, index) => {
      addFact(facts, result, {
        id: `PGX:${generic}:${finding.gene}:${index + 1}`,
        domain: 'pgx_guidance',
        text:
          `${generic}: the imported PharmCAT annotation used ${finding.geneResults
            .map((geneResult) => `${geneResult.gene} ${geneResult.phenotype}`)
            .join(' and ')}. ` +
          `Captured action: ${humanise(finding.action)}. Captured guideline text: ${finding.guidelineText}` +
          `${finding.strength ? ` Strength: ${finding.strength}.` : ''}`,
        drugNames: [generic],
        sourceIds: finding.citationIds,
      })
    })

    drug.interactionFlags.forEach((flag, index) => {
      addFact(facts, result, {
        id: `INTERACTION:${generic}:${index + 1}`,
        domain: 'medicine_interaction',
        text: `${generic} with ${flag.withDrug}: ${flag.text} Severity label: ${flag.severity}.`,
        drugNames: [generic, flag.withDrug],
        sourceIds: flag.citationIds,
      })
    })

    drug.confidenceCaveats.forEach((caveat, index) => {
      addFact(facts, result, {
        id: `PGX-LIMIT:${generic}:${index + 1}`,
        domain: 'evidence_limit',
        text: `${generic} has a deterministic PGx confidence limitation that requires source review.`,
        drugNames: [generic],
        sourceIds: caveat.citationIds,
      })
    })
  }

  currentMedications.forEach((drug, index) => {
    addFact(facts, result, {
      id: `CURRENT-MEDICATION:${index + 1}`,
      domain: 'current_medication',
      text: `${drug} is recorded as a current medicine. The model must not advise starting or stopping it.`,
      drugNames: [drug],
    })
  })

  result.history.forEach((trial, index) => {
    const drug = knownGeneric(trial.drug)
    if (!drug) return
    addFact(facts, result, {
      id: `PAST-TRIAL:${index + 1}`,
      domain: 'past_trial',
      text:
        `${drug} is recorded as a past trial with outcome ${humanise(trial.outcome)}. ` +
        `The deterministic PGx reconstruction category is ${humanise(trial.explanation)}; it does not establish causation.`,
      drugNames: [drug],
      sourceIds: trial.mechanism?.citationIds ?? [],
    })
  })

  const confirmedLifestyleEntries = LIFESTYLE_KEYS
    .filter((dimension) => confirmedLifestyle[dimension] !== undefined)
    .map((dimension) => [dimension, confirmedLifestyle[dimension]!] as const)
  for (const [dimension, value] of confirmedLifestyleEntries) {
    addFact(facts, result, {
      id: `LIFESTYLE-CONTEXT:${dimension}`,
      domain: 'lifestyle_context',
      text: `Recorded ${humanise(dimension)} context: ${typeof value === 'boolean' ? String(value) : humanise(value)}.`,
    })
  }
  if (!confirmedLifestyleEntries.length) {
    addFact(facts, result, {
      id: 'LIFESTYLE-CONTEXT:NOT-CONFIRMED',
      domain: 'evidence_limit',
      text: 'No daily-routine dimension was explicitly confirmed for this medical-model review.',
    })
  }

  result.care.goals.forEach((goal, index) => {
    addFact(facts, result, {
      id: `CARE-GOAL:${index + 1}`,
      domain: 'care_goal',
      text: `Recorded care goal: ${humanise(goal)}.`,
    })
  })

  if (options.includeSymptomContext && result.depression) {
    addFact(facts, result, {
      id: 'SYMPTOM-CONTEXT',
      domain: 'symptom_context',
      text:
        `Recorded PHQ-9 symptom category: ${humanise(result.depression.severity)}. ` +
        `Recorded functional impact: ${humanise(result.depression.functionalImpact)}. ` +
        'This is context, not authority for the model to diagnose or choose treatment.',
      sourceIds: result.depression.interpretation.citationIds,
    })
  }

  if (selectedDrug) {
    const protocol = result.protocolsByDrug[selectedDrug]
    for (const item of [...protocol.items, ...protocol.interactionItems]) {
      addFact(facts, result, {
        id: `LIFESTYLE-RULE:${selectedDrug}:${item.id}`,
        domain: 'lifestyle_requirement',
        text:
          `${selectedDrug} ${humanise(item.category)} requirement (${item.severity}): ${item.rule} ` +
          `Source explanation: ${item.why}`,
        drugNames: [selectedDrug],
        sourceIds: item.citationIds,
      })
    }

    const match = matchLifestyle(
      protocol,
      {
        ...result.care,
        lifestyle: { ...NEUTRAL_LIFESTYLE, ...confirmedLifestyle },
      },
      confirmedLifestyle,
    )
    if (match) {
      const matchDimensionToContext: Record<string, keyof LifestyleContext> = {
        sleep: 'sleep',
        meals: 'mealRoutine',
        schedule: 'dailySchedule',
        alcohol: 'alcohol',
        driving: 'drivingOrMachinery',
        adherence: 'missedDoses',
        medical_history: 'eatingDisorderHistory',
      }
      match.facts.forEach((fact, index) => {
        const contextDimension = matchDimensionToContext[fact.dimension]
        if (!contextDimension || confirmedLifestyle[contextDimension] === undefined) return
        addFact(facts, result, {
          id: `LIFESTYLE-MATCH:${selectedDrug}:${index + 1}`,
          domain: 'lifestyle_match',
          text:
            `${selectedDrug} and recorded ${humanise(fact.dimension)} context: ${fact.title}. ${fact.detail} ` +
            `Deterministic fit label: ${humanise(fact.verdict)}.`,
          drugNames: [selectedDrug],
          sourceIds: fact.citationIds,
        })
      })
      match.unknowns.forEach((unknown, index) => {
        addFact(facts, result, {
          id: `LIFESTYLE-UNKNOWN:${selectedDrug}:${index + 1}`,
          domain: 'evidence_limit',
          text: `${selectedDrug} lifestyle evidence limit: ${unknown}`,
          drugNames: [selectedDrug],
        })
      })
    }
  }

  const sourceIds = new Set(facts.flatMap((fact) => fact.sourceIds))
  const sources = Object.values(result.citations)
    .filter((source) => sourceIds.has(source.id))
    .map((source) => ({ id: source.id, label: source.label, title: source.title }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    schemaVersion: '1.0',
    privacy: 'derived-clinical-facts-only',
    selectedDrug,
    currentMedications,
    allowedDrugs: resultDrugs,
    availableProtocolDrugs: protocolDrugs,
    facts,
    sources,
  }
}

const ACTIONS = new Set<string>(CLINICAL_REVIEW_ACTIONS)
const OPERATIONS = new Set<string>(COUNTERFACTUAL_OPERATIONS)

interface ReviewAllowList {
  factIds: Set<string>
  sourceIds: Set<string>
  drugs: Set<string>
  currentMedications: Set<string>
  protocolDrugs: Set<string>
  factsById: Map<string, ClinicalReviewFact>
}

function buildReviewAllowList(context: ClinicalReviewContext): ReviewAllowList {
  return {
    factIds: new Set(context.facts.map((fact) => fact.id)),
    sourceIds: new Set(context.sources.map((source) => source.id)),
    drugs: new Set(context.allowedDrugs),
    currentMedications: new Set(context.currentMedications),
    protocolDrugs: new Set(context.availableProtocolDrugs),
    factsById: new Map(context.facts.map((fact) => [fact.id, fact])),
  }
}

function rejection(
  itemIndex: number | null,
  kind: ClinicalReviewRejectionKind,
  offendingToken: string,
  reason: string,
): ClinicalReviewRejection {
  const boundedToken = offendingToken
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 200)
  return { itemIndex, kind, offendingToken: boundedToken, reason }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function parseCounterfactual(
  raw: unknown,
  allow: ReviewAllowList,
  itemIndex: number,
): { value: CounterfactualRequest | null; rejections: ClinicalReviewRejection[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'invalid_counterfactual', 'rerunRequest', 'A counterfactual must be a structured rerun request.')],
    }
  }

  const candidate = raw as Record<string, unknown>
  if (typeof candidate.operation !== 'string' || !OPERATIONS.has(candidate.operation)) {
    return {
      value: null,
      rejections: [
        rejection(
          itemIndex,
          'invalid_counterfactual',
          String(candidate.operation ?? ''),
          'The model requested an unsupported deterministic rerun operation.',
        ),
      ],
    }
  }

  if (candidate.operation === 'set_lifestyle_context') {
    const extraKey = Object.keys(candidate).find(
      (key) => !['operation', 'dimension', 'value'].includes(key),
    )
    if (extraKey) {
      return {
        value: null,
        rejections: [rejection(itemIndex, 'invalid_counterfactual', extraKey, 'The lifestyle rerun contained an unsupported field.')],
      }
    }
    const dimension = candidate.dimension
    if (typeof dimension !== 'string' || !(dimension in LIFESTYLE_VALUES)) {
      return {
        value: null,
        rejections: [rejection(itemIndex, 'invalid_counterfactual', String(dimension ?? ''), 'Unknown lifestyle dimension.')],
      }
    }
    const typedDimension = dimension as keyof LifestyleContext
    const allowedValues = LIFESTYLE_VALUES[typedDimension] as ReadonlySet<unknown>
    if (!allowedValues.has(candidate.value)) {
      return {
        value: null,
        rejections: [rejection(itemIndex, 'invalid_counterfactual', String(candidate.value ?? ''), 'Unsupported lifestyle value.')],
      }
    }
    return {
      value: {
        operation: 'set_lifestyle_context',
        dimension: typedDimension,
        value: candidate.value as LifestyleContext[typeof typedDimension],
      },
      rejections: [],
    }
  }

  const extraKey = Object.keys(candidate).find((key) => !['operation', 'drug'].includes(key))
  if (extraKey) {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'invalid_counterfactual', extraKey, 'The medicine rerun contained an unsupported field.')],
    }
  }

  if (typeof candidate.drug !== 'string') {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'invalid_counterfactual', 'drug', 'The rerun request did not contain a generic drug name.')],
    }
  }
  const drug = knownGeneric(candidate.drug)
  if (!drug || !allow.drugs.has(drug)) {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'unknown_drug', candidate.drug, 'The rerun request named a drug outside this result.')],
    }
  }

  if (candidate.operation === 'remove_current_medication' && !allow.currentMedications.has(drug)) {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'invalid_counterfactual', drug, 'Only a recorded current medicine can be removed in a rerun request.')],
    }
  }
  if (candidate.operation === 'add_current_medication' && allow.currentMedications.has(drug)) {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'invalid_counterfactual', drug, 'That medicine is already recorded as current, so this rerun would not change the input.')],
    }
  }
  if (candidate.operation === 'select_lifestyle_drug' && !allow.protocolDrugs.has(drug)) {
    return {
      value: null,
      rejections: [rejection(itemIndex, 'invalid_counterfactual', drug, 'No deterministic lifestyle protocol is available for that medicine.')],
    }
  }

  return {
    value: {
      operation: candidate.operation as
        | 'add_current_medication'
        | 'remove_current_medication'
        | 'select_lifestyle_drug',
      drug,
    },
    rejections: [],
  }
}

function validateItem(
  raw: unknown,
  itemIndex: number,
  allow: ReviewAllowList,
): { item: ClinicalReviewItem | null; rejections: ClinicalReviewRejection[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      item: null,
      rejections: [rejection(itemIndex, 'malformed_item', String(raw), 'Each review item must be a JSON object.')],
    }
  }

  const candidate = raw as Record<string, unknown>
  const allowedKeys = new Set(['action', 'factIds', 'drugNames', 'sourceIds', 'rerunRequest'])
  const extraKey = Object.keys(candidate).find((key) => !allowedKeys.has(key))
  if (extraKey) {
    return {
      item: null,
      rejections: [rejection(itemIndex, 'malformed_item', extraKey, 'The model returned a field outside the review schema.')],
    }
  }

  if (typeof candidate.action !== 'string' || !ACTIONS.has(candidate.action)) {
    return {
      item: null,
      rejections: [
        rejection(
          itemIndex,
          'unsupported_action',
          String(candidate.action ?? ''),
          'The model attempted an action outside the constrained clinical-review contract.',
        ),
      ],
    }
  }
  if (
    !isStringArray(candidate.factIds) ||
    !isStringArray(candidate.drugNames) ||
    !isStringArray(candidate.sourceIds) ||
    candidate.factIds.length === 0 ||
    candidate.factIds.length > 12 ||
    candidate.drugNames.length > 12 ||
    candidate.sourceIds.length > 12
  ) {
    return {
      item: null,
      rejections: [rejection(itemIndex, 'malformed_item', 'review item', 'The review item did not match the bounded JSON schema.')],
    }
  }

  const issues: ClinicalReviewRejection[] = []
  const factIds = unique(candidate.factIds)
  const sourceIds = unique(candidate.sourceIds)
  const drugNames = unique(
    candidate.drugNames
      .map(knownGeneric)
      .filter((drug): drug is string => Boolean(drug)),
  )

  const unknownFact = factIds.find((id) => !allow.factIds.has(id))
  if (unknownFact) issues.push(rejection(itemIndex, 'unknown_fact', unknownFact, 'The fact ID was not sent to the model.'))

  const unknownSource = sourceIds.find((id) => !allow.sourceIds.has(id))
  if (unknownSource) issues.push(rejection(itemIndex, 'unknown_source', unknownSource, 'The source ID was not sent to the model.'))

  const malformedDrug = candidate.drugNames.find((drug) => !knownGeneric(drug))
  if (malformedDrug) issues.push(rejection(itemIndex, 'unknown_drug', malformedDrug, 'The model did not return a recognised generic drug name.'))
  const unknownDrug = drugNames.find((drug) => !allow.drugs.has(drug))
  if (unknownDrug) issues.push(rejection(itemIndex, 'unknown_drug', unknownDrug, 'The drug is outside this clinical result.'))

  const referencedFacts = factIds
    .map((id) => allow.factsById.get(id))
    .filter((fact): fact is ClinicalReviewFact => Boolean(fact))
  const groundedDrugs = new Set(referencedFacts.flatMap((fact) => fact.drugNames))
  const ungroundedDrug = drugNames.find((drug) => !groundedDrugs.has(drug))
  if (ungroundedDrug) {
    issues.push(rejection(itemIndex, 'ungrounded_reference', ungroundedDrug, 'The named drug is not present in any referenced fact.'))
  }
  const groundedSources = new Set(referencedFacts.flatMap((fact) => fact.sourceIds))
  const ungroundedSource = sourceIds.find((source) => !groundedSources.has(source))
  if (ungroundedSource) {
    issues.push(rejection(itemIndex, 'ungrounded_reference', ungroundedSource, 'The source is not attached to any referenced fact.'))
  }

  if (candidate.action === 'input_conflict' && factIds.length < 2) {
    issues.push(rejection(itemIndex, 'malformed_item', 'factIds', 'A conflict must identify at least two facts in tension.'))
  }
  if (candidate.action === 'lifestyle_constraint') {
    const lifestyleGrounded = referencedFacts.some((fact) =>
      ['lifestyle_context', 'lifestyle_requirement', 'lifestyle_match'].includes(fact.domain),
    )
    if (!lifestyleGrounded) {
      issues.push(rejection(itemIndex, 'ungrounded_reference', 'factIds', 'A lifestyle synthesis must reference a lifestyle fact.'))
    }
  }

  let rerunRequest: CounterfactualRequest | undefined
  if (candidate.action === 'request_counterfactual') {
    const parsed = parseCounterfactual(candidate.rerunRequest, allow, itemIndex)
    issues.push(...parsed.rejections)
    rerunRequest = parsed.value ?? undefined
    if (rerunRequest && 'drug' in rerunRequest && !drugNames.includes(rerunRequest.drug)) {
      issues.push(
        rejection(
          itemIndex,
          'ungrounded_reference',
          rerunRequest.drug,
          'The counterfactual drug must also appear in the item drugNames array.',
        ),
      )
    }
  } else if (candidate.rerunRequest !== undefined) {
    issues.push(
      rejection(
        itemIndex,
        'invalid_counterfactual',
        'rerunRequest',
        'Only request_counterfactual may ask deterministic code to rerun.',
      ),
    )
  }

  if (issues.length) return { item: null, rejections: issues }

  return {
    item: {
      action: candidate.action as ClinicalReviewAction,
      factIds,
      drugNames,
      sourceIds,
      ...(rerunRequest ? { rerunRequest } : {}),
    },
    rejections: [],
  }
}

/** Validates model JSON. One invalid item cannot partially enter the accepted result. */
export function validateClinicalReviewOutput(
  raw: unknown,
  context: ClinicalReviewContext,
  provider = 'MedGemma',
  model: string | null = null,
): ClinicalReviewResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).items)) {
    return {
      status: 'rejected',
      provider,
      model,
      items: [],
      rejections: [rejection(null, 'malformed_response', 'response', 'The endpoint did not return {"items": [...]} JSON.')],
      message: 'The medical-model response was rejected before display.',
    }
  }

  const unexpectedTopLevelKey = Object.keys(raw as Record<string, unknown>).find((key) => key !== 'items')
  if (unexpectedTopLevelKey) {
    return {
      status: 'rejected',
      provider,
      model,
      items: [],
      rejections: [
        rejection(
          null,
          'malformed_response',
          unexpectedTopLevelKey,
          'The endpoint returned a field outside the structured clinical-review schema.',
        ),
      ],
      message: 'The medical-model response was rejected before display.',
    }
  }

  const rawItems = (raw as { items: unknown[] }).items
  if (rawItems.length > 20) {
    return {
      status: 'rejected',
      provider,
      model,
      items: [],
      rejections: [rejection(null, 'malformed_response', String(rawItems.length), 'The endpoint returned more than 20 review items.')],
      message: 'The medical-model response was rejected before display.',
    }
  }

  const allow = buildReviewAllowList(context)
  const items: ClinicalReviewItem[] = []
  const rejections: ClinicalReviewRejection[] = []
  rawItems.forEach((rawItem, index) => {
    const validated = validateItem(rawItem, index, allow)
    if (validated.item) items.push(validated.item)
    rejections.push(...validated.rejections)
  })

  return {
    status: items.length ? 'complete' : 'rejected',
    provider,
    model,
    items,
    rejections,
    message: items.length
      ? `${items.length} constrained clinical-review item${items.length === 1 ? '' : 's'} passed validation.`
      : 'The medical-model response contained no review item that passed validation.',
  }
}

export class NotConnectedClinicalReviewProvider implements ClinicalReviewProvider {
  readonly name = 'Medical-model review not connected'
  readonly mode = 'not_connected' as const

  async review(result: AnalysisResult, options: ClinicalReviewOptions = {}): Promise<ClinicalReviewResult> {
    // Build the context even while offline so callers exercise the same privacy-minimisation
    // path without pretending that a model reviewed it.
    buildClinicalReviewContext(result, options)
    return {
      status: 'not_connected',
      provider: this.name,
      model: null,
      items: [],
      rejections: [],
      message: 'No governed MedGemma endpoint is configured. No AI review was run and no data was sent.',
    }
  }
}

interface GovernedClinicalReviewResponse {
  schemaVersion?: unknown
  runId?: unknown
  model?: unknown
  context?: unknown
  review?: unknown
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REVIEW_REJECTION_KINDS = new Set<ClinicalReviewRejectionKind>([
  'malformed_response',
  'malformed_item',
  'unsupported_action',
  'unknown_fact',
  'unknown_drug',
  'unknown_source',
  'invalid_counterfactual',
  'ungrounded_reference',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseServerRejections(value: unknown): ClinicalReviewRejection[] | null {
  if (!Array.isArray(value) || value.length > 200) return null
  const parsed: ClinicalReviewRejection[] = []
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some((key) => !['itemIndex', 'kind', 'offendingToken', 'reason'].includes(key))) {
      return null
    }
    if (
      !(item.itemIndex === null || (Number.isSafeInteger(item.itemIndex) && Number(item.itemIndex) >= 0)) ||
      typeof item.kind !== 'string' ||
      !REVIEW_REJECTION_KINDS.has(item.kind as ClinicalReviewRejectionKind) ||
      typeof item.offendingToken !== 'string' ||
      item.offendingToken.length > 200 ||
      typeof item.reason !== 'string' ||
      !item.reason ||
      item.reason.length > 600
    ) {
      return null
    }
    parsed.push({
      itemIndex: item.itemIndex as number | null,
      kind: item.kind as ClinicalReviewRejectionKind,
      offendingToken: item.offendingToken,
      reason: item.reason,
    })
  }
  return parsed
}

export interface MedGemmaClinicalReviewOptions {
  endpoint: string
  /** Explicit base origin is useful in tests and server rendering. Browser callers omit it. */
  origin?: string
  fetchImpl?: typeof fetch
}

function governedEndpoint(endpoint: string, explicitOrigin?: string): string {
  const browserOrigin = typeof window === 'undefined' ? undefined : window.location.origin
  const origin = explicitOrigin ?? browserOrigin
  if (!origin) {
    if (!endpoint.startsWith('/')) {
      throw new Error('A same-origin MedGemma endpoint must be a relative path when no browser origin is available.')
    }
    return endpoint
  }

  const base = new URL(origin)
  const target = new URL(endpoint, base)
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin) {
    throw new Error('MedGemma clinical review must use a governed same-origin endpoint.')
  }
  return endpoint.startsWith('/') ? endpoint : target.toString()
}

export class MedGemmaClinicalReviewProvider implements ClinicalReviewProvider {
  readonly name: string
  readonly mode = 'ai' as const
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor(options: MedGemmaClinicalReviewOptions) {
    this.endpoint = governedEndpoint(options.endpoint, options.origin)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.name = 'Configured medical-model review'
  }

  async review(result: AnalysisResult, options: ClinicalReviewOptions = {}): Promise<ClinicalReviewResult> {
    const context = buildClinicalReviewContext(result, options)
    const runId = options.attestedRunId?.trim() ?? ''
    if (!RUN_ID.test(runId)) {
      return {
        status: 'error',
        provider: this.name,
        model: null,
        items: [],
        rejections: [],
        message: 'AI review requires a completed private genome run. Imported reports and public examples are not accepted.',
      }
    }
    const currentMedicationsStatus: CurrentMedicationsStatus = result.input.currentMedications.length
      ? 'provided'
      : 'confirmed_none'
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          runId,
          patientContext: {
            selectedDrug: options.selectedDrug ?? null,
            currentMedications: result.input.currentMedications,
            currentMedicationsStatus,
            confirmedLifestyle: sanitiseConfirmedLifestyle(options.confirmedLifestyle),
          },
        }),
      })

      if (!response.ok) {
        return {
          status: 'error',
          provider: this.name,
          model: null,
          items: [],
          rejections: [],
          message: `The governed MedGemma endpoint returned HTTP ${response.status}. No AI output was used.`,
        }
      }

      const payload = (await response.json()) as GovernedClinicalReviewResponse
      const serverModel = typeof payload.model === 'string' && /^[A-Za-z0-9._/@:+-]{1,200}$/.test(payload.model)
        ? payload.model
        : null
      if (
        payload.schemaVersion !== '1.0' ||
        payload.runId !== runId ||
        !serverModel ||
        JSON.stringify(payload.context) !== JSON.stringify(context) ||
        !isRecord(payload.review) ||
        !Array.isArray(payload.review.items)
      ) {
        return {
          status: 'error',
          provider: this.name,
          model: null,
          items: [],
          rejections: [],
          message: 'The endpoint did not return a matching server-derived review context. No AI output was used.',
        }
      }
      const serverRejections = parseServerRejections(payload.review.rejections)
      if (!serverRejections) {
        return {
          status: 'error',
          provider: this.name,
          model: serverModel,
          items: [],
          rejections: [],
          message: 'The endpoint returned an invalid verifier record. No AI output was used.',
        }
      }

      // The server has already validated these items against its independently rebuilt
      // context. Validate them again against the byte-for-byte matching browser context so
      // a stale frontend or malformed response fails closed rather than changing meaning.
      const revalidated = validateClinicalReviewOutput(
        { items: payload.review.items },
        context,
        `Medical-model review · ${serverModel}`,
        serverModel,
      )
      const rejections = [...serverRejections, ...revalidated.rejections]
      return {
        ...revalidated,
        rejections,
        message: revalidated.items.length
          ? `${revalidated.items.length} constrained clinical-review item${revalidated.items.length === 1 ? '' : 's'} passed server and browser grounding checks.`
          : 'The medical-model response contained no review item that passed both grounding checks.',
      }
    } catch (error) {
      return {
        status: 'error',
        provider: this.name,
        model: null,
        items: [],
        rejections: [],
        message:
          `The governed MedGemma review could not run (${error instanceof Error ? error.message : 'provider error'}). ` +
          'No AI output was used.',
      }
    }
  }
}

export interface CreateClinicalReviewProviderOptions {
  endpoint?: string
  origin?: string
  fetchImpl?: typeof fetch
}

/** Uses Vite configuration when present; missing configuration is an explicit offline state. */
export function createClinicalReviewProvider(
  options: CreateClinicalReviewProviderOptions = {},
): ClinicalReviewProvider {
  const endpoint = (options.endpoint ?? import.meta.env.VITE_MEDGEMMA_ENDPOINT ?? '').trim()
  if (!endpoint) return new NotConnectedClinicalReviewProvider()
  return new MedGemmaClinicalReviewProvider({
    endpoint,
    origin: options.origin,
    fetchImpl: options.fetchImpl,
  })
}
