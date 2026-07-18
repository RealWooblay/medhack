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
  return [
    {
      gene: 'SLC6A4',
      observed: observed.SLC6A4 ?? 'L/S (5-HTTLPR)',
      rationale: {
        text:
          `${CPIC_NO_RECOMMENDATION} SLC6A4 encodes the serotonin transporter that SSRIs bind, which makes it ` +
          `intuitively appealing and is why panels keep reporting it — but the association with treatment ` +
          `response has not held up well enough to guide prescribing. This result is displayed for ` +
          `completeness and is not used anywhere in the recommendations above.`,
        citationIds: ['cpic-2023-sri'],
      },
    },
    {
      gene: 'HTR2A',
      observed: observed.HTR2A ?? 'rs7997012 A/G',
      rationale: {
        text:
          `${CPIC_NO_RECOMMENDATION} HTR2A variants have been studied extensively for antidepressant response ` +
          `and side effects, and the evidence remains mixed. This result is displayed for completeness and is ` +
          `not used anywhere in the recommendations above.`,
        citationIds: ['cpic-2023-sri'],
      },
    },
  ]
}
