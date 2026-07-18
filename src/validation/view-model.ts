import type {
  AnalysisResult,
  Citation,
  DrugAssessment,
  GenePhenotypeResult,
} from '../engine/types'

export interface ValidationCheck {
  id: string
  label: string
  passed: boolean
  detail: string
}

export interface SourceUsage {
  citation: Citation
  outputIds: string[]
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

export function sourceIdsForGene(gene: GenePhenotypeResult): string[] {
  return unique([
    ...(gene.explanation?.citationIds ?? []),
    ...(gene.unresolvedWarning?.citationIds ?? []),
    ...gene.modifiers.flatMap((modifier) => modifier.citationIds),
    ...gene.confidence.reasons.flatMap((reason) => reason.citationIds),
    'pharmcat',
  ])
}

export function sourceIdsForMedication(drug: DrugAssessment): string[] {
  return unique([
    ...drug.citationIds,
    ...drug.geneFindings.flatMap((finding) => finding.citationIds),
    ...drug.interactionFlags.flatMap((flag) => flag.citationIds),
    ...drug.confidenceCaveats.flatMap((caveat) => caveat.citationIds),
    ...drug.enzymeIndependence.flatMap((claim) => claim.citationIds),
    ...(drug.retryRationale?.citationIds ?? []),
  ])
}

export function buildSourceUsage(result: AnalysisResult): SourceUsage[] {
  const usage = new Map<string, Set<string>>()
  const add = (ids: string[], outputId: string) => {
    for (const id of ids) {
      if (!usage.has(id)) usage.set(id, new Set())
      usage.get(id)!.add(outputId)
    }
  }

  if (result.depression) {
    add(result.depression.interpretation.citationIds, 'OUT-PHQ9')
    add(result.depression.monitoringNote.citationIds, 'OUT-MONITORING')
  }

  for (const gene of result.genes) {
    add(sourceIdsForGene(gene), `OUT-GENE-${gene.gene}`)
  }

  for (const drug of result.shortlist) {
    const id = `OUT-MED-${drug.drug.toUpperCase()}`
    add(sourceIdsForMedication(drug), id)
    const protocol = result.protocolsByDrug[drug.drug]
    if (protocol) {
      add(
        [
          ...protocol.items.flatMap((item) => item.citationIds),
          ...protocol.interactionItems.flatMap((item) => item.citationIds),
        ],
        `OUT-LIFE-${drug.drug.toUpperCase()}`,
      )
    }
    const match = result.lifestyleMatches[drug.drug]
    if (match) {
      add(match.facts.flatMap((fact) => fact.citationIds), `OUT-LIFE-${drug.drug.toUpperCase()}`)
    }
  }

  for (const trial of result.history) {
    add(
      [
        ...(trial.mechanism?.citationIds ?? []),
        ...trial.supporting.flatMap((claim) => claim.citationIds),
      ],
      `OUT-HISTORY-${trial.drug.toUpperCase()}`,
    )
  }

  return Object.values(result.citations)
    .map((citation) => ({
      citation,
      outputIds: [...(usage.get(citation.id) ?? new Set(['Supporting evidence']))].sort(),
    }))
    .sort((a, b) => a.citation.id.localeCompare(b.citation.id))
}

export function buildValidationChecks(result: AnalysisResult): ValidationCheck[] {
  const knownSources = new Set(Object.keys(result.citations))
  const referencedSources = buildSourceUsage(result).map((entry) => entry.citation.id)
  const medicationSourcesResolve = result.shortlist.every((drug) => {
    const ids = sourceIdsForMedication(drug)
    const hasSourceBoundClaim =
      drug.geneFindings.length > 0 ||
      drug.interactionFlags.length > 0 ||
      drug.confidenceCaveats.length > 0 ||
      drug.enzymeIndependence.length > 0 ||
      drug.retryRationale !== null
    // A patient-entered medicine with no matched PharmCAT annotation is still shown so the
    // absence is explicit. That empty state is not a sourced clinical claim.
    return (!hasSourceBoundClaim && ids.length === 0) ||
      (ids.length > 0 && ids.every((id) => knownSources.has(id)))
  })
  const geneSourcesResolve = result.genes.every((gene) =>
    sourceIdsForGene(gene).every((id) => knownSources.has(id)),
  )

  return [
    {
      id: 'CHECK-RUN',
      label: 'Pipeline completed',
      passed: result.trace.length > 0,
      detail: `${result.trace.length} recorded processing steps returned a result.`,
    },
    {
      id: 'CHECK-INPUT',
      label: 'Input origin is explicit',
      passed: result.pharmcat.provenance === 'pharmcat-json',
      detail: `Gene-call origin: ${result.pharmcat.provenance}.`,
    },
    {
      id: 'CHECK-PHQ',
      label: 'Symptom input is explicit',
      passed: result.care.checkIn === null || result.care.checkIn.responses.length === 9,
      detail: result.care.checkIn === null
        ? 'No PHQ-9 was supplied; no symptom result was created.'
        : `${result.care.checkIn.responses.length} of 9 item values were supplied.`,
    },
    {
      id: 'CHECK-GENES',
      label: 'Gene outputs have source records',
      passed: result.genes.length > 0 && geneSourcesResolve,
      detail: `${result.genes.length} gene rows returned; each resolves to a registered source record.`,
    },
    {
      id: 'CHECK-MEDICATIONS',
      label: 'Medication outputs have source records',
      passed: medicationSourcesResolve,
      detail: `${result.shortlist.length} medication rows were checked without ranking them.`,
    },
    {
      id: 'CHECK-SOURCES',
      label: 'Displayed source IDs resolve',
      passed: referencedSources.every((id) => knownSources.has(id)),
      detail: `${knownSources.size} source records are included in this run.`,
    },
  ]
}
