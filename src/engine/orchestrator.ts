/**
 * The orchestration layer — the only place a language model is allowed to touch anything.
 *
 * What the model is for: sequencing, cross-referencing, and translating clinician language
 * into something a person can act on at 8am with a glass of water. What it is not for:
 * producing a dose, a drug name, or a clinical fact. Those arrive already decided, from the
 * guideline lookup, and the model's output is checked against them before it renders.
 *
 * Offline mode, which is the default, produces the narrative deterministically from the
 * same fact objects a model would be handed. That prose still passes through the validator —
 * the boundary is wired in whether or not a model is present, and a template that quietly
 * bypassed the check would make the whole architecture decorative.
 *
 * Alongside it, `adversarialProbe` submits realistic model failure modes — invented doses,
 * a brand name nobody mentioned, a citation that drifted, a bare clinical assertion with no
 * source — to the same validator. Those are what populate the rejection log. They are
 * labelled in the UI as exactly what they are: a deliberate probe, not a real generation.
 */

import type {
  AnalysisResult,
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
}

/* ------------------------------------------------------------------ */
/* Deterministic composition                                           */
/* ------------------------------------------------------------------ */

/** Sentence-initial capitalisation for generic drug names, which are stored lowercase. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

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
  const ordered = [...facts.genes].sort((a, b) => Number(b.converted) - Number(a.converted))

  for (const gene of ordered) {
    const cause = gene.modifiers[0]

    if (gene.converted && gene.explanation && cause) {
      claims.push({
        section: 'phenoconversion_explainer',
        text:
          `Your ${gene.gene} genes are perfectly ordinary. What changes the picture is ${cause.drug}, ` +
          `which you are taking now — it is a strong blocker of ${gene.gene}, so for as long as you are on ` +
          `it your body handles these medicines as though that enzyme were barely working. That is not a ` +
          `problem with you, and it reverses once ${cause.drug} is out of your system.`,
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
        `Nothing you currently take interferes with the enzymes that clear antidepressants, so how your ` +
        `body handles them today matches what your genes predict.`,
      citationIds: ['fda-interaction-table'],
    })
  }

  return claims
}

function trialClaims(facts: NarrativeFacts): DraftClaim[] {
  return facts.history.map((trial) => ({
    section: 'why_trials_failed' as const,
    text: trial.patientSummary,
    citationIds: trial.mechanism?.citationIds ?? ['cpic-2023-sri'],
  }))
}

function whatNextClaims(facts: NarrativeFacts): DraftClaim[] {
  const top = facts.shortlist.filter((d) => !d.isCurrentMedication)[0]
  if (!top) return []

  const claims: DraftClaim[] = [
    {
      section: 'what_next',
      text:
        `Taking your metabolism and your past attempts together, ${top.drug} is the option that fits you ` +
        `best on the evidence available. This is something to take to your prescriber, not a prescription — ` +
        `the decision is theirs and yours together.`,
      citationIds: top.citationIds,
    },
  ]

  // Why it works, in plain terms: the blocked enzyme is not the one that clears it.
  const blocked = facts.genes.find((g) => g.converted)
  if (blocked && top.enzymeIndependence.length) {
    claims.push({
      section: 'what_next',
      text:
        `The reason it suits you is specific rather than generic: ${top.drug} is not cleared by ` +
        `${blocked.gene}, the enzyme that ${blocked.modifiers[0]?.drug ?? 'your current medication'} has ` +
        `switched off. The problem that rules out several of the other options simply does not apply to it.`,
      citationIds: top.enzymeIndependence[0].citationIds,
    })
  }

  // The washout, which is the part people get wrong.
  if (top.washoutNote) {
    const cause = blocked?.modifiers[0]?.drug
    claims.push({
      section: 'what_next',
      text:
        `One thing worth raising explicitly: ${cause ?? 'the medicine you are on'} does not leave your ` +
        `system the day you stop taking it, and neither does its effect on your enzymes. Ask your ` +
        `prescriber how they want to handle the overlap, because the timing of a switch changes what dose ` +
        `is right at the start.`,
      citationIds: top.washoutNote.citationIds,
    })
  }

  // The ones to be careful with, gathered into a single sentence.
  const avoided = facts.shortlist.filter((d) => d.verdict === 'avoid')
  if (avoided.length) {
    const names = avoided.map((d) => d.drug)
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
    const finding = avoided[0].geneFindings[0]
    claims.push({
      section: 'what_next',
      text:
        `The ${names.length > 1 ? 'ones' : 'one'} to be most careful with ${names.length > 1 ? 'are' : 'is'} ` +
        `${list}. These lean on ${finding?.gene ?? 'the affected enzyme'} to be cleared, and with that enzyme ` +
        `effectively switched off the guidance is to pick something else rather than try to adjust the dose ` +
        `around it.`,
      citationIds: finding?.citationIds ?? top.citationIds,
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
        `Here is what taking ${facts.protocol.drug} actually looks like day to day. Every line comes from the ` +
        `approved product label or a named clinical source, and you can open any of them to see where it came from.`,
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
      section: 'why_trials_failed',
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
  'genes' | 'shortlist' | 'history' | 'protocol' | 'input'
>

export function factsFrom(result: NarrativeFactsFrom): NarrativeFacts {
  return {
    genes: result.genes,
    shortlist: result.shortlist,
    history: result.history,
    protocol: result.protocol,
    currentMedications: result.input.currentMedications,
  }
}
