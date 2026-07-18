/**
 * The deterministic narrative layer used by the validation result.
 *
 * It assembles source-linked template claims and passes them through the same claim validator.
 * The separate clinical-review module may ask MedGemma for typed actions and fact IDs, but
 * model-written medical prose never enters this narrative.
 */

import type {
  AnalysisResult,
  CareContext,
  DepressionSummary,
  Draft,
  DraftClaim,
  DrugAssessment,
  GenePhenotypeResult,
  LifestyleProtocol,
  TrialReconstruction,
} from './types'

export interface NarrativeFacts {
  genes: GenePhenotypeResult[]
  shortlist: DrugAssessment[]
  history: TrialReconstruction[]
  protocol: LifestyleProtocol | null
  currentMedications: string[]
  care: CareContext
  depression: DepressionSummary | null
}

/* ------------------------------------------------------------------ */
/* Deterministic composition                                           */
/* ------------------------------------------------------------------ */

/** Sentence-initial capitalisation for generic drug names, which are stored lowercase. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const GOAL_LABELS: Record<CareContext['goals'][number], string> = {
  feel_more_like_myself: 'feel more like yourself',
  sleep_better: 'sleep better',
  restore_energy: 'restore your energy',
  think_more_clearly: 'think more clearly',
  return_to_work_or_study: 'get back to work or study',
  reconnect_with_people: 'reconnect with people',
  reduce_side_effects: 'reduce side effects',
}

function journeyClaims(facts: NarrativeFacts): DraftClaim[] {
  const claims: DraftClaim[] = []
  if (facts.depression) {
    claims.push({
      section: 'journey_summary',
      text:
        `Your PHQ-9 check-in score is ${facts.depression.score} out of 27, which falls in the ` +
        `${facts.depression.severity.replace('_', ' ')} symptom range. This is a baseline for tracking ` +
        'change with your clinician, not a diagnosis and not a prediction of which treatment will work.',
      citationIds: facts.depression.interpretation.citationIds,
    })
  }

  if (facts.care.goals.length) {
    const labels = facts.care.goals.map((goal) => GOAL_LABELS[goal])
    const readable = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0]
    claims.push({
      section: 'journey_summary',
      text:
        `The outcomes you want back are concrete: ${readable}. Those goals belong beside the symptom score ` +
        'when you and your clinician judge whether a plan is helping.',
      citationIds: ['nice-depression-2022'],
    })
  }

  if (facts.depression) {
    claims.push({
      section: 'monitoring_plan',
      text: facts.depression.monitoringNote.text,
      citationIds: facts.depression.monitoringNote.citationIds,
    })
  }

  return claims
}

/**
 * Patient register.
 *
 * The clinician claims and the patient claims describe identical facts and cite identical
 * sources, but they are written separately rather than one being a rewrite of the other.
 * Reusing "CYP2D6 is functionally a Poor Metabolizer for this patient" in a page addressed
 * to that patient is how a product ends up talking about someone in the third person while
 * they are reading it.
 */
function phenoconversionClaims(facts: NarrativeFacts): DraftClaim[] {
  const claims: DraftClaim[] = []

  // The gene that actually converted is the headline; the flagged-but-unresolved ones are
  // context for it, so they must not lead.
  const ordered = [...facts.genes].sort(
    (a, b) => Number(b.status === 'uncertain_extent') - Number(a.status === 'uncertain_extent'),
  )

  for (const gene of ordered) {
    const cause = gene.modifiers[0]

    if (gene.status === 'uncertain_extent' && gene.explanation && cause) {
      claims.push({
        section: 'phenoconversion_explainer',
        text:
          `Your genetic ${gene.gene} result is ${gene.geneticPhenotype}. ${cap(cause.drug)} is recorded as ` +
          `current and is classified as a ${cause.effect.replaceAll('_', ' ')} of ${gene.gene}. A common ` +
          `research convention estimates an activity score of ${gene.modeledFunctionalActivityScore} and ` +
          `${gene.modeledFunctionalPhenotype}; the extent is uncertain, so this estimate does not replace the ` +
          `reported result or PharmCAT guidance.`,
        citationIds: gene.explanation.citationIds,
      })
    }

    if (gene.status === 'unvalidated_method' && gene.unresolvedWarning && cause) {
      claims.push({
        section: 'phenoconversion_explainer',
        text:
          `${cap(cause.drug)} also slows ${gene.gene}, which handles several of the other options. There ` +
          `is no agreed method for turning that into a specific number, so rather than invent one we have ` +
          `left your ${gene.gene} result as your genes read it and flagged the interaction for your ` +
          `prescriber to weigh up.`,
        citationIds: gene.unresolvedWarning.citationIds,
      })
    }
  }

  if (!claims.length) {
    claims.push({
      section: 'phenoconversion_explainer',
      text:
        `None of the current medicines you recorded matched an inhibitor or inducer in this evidence ` +
        `snapshot. That does not prove there is no interaction; it depends on a complete medicine list and ` +
        `the limits of the captured source.`,
      citationIds: ['fda-interaction-table'],
    })
  }

  return claims
}

function trialClaims(facts: NarrativeFacts): DraftClaim[] {
  return facts.history.map((trial) => ({
    section: 'treatment_history' as const,
    text: trial.patientSummary,
    citationIds: trial.mechanism?.citationIds ?? ['cpic-2023-sri'],
  }))
}

function whatNextClaims(facts: NarrativeFacts): DraftClaim[] {
  const claims: DraftClaim[] = [
    {
      section: 'what_next',
      text:
        `The medication view shows the captured CPIC gene–drug findings for each option. It is listed for ` +
        `review, not as a prediction of efficacy or a treatment recommendation. Your clinician needs the ` +
        `diagnosis, treatment details, comorbidities, preferences and full medicine history to agree a plan.`,
      citationIds: ['cpic-2023-sri'],
    },
  ]

  const blocked = facts.genes.find((g) => g.converted)
  if (blocked?.explanation) {
    claims.push({
      section: 'what_next',
      text:
        `A current medicine changes the supported functional ${blocked.gene} calculation in this report. ` +
        `Raise that finding before any switch or dose decision; this app does not create a washout, taper or ` +
        `cross-taper plan.`,
      citationIds: blocked.explanation.citationIds,
    })
  }

  return claims
}

function protocolClaims(facts: NarrativeFacts): DraftClaim[] {
  if (!facts.protocol) return []
  const critical = facts.protocol.items.filter((i) => i.severity === 'critical')

  const claims: DraftClaim[] = [
    {
      section: 'protocol_intro',
      text:
        `Here are the draft daily-life rules captured for ${facts.protocol.drug}. Every line keeps a source link, ` +
        `but the cached summaries still require exact product-label and formulation verification before clinical use.`,
      citationIds: facts.protocol.items[0]?.citationIds ?? [],
    },
  ]

  if (critical.length) {
    claims.push({
      section: 'protocol_intro',
      text: `The items marked in red are the ones that matter most, so they stay open and cannot be collapsed.`,
      citationIds: critical[0].citationIds,
    })
  }

  return claims
}

function clinicianClaims(facts: NarrativeFacts): DraftClaim[] {
  const claims: DraftClaim[] = []
  const converted = facts.genes.filter((g) => g.converted)
  const unresolved = facts.genes.filter((g) => g.status === 'unvalidated_method')

  if (converted.length) {
    for (const gene of converted) {
      claims.push({
        section: 'clinician_rationale',
        text: gene.explanation?.text ?? '',
        citationIds: gene.explanation?.citationIds ?? [],
      })
    }
  }

  for (const gene of unresolved) {
    claims.push({
      section: 'clinician_rationale',
      text: gene.unresolvedWarning?.text ?? '',
      citationIds: gene.unresolvedWarning?.citationIds ?? [],
    })
  }

  for (const gene of facts.genes) {
    if (gene.confidence.level === 'high') continue
    for (const reason of gene.confidence.reasons) {
      claims.push({ section: 'clinician_rationale', text: reason.text, citationIds: reason.citationIds })
    }
  }

  return claims.filter((c) => c.text.trim().length > 0)
}

export function composeNarrative(facts: NarrativeFacts): Draft {
  return {
    generator: 'deterministic-template',
    model: 'offline composer (no model call)',
    claims: [
      ...journeyClaims(facts),
      ...phenoconversionClaims(facts),
      ...trialClaims(facts),
      ...whatNextClaims(facts),
      ...protocolClaims(facts),
      ...clinicianClaims(facts),
    ],
  }
}

/* ------------------------------------------------------------------ */
/* Adversarial probe                                                   */
/* ------------------------------------------------------------------ */

/**
 * Realistic model failure modes, submitted to the live validator.
 *
 * These are not strawmen. Each one is a thing language models actually do when asked to
 * write patient-facing medical copy: invent a plausible-sounding starting dose, reach for a
 * brand name that was never in the input, attach a citation that sounds right but was not
 * consulted, and state something clinical with no source at all because the sentence reads
 * more fluently that way.
 */
export function adversarialProbe(facts: NarrativeFacts): Draft {
  const top = facts.shortlist.filter((d) => !d.isCurrentMedication)[0]
  const drug = top?.drug ?? 'sertraline'

  const claims: DraftClaim[] = [
    {
      section: 'what_next',
      text:
        `Most people start ${drug} at 12.5 mg daily and increase to 175 mg over the first 9 days, which is ` +
        `where the majority of patients see a response.`,
      citationIds: ['cpic-2023-sri'],
    },
    {
      section: 'what_next',
      text:
        `Roughly 63% of patients with your metabolic profile respond well to this class within the first month.`,
      citationIds: ['cpic-2023-sri'],
    },
    {
      section: 'what_next',
      text:
        `If ${drug} does not suit you, lamotrigine is a reasonable next step and is often better tolerated.`,
      citationIds: ['cpic-2023-sri'],
    },
    {
      section: 'treatment_history',
      text:
        `Your results indicate a reduced ability to metabolise this class, so a lower dose should be used from ` +
        `the outset.`,
      citationIds: [],
    },
    {
      section: 'phenoconversion_explainer',
      text:
        `Patients in this situation are usually switched to a different antidepressant within two weeks of ` +
        `review, according to the 2019 CPIC opioid guideline.`,
      citationIds: ['cpic-2019-opioids'],
    },
  ]

  return {
    generator: 'recorded-model-run',
    model: 'recorded generation — offline demo probe',
    claims,
  }
}

/* ------------------------------------------------------------------ */

export type NarrativeFactsFrom = Pick<
  AnalysisResult,
  'genes' | 'shortlist' | 'history' | 'protocol' | 'input' | 'care' | 'depression'
>

export function factsFrom(result: NarrativeFactsFrom): NarrativeFacts {
  return {
    genes: result.genes,
    shortlist: result.shortlist,
    history: result.history,
    protocol: result.protocol,
    currentMedications: result.input.currentMedications,
    care: result.care,
    depression: result.depression,
  }
}
