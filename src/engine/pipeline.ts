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
import { scoreGene } from './confidence'
import { reconstructTrials } from './history'
import { buildProtocol } from './lifestyle'
import { adversarialProbe, composeNarrative, type NarrativeFacts } from './orchestrator'
import { computePhenoconversion } from './phenoconversion'
import { rankDrugs } from './ranking'
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
    add(drug.washoutNote?.citationIds)
  }
  for (const trial of result.history) {
    add(trial.mechanism?.citationIds)
    trial.supporting.forEach((s) => add(s.citationIds))
  }
  for (const protocol of Object.values(result.protocolsByDrug)) {
    protocol.items.forEach((i) => add(i.citationIds))
    protocol.interactionItems.forEach((i) => add(i.citationIds))
  }
  result.pharmcat.recommendations.forEach((r) => add(r.citationIds))

  return [...ids].filter((id) => Boolean(CITATIONS[id]))
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
  }
}

/* ------------------------------------------------------------------ */

export interface AnalysisOptions {
  adapter: PharmCATAdapter
  genome: GenomeInput
  input: PatientInput
}

export async function runAnalysis({ adapter, genome, input }: AnalysisOptions): Promise<AnalysisResult> {
  const trace: TraceStep[] = []
  const step = async <T>(name: string, detail: string, kind: TraceStep['kind'], fn: () => T | Promise<T>) => {
    const started = performance.now()
    const value = await fn()
    trace.push({ step: name, detail, kind, ms: Math.round((performance.now() - started) * 100) / 100 })
    return value
  }

  /* 1 — star alleles and phenotypes */
  const pharmcat = await step(
    'Call star alleles',
    `${adapter.name} — diplotypes and phenotypes for CYP2D6, CYP2C19 and CYP2B6.`,
    'deterministic',
    () => adapter.analyze(genome),
  )

  /* 2 + 3 — phenoconversion and confidence */
  const genes = await step(
    'Apply phenoconversion and score confidence',
    'Adjust each phenotype for concurrent inhibitors where a validated method exists, and score how far each gene call can be trusted.',
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

  /* 4 — treatment history */
  const history = await step(
    'Reconstruct past trials',
    'Test whether each previous outcome is consistent with this metabolism, and record honestly where it is not.',
    'deterministic',
    () => reconstructTrials(input.pastTrials, genes, profileOf),
  )

  /* 5 — ranked shortlist */
  const shortlist = await step(
    'Rank the candidate drugs',
    'Query the guideline table for every candidate using the functional phenotype, then rank on guideline action, call confidence, interactions and treatment history.',
    'deterministic',
    () => rankDrugs({ genes, currentMedications: input.currentMedications, history }),
  )

  /* 6 — lifestyle protocols */
  const protocolsByDrug = await step(
    'Build lifestyle protocols',
    'Fuse label-sourced timing, food and interaction rules for each candidate with the patient\'s other medications.',
    'deterministic',
    () =>
      Object.fromEntries(
        shortlist.map((d) => [d.drug, buildProtocol(d.drug, input.currentMedications)]),
      ),
  )

  const topChoice = shortlist.find((d) => !d.isCurrentMedication) ?? shortlist[0] ?? null
  const protocol = topChoice ? protocolsByDrug[topChoice.drug] : null

  const partial = {
    input,
    pharmcat,
    genes,
    excludedGenes: pharmcat.excludedGenes,
    shortlist,
    history,
    protocol,
    protocolsByDrug,
  }

  /* 7 — narrative, the only model-touched step */
  const facts: NarrativeFacts = {
    genes,
    shortlist,
    history,
    protocol,
    currentMedications: input.currentMedications,
  }

  const drafts = await step(
    'Draft the explanation',
    'Compose the patient and clinician narrative over the fixed facts. No new clinical content may enter here.',
    'model',
    () => ({ rendered: composeNarrative(facts), probe: adversarialProbe(facts) }),
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
