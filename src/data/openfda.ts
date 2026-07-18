/**
 * Versioned prescribing-information evidence.
 *
 * The runtime never queries openFDA and never cites a floating `generic_name&limit=1`
 * result. Each record is pinned to one SPL set_id and version id. Only exact evidence
 * phrases reviewed for a lifestyle rule enter the browser bundle. Refreshing the snapshot
 * is an explicit operation performed by `scripts/sync-clinical-sources.mjs`; that script
 * fails if a reviewed phrase is no longer present in its pinned source record.
 */

import source from './sources/fda-labels.json'
import { registerLabelCitation } from './citations'

export interface LabelEvidence {
  sourceField: string
  exactText: string[]
}

export interface LabelRecord {
  generic: string
  setId: string
  versionId: string
  effectiveTime: string | null
  openFdaApiCurrentAsOf: string | null
  manufacturer: string | null
  productName: string | null
  dosageForm: string
  productNdc: string
  route: string[]
  productType: string | null
  applicationNumber: string | null
  sourceUrl: string
  apiUrl: string
  ndcApiUrl: string
  evidence: Record<string, LabelEvidence>
  sourceDigestSha256: string
}

interface LabelSource {
  schemaVersion: number
  authority: string
  selectionPolicy: string
  labels: LabelRecord[]
}

const snapshot = source as unknown as LabelSource

if (snapshot.schemaVersion !== 1) {
  throw new Error(`Unsupported FDA label evidence schema: ${snapshot.schemaVersion}`)
}

export const LABELS: Record<string, LabelRecord> = Object.fromEntries(
  snapshot.labels.map((label) => [label.generic.toLowerCase(), label]),
)

export const FDA_LABEL_SOURCE = {
  authority: snapshot.authority,
  selectionPolicy: snapshot.selectionPolicy,
  recordCount: snapshot.labels.length,
} as const

function humanDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) return 'revision date not reported'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

for (const label of snapshot.labels) {
  if (!/^[0-9a-f-]{36}$/i.test(label.setId) || !/^[0-9a-f-]{36}$/i.test(label.versionId)) {
    throw new Error(`Unpinned FDA label evidence record: ${label.generic}`)
  }
  if (!/^[0-9a-f]{64}$/i.test(label.sourceDigestSha256)) {
    throw new Error(`FDA label evidence record has no valid digest: ${label.generic}`)
  }

  for (const [evidenceId, evidence] of Object.entries(label.evidence)) {
    if (!evidence.sourceField || !evidence.exactText.length || evidence.exactText.some((text) => !text.trim())) {
      throw new Error(`Incomplete FDA label evidence: ${evidenceId}`)
    }
    registerLabelCitation({
      id: labelEvidenceCitationId(evidenceId),
      label: `US label · ${humanDate(label.effectiveTime)}`,
      kind: 'fda-label',
      title:
        `${label.productName ?? label.generic} — ${label.dosageForm}; NDC ${label.productNdc}; ` +
        `${label.manufacturer ?? 'manufacturer not reported'}; ` +
        `SPL set ${label.setId}, version ${label.versionId}, field ${evidence.sourceField}. ` +
        `Exact evidence: “${evidence.exactText.join(' … ')}”`,
      url: label.sourceUrl,
      section: evidence.sourceField,
      year: label.effectiveTime?.slice(0, 4),
    })
  }
}

export function labelEvidenceCitationId(evidenceId: string): string {
  return `fda-label-evidence-${evidenceId}`
}

export function labelFor(generic: string): LabelRecord | undefined {
  return LABELS[generic.toLowerCase()]
}

export function evidenceFor(evidenceId: string): LabelEvidence | null {
  for (const label of Object.values(LABELS)) {
    const evidence = label.evidence[evidenceId]
    if (evidence) return evidence
  }
  return null
}

/** A rule without a matching pinned evidence record is omitted from runtime output. */
export function citeLabelEvidence(evidenceId: string): string[] {
  return evidenceFor(evidenceId) ? [labelEvidenceCitationId(evidenceId)] : []
}
