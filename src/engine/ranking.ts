/**
 * Extension 2 — the inverted query.
 *
 * PharmCAT answers "is drug X safe for this genotype?". A prescriber sitting with a
 * patient is asking the other question: "given everything I know about this person, what
 * should I give them?" This module answers that one, over the whole candidate set at once.
 *
 * Two design decisions carry most of the value:
 *
 *  1. Ranking runs on the FUNCTIONAL phenotype, not the genetic one. Tolerability in the
 *     first weeks is what decides whether a patient stays on a drug, and in those weeks the
 *     interacting medication is still on board.
 *
 *  2. Every row also carries its post-washout verdict. A drug can be a poor choice to start
 *     today and a good choice in six weeks, and collapsing that into a single traffic light
 *     would hide the most actionable thing in the report.
 */

import { lookupRecommendation, profileOf, SHORTLIST_CANDIDATES, type DrugProfile } from '../data/cpic'
import { canonicalDrug } from '../data/drug-lexicon'
import { persistenceFor, relationshipBetween } from '../data/pharmacology'
import { effectsOfDrug } from '../data/interactions'
import { rankingWeight } from './confidence'
import type {
  Claim,
  DrugAssessment,
  GeneFinding,
  GenePhenotypeResult,
  InteractionFlag,
  Phenotype,
  RecommendationAction,
  ScoreComponent,
  TrialReconstruction,
  Verdict,
} from './types'

/* ------------------------------------------------------------------ */
/* Action semantics                                                    */
/* ------------------------------------------------------------------ */

/**
 * Worst first. Used to reduce several gene findings to one verdict.
 *
 * The two `standard_start_*` actions sit near the mild end deliberately: both begin from
 * the ordinary starting dose, so neither is a barrier to starting the drug.
 */
const ACTION_SEVERITY: RecommendationAction[] = [
  'avoid', 'alternative', 'decrease_start', 'decrease', 'caution', 'increase',
  'standard_start_reduced_maintenance', 'standard_start_conditional_increase',
  'no_recommendation', 'standard',
]

function worstAction(actions: RecommendationAction[]): RecommendationAction | null {
  for (const a of ACTION_SEVERITY) if (actions.includes(a)) return a
  return null
}

function verdictFor(findings: GeneFinding[], _cpicCovered: boolean): Verdict {
  if (!findings.length) return 'insufficient_evidence'
  const worst = worstAction(findings.map((f) => f.action))
  if (!worst) return 'insufficient_evidence'

  switch (worst) {
    case 'avoid':
    case 'alternative':
      return 'avoid'
    case 'decrease_start':
    case 'decrease':
    case 'caution':
    case 'increase':
      return 'caution'
    case 'standard_start_reduced_maintenance':
    case 'standard_start_conditional_increase':
    case 'standard':
      return 'preferred'
    case 'no_recommendation':
      return findings.some((f) => f.action === 'standard') ? 'preferred' : 'insufficient_evidence'
  }
}

function headlineFor(findings: GeneFinding[], cpicCovered: boolean): string {
  if (!findings.length) return cpicCovered ? 'no guideline recommendation' : 'no CPIC recommendation'
  const worst = worstAction(findings.map((f) => f.action))
  switch (worst) {
    case 'avoid':
      return 'avoid'
    case 'alternative':
      return 'consider an alternative'
    case 'decrease_start':
      return 'lower starting dose, slower titration'
    case 'decrease':
      return 'reduce starting and maintenance dose'
    case 'increase':
      return 'may need a higher maintenance dose'
    case 'caution':
      return 'use with caution'
    case 'standard_start_reduced_maintenance':
      return 'usual starting dose, slower titration and lower maintenance dose'
    case 'standard_start_conditional_increase':
      return 'usual starting dose, may need more later'
    case 'standard':
      return 'standard dosing'
    default:
      return 'no guideline recommendation'
  }
}

/* ------------------------------------------------------------------ */
/* Gene findings                                                       */
/* ------------------------------------------------------------------ */

function findingsFor(
  profile: DrugProfile,
  genes: GenePhenotypeResult[],
  usePhenotype: (g: GenePhenotypeResult) => Phenotype,
): GeneFinding[] {
  const findings: GeneFinding[] = []
  for (const geneName of profile.primaryGenes) {
    const gene = genes.find((g) => g.gene === geneName)
    if (!gene) continue
    const phenotype = usePhenotype(gene)
    const rec = lookupRecommendation(geneName, phenotype, profile.drug)
    if (!rec) continue
    findings.push({
      gene: geneName,
      phenotypeUsed: phenotype,
      usedFunctionalPhenotype: phenotype !== gene.geneticPhenotype,
      action: rec.action,
      guidelineText: rec.text,
      strength: rec.strength,
      citationIds: rec.citationIds,
    })
  }
  return findings
}

/* ------------------------------------------------------------------ */
/* Enzyme independence — why a drug sidesteps the problem              */
/* ------------------------------------------------------------------ */

function enzymeIndependenceFor(profile: DrugProfile, genes: GenePhenotypeResult[]): Claim[] {
  const claims: Claim[] = []
  for (const gene of genes) {
    const isPrimary = profile.primaryGenes.includes(gene.gene)
    if (isPrimary) continue

    if (gene.converted) {
      claims.push({
        text:
          `${gene.gene} is functionally a ${gene.functionalPhenotype} for this patient, but ${profile.drug} ` +
          `dosing is not governed by ${gene.gene}. ${profile.metabolicNote}`,
        citationIds: profile.citationIds,
      })
    } else if (gene.status === 'unvalidated_method') {
      claims.push({
        text:
          `An inhibitor of ${gene.gene} is on board and its effect on this patient cannot be quantified from ` +
          `any validated method, but ${profile.drug} dosing is not governed by ${gene.gene} — so that ` +
          `unresolved uncertainty does not propagate into this recommendation.`,
        citationIds: profile.citationIds,
      })
    } else if (gene.confidence.level === 'low') {
      claims.push({
        text:
          `The ${gene.gene} call for this patient is low confidence, and ${profile.drug} dosing does not ` +
          `depend on it — so an incorrect ${gene.gene} phenotype would not change this recommendation.`,
        citationIds: profile.citationIds,
      })
    }
  }
  return claims
}

/* ------------------------------------------------------------------ */
/* Interaction flags                                                   */
/* ------------------------------------------------------------------ */

const MAOIS = ['phenelzine', 'tranylcypromine', 'isocarboxazid', 'selegiline']
const SEROTONERGIC_RISK = ['tramadol', 'linezolid', "St John's Wort", 'sumatriptan', 'rizatriptan', 'dextromethorphan']

function interactionFlagsFor(
  profile: DrugProfile,
  currentMedications: string[],
  genes: GenePhenotypeResult[],
): InteractionFlag[] {
  const flags: InteractionFlag[] = []
  const meds = currentMedications.map((m) => canonicalDrug(m) ?? m)

  // Absolute contraindication.
  for (const med of meds) {
    if (MAOIS.includes(med)) {
      flags.push({
        withDrug: med,
        severity: 'critical',
        text:
          `${med} is a monoamine oxidase inhibitor. Combining it with ${profile.drug} risks serotonin ` +
          `syndrome, and a full washout period is required between the two.`,
        citationIds: ['cpic-2023-sri'],
      })
    } else if (SEROTONERGIC_RISK.includes(med)) {
      flags.push({
        withDrug: med,
        severity: 'caution',
        text:
          `${med} adds serotonergic activity on top of ${profile.drug}. The combination is often manageable ` +
          `but should be flagged to the prescriber.`,
        citationIds: ['cpic-2023-sri'],
      })
    }
  }

  // The candidate is dosed on a gene whose interaction the engine refused to resolve.
  for (const gene of genes) {
    if (gene.status !== 'unvalidated_method') continue
    if (!profile.primaryGenes.includes(gene.gene)) continue
    const inhibitor = gene.modifiers[0]
    flags.push({
      withDrug: inhibitor?.drug ?? 'a current medication',
      severity: 'caution',
      text:
        `${profile.drug} is dosed on ${gene.gene}, and ${inhibitor?.drug ?? 'a current medication'} inhibits ` +
        `${gene.gene}. True ${gene.gene} activity is therefore likely lower than the reported ${gene.geneticPhenotype} ` +
        `phenotype, but no validated method exists to quantify by how much, so this needs prescriber judgement ` +
        `rather than a calculated dose.`,
      citationIds: ['cpic-2023-sri', 'fda-interaction-table'],
    })
  }

  // The candidate would itself keep an already-compromised enzyme suppressed.
  for (const { enzyme, effect } of effectsOfDrug(profile.drug)) {
    if (effect !== 'strong_inhibitor') continue
    const gene = genes.find((g) => g.gene === enzyme)
    if (!gene) continue
    flags.push({
      withDrug: profile.drug,
      severity: 'caution',
      text:
        `${profile.drug} is itself a strong ${enzyme} inhibitor. Starting it would hold ${enzyme} in a ` +
        `functionally poor-metaboliser state rather than allowing it to recover, which matters for any other ` +
        `${enzyme} substrate the patient takes.`,
      citationIds: ['fda-interaction-table'],
    })
  }

  return flags
}

/* ------------------------------------------------------------------ */
/* Washout                                                             */
/* ------------------------------------------------------------------ */

/**
 * The insight no genotype-only tool models: inhibition does not stop when the tablet does.
 */
function washoutNoteFor(
  profile: DrugProfile,
  genes: GenePhenotypeResult[],
): Claim | null {
  for (const gene of genes) {
    if (!gene.converted) continue
    if (!profile.primaryGenes.includes(gene.gene)) continue
    for (const modifier of gene.modifiers) {
      const persistence = persistenceFor(modifier.drug)
      if (!persistence) continue
      return {
        text:
          `${persistence.note} For ${profile.drug}, which is dosed on ${gene.gene}, that means the ` +
          `functional ${gene.functionalPhenotype} state persists for roughly ${persistence.washoutDaysLow} to ` +
          `${persistence.washoutDaysHigh} days after the last ${modifier.drug} dose. A cross-taper planned as ` +
          `though the interaction ends with the last tablet will misjudge the dose.`,
        citationIds: [...persistence.citationIds, ...modifier.citationIds],
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Treatment history — is this worth a second look?                    */
/* ------------------------------------------------------------------ */

/** One step less encouraging. Never promotes. */
function demote(verdict: Verdict): Verdict {
  if (verdict === 'preferred') return 'caution'
  return verdict
}

interface RetryOutcome {
  verdict: Verdict
  retryRationale: Claim | null
  penalty: ScoreComponent | null
}

function assessRetry(
  drug: string,
  verdict: Verdict,
  pastTrial: TrialReconstruction | null,
  history: TrialReconstruction[],
): RetryOutcome {
  // 1. The patient has taken this exact drug before.
  if (pastTrial && pastTrial.outcome !== 'helped') {
    if (pastTrial.explanation === 'consistent') {
      return {
        verdict,
        retryRationale: {
          text:
            `You have taken ${drug} before and it ${pastTrial.outcome === 'side_effects' ? 'caused side effects' : 'did not help'}. ` +
            `That is worth raising rather than closing off, because there is an identifiable metabolic ` +
            `reason for what happened and it is the kind of reason a dose change can address. A drug ` +
            `written off as a failure at the wrong dose is not the same as a drug that does not work for you.`,
          citationIds: pastTrial.mechanism?.citationIds ?? ['cpic-2023-sri'],
        },
        penalty: null,
      }
    }
    return {
      verdict: demote(verdict),
      retryRationale: {
        text:
          `You have taken ${drug} before without benefit, and nothing in your metabolism explains why. ` +
          `With no dosing reason to expect a different outcome, it sits below options you have not yet tried.`,
        citationIds: ['cpic-2023-sri'],
      },
      penalty: null,
    }
  }

  // 2. The patient has failed something pharmacologically equivalent.
  for (const trial of history) {
    if (trial.outcome === 'helped') continue
    const relationship = relationshipBetween(drug, trial.drug)
    if (!relationship) continue
    return {
      verdict: demote(verdict),
      retryRationale: {
        text: `${relationship.relationship} You have already tried ${trial.drug} without benefit.`,
        citationIds: relationship.citationIds,
      },
      penalty: {
        label: `Equivalent to ${trial.drug}, already tried`,
        delta: -22,
        detail: relationship.relationship,
      },
    }
  }

  return { verdict, retryRationale: null, penalty: null }
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

const ACTION_POINTS: Record<RecommendationAction, number> = {
  standard: 18,
  standard_start_reduced_maintenance: 10,
  standard_start_conditional_increase: 8,
  increase: -8,
  decrease: -16,
  decrease_start: -14,
  caution: -12,
  alternative: -40,
  avoid: -50,
  no_recommendation: -2,
}

const OUTCOME_POINTS: Record<TrialReconstruction['outcome'], number> = {
  helped: 35,
  no_effect: -25,
  side_effects: -28,
  stopped_other: -5,
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface RankingInput {
  genes: GenePhenotypeResult[]
  currentMedications: string[]
  history: TrialReconstruction[]
}

export function rankDrugs({ genes, currentMedications, history }: RankingInput): DrugAssessment[] {
  const meds = currentMedications.map((m) => (canonicalDrug(m) ?? m).toLowerCase())
  const anyConverted = genes.some((g) => g.converted)

  const assessments: DrugAssessment[] = []

  for (const drug of SHORTLIST_CANDIDATES) {
    const profile = profileOf(drug)
    if (!profile) continue

    const findings = findingsFor(profile, genes, (g) => g.functionalPhenotype)
    const geneticFindings = findingsFor(profile, genes, (g) => g.geneticPhenotype)

    const baseVerdict = verdictFor(findings, profile.cpicCovered)
    const headline = headlineFor(findings, profile.cpicCovered)
    const independence = enzymeIndependenceFor(profile, genes)
    const flags = interactionFlagsFor(profile, meds, genes)
    const washout = washoutNoteFor(profile, genes)
    const pastTrial = history.find((h) => h.drug.toLowerCase() === drug.toLowerCase()) ?? null
    const isCurrent = meds.includes(drug.toLowerCase())
    const retry = assessRetry(drug, baseVerdict, pastTrial, history)
    const verdict = retry.verdict

    /* -- score -- */
    const breakdown: ScoreComponent[] = [{ label: 'Base', delta: 50, detail: 'Every candidate starts level.' }]

    for (const finding of findings) {
      const gene = genes.find((g) => g.gene === finding.gene)!
      const weight = rankingWeight(gene.confidence)
      const delta = Math.round(ACTION_POINTS[finding.action] * weight)
      breakdown.push({
        label: `${finding.gene} ${finding.phenotypeUsed}`,
        delta,
        detail:
          `CPIC action "${finding.action}" for ${drug}, weighted by ${finding.gene} call confidence ` +
          `(${gene.confidence.level}, ${gene.confidence.score}).`,
      })
    }

    for (const claim of independence) {
      breakdown.push({
        label: 'Sidesteps a compromised enzyme',
        delta: 12,
        detail: claim.text.slice(0, 160),
      })
    }

    if (!profile.cpicCovered) {
      breakdown.push({
        label: 'No CPIC recommendation',
        delta: -14,
        detail: 'Guideline-backed options are preferred over options with no dosing guidance.',
      })
    }

    if (pastTrial) {
      breakdown.push({
        label: `Previously tried — ${pastTrial.outcome.replace('_', ' ')}`,
        delta: OUTCOME_POINTS[pastTrial.outcome],
        detail: pastTrial.patientSummary.slice(0, 160),
      })
    }

    for (const flag of flags) {
      breakdown.push({
        label: `Interaction with ${flag.withDrug}`,
        delta: flag.severity === 'critical' ? -60 : flag.severity === 'caution' ? -12 : 0,
        detail: flag.text.slice(0, 160),
      })
    }

    if (retry.penalty) breakdown.push(retry.penalty)

    if (isCurrent) {
      breakdown.push({
        label: 'Currently taking',
        delta: -20,
        detail: 'Already in use, so it is not a candidate for a switch — shown for context.',
      })
    }

    const score = breakdown.reduce((sum, c) => sum + c.delta, 0)

    /* -- post-washout second state -- */
    let postWashoutVerdict: Verdict | null = null
    let postWashoutHeadline: string | null = null
    if (anyConverted && geneticFindings.length) {
      const gv = verdictFor(geneticFindings, profile.cpicCovered)
      if (gv !== verdict) {
        postWashoutVerdict = gv
        postWashoutHeadline = headlineFor(geneticFindings, profile.cpicCovered)
      }
    }

    /* -- reason line -- */
    const reasonParts: string[] = []
    if (findings.length) {
      reasonParts.push(
        findings
          .map((f) => `${f.gene} ${f.phenotypeUsed.replace(' Metabolizer', '')}${f.usedFunctionalPhenotype ? ' (functional)' : ''}`)
          .join(', '),
      )
    }
    if (independence.length && !findings.some((f) => f.action === 'avoid' || f.action === 'alternative')) {
      const sidestepped = genes.filter((g) => g.converted && !profile.primaryGenes.includes(g.gene)).map((g) => g.gene)
      if (sidestepped.length) reasonParts.push(`not ${sidestepped.join('/')}-dependent`)
    }
    if (!profile.cpicCovered) reasonParts.push('outside CPIC scope')

    assessments.push({
      drug,
      drugClass: profile.drugClass,
      verdict,
      headline,
      reason: reasonParts.join(' · ') || profile.metabolicNote.slice(0, 80),
      geneFindings: findings,
      interactionFlags: flags,
      confidenceCaveats: genes
        .filter((g) => profile.primaryGenes.includes(g.gene) && g.confidence.level !== 'high')
        .flatMap((g) => g.confidence.reasons),
      enzymeIndependence: independence,
      pastTrial,
      retryRationale: retry.retryRationale,
      isCurrentMedication: isCurrent,
      postWashoutVerdict,
      postWashoutHeadline,
      washoutNote: washout,
      score,
      scoreBreakdown: breakdown,
      citationIds: [
        ...new Set([...findings.flatMap((f) => f.citationIds), ...profile.citationIds]),
      ],
    })
  }

  const VERDICT_ORDER: Record<Verdict, number> = {
    preferred: 0,
    caution: 1,
    insufficient_evidence: 2,
    avoid: 3,
  }

  return assessments.sort((a, b) => {
    if (a.isCurrentMedication !== b.isCurrentMedication) return a.isCurrentMedication ? 1 : -1
    if (VERDICT_ORDER[a.verdict] !== VERDICT_ORDER[b.verdict]) return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
    return b.score - a.score
  })
}
