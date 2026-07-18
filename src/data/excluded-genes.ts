/**
 * Genes reviewed and deliberately not used.
 *
 * Commercial combinatorial pharmacogenomic panels routinely report SLC6A4 and HTR2A and
 * let a prescriber infer that they mean something for antidepressant choice. CPIC 2023
 * reviewed both and declined to make any recommendation on them.
 *
 * Rendering them greyed out, with the reason and the citation attached, is a deliberate
 * product decision. Silently dropping them would leave a patient who has seen another
 * panel wondering why their "serotonin gene" result vanished; showing them as actionable
 * would be the exact overreach that has earned the field its criticism.
 */

import type { ExcludedGeneCall } from '../engine/types'

/** CPIC's recommendation statement, quoted rather than paraphrased. */
const CPIC_NO_RECOMMENDATION =
  'Clinical recommendations are not provided for serotonin reuptake inhibitor antidepressants based on HTR2A ' +
  'and SLC6A4 genotypes because the evidence supporting an association is mixed and/or insufficient to support ' +
  'clinical validity and utility at this time (CPIC level C: no recommendation).'

export function excludedGeneCalls(observed: Record<string, string>): ExcludedGeneCall[] {
  return ['SLC6A4', 'HTR2A']
    .filter((gene) => typeof observed[gene] === 'string' && observed[gene].trim().length > 0)
    .map((gene) => ({
      gene,
      observed: observed[gene],
      rationale: {
        text: `${CPIC_NO_RECOMMENDATION} This imported ${gene} result is not used in any medicine finding.`,
        citationIds: ['cpic-2023-sri'],
      },
    }))
}
