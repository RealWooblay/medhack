/**
 * The pipeline.
 *
 * Deterministic steps produce every clinical fact in the result. The separate constrained
 * medical-model review receives a privacy-minimised view only after this function finishes;
 * it cannot change anything returned here.
 */

import { CITATIONS } from '../data/citations'
import { scoreGene } from './confidence'
import { normaliseCareContext, scoreDepressionCheckIn } from './depression'
import { reconstructTrials } from './history'
import { buildProtocol } from './lifestyle'
import { matchLifestyle } from './lifestyle-fit'
import { computePhenoconversion } from './phenoconversion'
import { assembleDrugFindings } from './ranking'
import type { GenomeInput, PharmCATAdapter } from './pharmcat/adapter'
import type {
  AnalysisResult,
  Citation,
  GenePhenotypeResult,
  PatientInput,
  TraceStep,
} from './types'

/* ------------------------------------------------------------------ */

function collectCitationIds(result: Omit<AnalysisResult, 'citations' | 'trace'>): string[] {
  const ids = new Set<string>()
  const add = (list: string[] | undefined) => list?.forEach((id) => ids.add(id))

  add(result.depression?.interpretation.citationIds)
  add(result.depression?.monitoringNote.citationIds)

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

/* ------------------------------------------------------------------ */

export interface AnalysisOptions {
  adapter: PharmCATAdapter
  genome: GenomeInput
  input: PatientInput
}

export async function runAnalysis({
  adapter,
  genome,
  input,
}: AnalysisOptions): Promise<AnalysisResult> {
  const trace: TraceStep[] = []
  const step = async <T>(name: string, detail: string, fn: () => T | Promise<T>) => {
    const started = performance.now()
    const value = await fn()
    trace.push({ step: name, detail, ms: Math.round((performance.now() - started) * 100) / 100 })
    return value
  }

  const care = normaliseCareContext(input.careContext)

  /* 1 — symptom baseline. It informs the journey, never the medication findings. */
  const depression = care.checkIn
    ? await step(
        'Score the depression check-in',
        'Score the complete PHQ-9 exactly as entered and keep it separate from medication selection.',
        () => scoreDepressionCheckIn(care),
      )
    : await step(
        'No depression check-in',
        'No PHQ-9 was supplied, so no symptom score or symptom result was created.',
        () => null,
      )

  /* 2 — imported or locally derived gene calls */
  const pharmcat = await step(
    'Read gene calls',
    `${adapter.name} — gene calls and matched CPIC annotations retain the PharmCAT software and data versions.`,
    () => adapter.analyze(genome),
  )

  /* 3 + 4 — phenoconversion and confidence limitations */
  const genes = await step(
    'Apply supported phenoconversion and record confidence limits',
    'Adjust a phenotype only where the captured method supports it, then label assay and call limitations without assigning a probability.',
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
          modeledFunctionalPhenotype: outcome.modeledFunctionalPhenotype,
          modeledFunctionalActivityScore: outcome.modeledFunctionalActivityScore,
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
    () => reconstructTrials(input.pastTrials, genes, pharmcat.recommendations),
  )

  /* 6 — alphabetical medication findings */
  const shortlist = await step(
    'Assemble medication-specific PGx findings',
    'Use exact matched PharmCAT CPIC annotations and keep PGx, confidence, current-medicine effects and treatment history separate.',
    () => assembleDrugFindings({
      genes,
      recommendations: pharmcat.recommendations,
      currentMedications: input.currentMedications,
      history,
    }),
  )

  /* 7 — lifestyle protocols */
  const protocolsByDrug = await step(
    'Build lifestyle protocols',
    'Fuse label-sourced timing, food and interaction rules for each candidate with the patient\'s other medications.',
    () =>
      Object.fromEntries(
        shortlist.map((d) => [d.drug, buildProtocol(d.drug, input.currentMedications)]),
      ),
  )

  const lifestyleMatches = await step(
    'Match options to daily life',
    'Compare the routine the person described with drug-specific, sourced protocol requirements without changing the PGx score.',
    () =>
      Object.fromEntries(
        Object.entries(protocolsByDrug).map(([drug, protocol]) => [
          drug,
          matchLifestyle(protocol, care, input.confirmedLifestyle ?? {}),
        ]),
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

  const citations: Record<string, Citation> = Object.fromEntries(
    collectCitationIds(partial).map((id) => [id, CITATIONS[id]]),
  )

  return { ...partial, citations, trace }
}
