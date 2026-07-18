/**
 * The pipeline.
 *
 * Seven deterministic steps produce every clinical fact in the report. Only then is a
 * narrative layer allowed to run, and only over facts that are already fixed. The `trace`
 * this returns is rendered in the UI, because "the model did not decide this" is a claim
 * that should be inspectable rather than asserted.
 */

import { CITATIONS } from '../data/citations'
import { profileOf } from '../data/cpic'
import { OfflineNarrativeProvider, type NarrativeProvider } from '../ai/provider'
import { scoreGene } from './confidence'
import { normaliseCareContext, scoreDepressionCheckIn } from './depression'
import { reconstructTrials } from './history'
import { buildProtocol } from './lifestyle'
import { matchLifestyle } from './lifestyle-fit'
import { adversarialProbe, composeNarrative, type NarrativeFacts } from './orchestrator'
import { computePhenoconversion } from './phenoconversion'
import { assembleDrugFindings } from './ranking'
import { buildAllowList, validateDraft } from './validator'
import type { GenomeInput, PharmCATAdapter } from './pharmcat/adapter'
import type {
  AnalysisResult,
  Citation,
  GenePhenotypeResult,
  PatientInput,
  TraceStep,
  ValidationReport,
} from './types'

/* ------------------------------------------------------------------ */

function collectCitationIds(result: Omit<AnalysisResult, 'narrative' | 'citations' | 'trace'>): string[] {
  const ids = new Set<string>()
  const add = (list: string[] | undefined) => list?.forEach((id) => ids.add(id))

  add(result.depression.interpretation.citationIds)
  add(result.depression.monitoringNote.citationIds)

  for (const gene of result.genes) {
    add(gene.explanation?.citationIds)
    add(gene.unresolvedWarning?.citationIds)
    gene.confidence.reasons.forEach((r) => add(r.citationIds))
    gene.modifiers.forEach((m) => add(m.citationIds))
  }
  result.excludedGenes.forEach((g) => add(g.rationale.citationIds))
  for (const drug of result.shortlist) {
    add(drug.citationIds)
    drug.geneFindings.forEach((f) => add(f.citationIds))
    drug.interactionFlags.forEach((f) => add(f.citationIds))
    drug.confidenceCaveats.forEach((c) => add(c.citationIds))
    drug.enzymeIndependence.forEach((c) => add(c.citationIds))
  }
  for (const trial of result.history) {
    add(trial.mechanism?.citationIds)
    trial.supporting.forEach((s) => add(s.citationIds))
  }
  for (const protocol of Object.values(result.protocolsByDrug)) {
    protocol.items.forEach((i) => add(i.citationIds))
    protocol.interactionItems.forEach((i) => add(i.citationIds))
  }
  for (const match of Object.values(result.lifestyleMatches)) {
    match.facts.forEach((fact) => add(fact.citationIds))
  }
  result.pharmcat.recommendations.forEach((r) => add(r.citationIds))

  const unknown = [...ids].filter((id) => !CITATIONS[id])
  if (unknown.length) {
    throw new Error(`Clinical output referenced unknown source id(s): ${unknown.join(', ')}`)
  }
  return [...ids]
}

/**
 * Merges the deterministic narrative (which supplies the rendered prose) with the
 * adversarial probe (which supplies the rejection log). Both were checked by the same
 * validator against the same allow-list.
 */
function mergeReports(rendered: ValidationReport, probe: ValidationReport): ValidationReport {
  return {
    ...rendered,
    rejections: [...rendered.rejections, ...probe.rejections],
    claimsChecked: rendered.claimsChecked + probe.claimsChecked,
    renderedRejectionCount: rendered.rejections.length,
    probeRejectionCount: probe.rejections.length,
    renderedClaimsChecked: rendered.claimsChecked,
    probeClaimsChecked: probe.claimsChecked,
  }
}

/* ------------------------------------------------------------------ */

export interface AnalysisOptions {
  adapter: PharmCATAdapter
  genome: GenomeInput
  input: PatientInput
  narrativeProvider?: NarrativeProvider
}

export async function runAnalysis({
  adapter,
  genome,
  input,
  narrativeProvider = new OfflineNarrativeProvider(),
}: AnalysisOptions): Promise<AnalysisResult> {
  const trace: TraceStep[] = []
  const step = async <T>(name: string, detail: string, kind: TraceStep['kind'], fn: () => T | Promise<T>) => {
    const started = performance.now()
    const value = await fn()
    trace.push({ step: name, detail, kind, ms: Math.round((performance.now() - started) * 100) / 100 })
    return value
  }

  const care = normaliseCareContext(input.careContext)

  /* 1 — symptom baseline. It informs the journey, never the medication findings. */
  const depression = await step(
    'Score the depression check-in',
    'Score the PHQ-9 exactly as entered and keep it separate from medication selection.',
    'deterministic',
    () => scoreDepressionCheckIn(care),
  )

  /* 2 — imported or locally derived gene calls */
  const pharmcat = await step(
    'Read gene calls',
    `${adapter.name} — gene-call origin is preserved; medication rules are applied later from the local evidence table.`,
    'deterministic',
    () => adapter.analyze(genome),
  )

  /* 3 + 4 — phenoconversion and confidence limitations */
  const genes = await step(
    'Apply supported phenoconversion and record confidence limits',
    'Adjust a phenotype only where the captured method supports it, then label assay and call limitations without assigning a probability.',
    'deterministic',
    (): GenePhenotypeResult[] =>
      pharmcat.genes.map((gene) => {
        const outcome = computePhenoconversion(gene, input.currentMedications)
        return {
          gene: gene.gene,
          diplotype: gene.diplotype,
          geneticPhenotype: gene.phenotype,
          functionalPhenotype: outcome.functionalPhenotype,
          geneticActivityScore: gene.activityScore,
          functionalActivityScore: outcome.functionalActivityScore,
          converted: outcome.converted,
          status: outcome.status,
          modifiers: outcome.modifiers,
          explanation: outcome.explanation,
          unresolvedWarning: outcome.unresolvedWarning,
          confidence: scoreGene(gene, pharmcat.assayType),
        }
      }),
  )

  /* 5 — treatment history */
  const history = await step(
    'Place PGx beside past trials',
    'Show whether a CPIC-covered gene–drug result raises a dosing question, without assigning a cause to the recorded outcome.',
    'deterministic',
    () => reconstructTrials(input.pastTrials, genes, profileOf),
  )

  /* 6 — alphabetical medication findings */
  const shortlist = await step(
    'Assemble medication-specific PGx findings',
    'Query the captured guideline table for every candidate and keep PGx, confidence, interactions and treatment history visible as separate components.',
    'deterministic',
    () => assembleDrugFindings({ genes, currentMedications: input.currentMedications, history }),
  )

  /* 7 — lifestyle protocols */
  const protocolsByDrug = await step(
    'Build lifestyle protocols',
    'Fuse label-sourced timing, food and interaction rules for each candidate with the patient\'s other medications.',
    'deterministic',
    () =>
      Object.fromEntries(
        shortlist.map((d) => [d.drug, buildProtocol(d.drug, input.currentMedications)]),
      ),
  )

  const lifestyleMatches = await step(
    'Match options to daily life',
    'Compare the routine the person described with drug-specific, sourced protocol requirements without changing the PGx score.',
    'deterministic',
    () =>
      Object.fromEntries(
        Object.entries(protocolsByDrug).map(([drug, protocol]) => [drug, matchLifestyle(protocol, care)]),
      ),
  )

  const defaultViewedDrug = shortlist
    .filter((drug) => !drug.isCurrentMedication)
    .map((drug) => drug.drug)
    .sort((a, b) => a.localeCompare(b))[0]
  const protocol = defaultViewedDrug ? protocolsByDrug[defaultViewedDrug] : null

  const partial = {
    input,
    care,
    depression,
    pharmcat,
    genes,
    excludedGenes: pharmcat.excludedGenes,
    shortlist,
    history,
    protocol,
    protocolsByDrug,
    lifestyleMatches,
  }

  /* 7 — narrative, the only model-touched step */
  const facts: NarrativeFacts = {
    genes,
    shortlist,
    history,
    protocol,
    currentMedications: input.currentMedications,
    care,
    depression,
  }

  const drafts = await step(
    'Draft the explanation',
    `${narrativeProvider.name} composes the patient and clinician narrative over fixed facts. No new clinical content may enter here.`,
    narrativeProvider.mode === 'ai' ? 'model' : 'deterministic',
    async () => {
      try {
        return { rendered: await narrativeProvider.compose(facts), probe: adversarialProbe(facts) }
      } catch (error) {
        const rendered = composeNarrative(facts)
        rendered.model = `${rendered.model}; AI fallback (${error instanceof Error ? error.message : 'provider error'})`
        return { rendered, probe: adversarialProbe(facts) }
      }
    },
  )

  /* 8 — the claim boundary */
  const narrative = await step(
    'Validate every sentence',
    'Reject any sentence containing a number, drug name or citation that is not present in the structured clinical input.',
    'validator',
    () => {
      const citationIds = collectCitationIds(partial)
      const allow = buildAllowList({
        facts: partial,
        citationIds,
        derivedCounts: [
          input.pastTrials.length,
          input.currentMedications.length,
          shortlist.length,
          genes.length,
        ],
      })
      return mergeReports(validateDraft(drafts.rendered, allow), validateDraft(drafts.probe, allow))
    },
  )

  const citations: Record<string, Citation> = Object.fromEntries(
    collectCitationIds(partial).map((id) => [id, CITATIONS[id]]),
  )

  return { ...partial, narrative, citations, trace }
}
