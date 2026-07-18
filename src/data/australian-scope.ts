/**
 * Candidate Australian product scope found on origin/main (commit 81d776b).
 *
 * This is deliberately not a clinical rule table. The upstream file says its ARTG and PBS
 * fields are indicative and require live verification, and several shortened PGx summaries
 * conflict with the versioned CPIC rows already used by this application. We keep only the
 * names here so validation can see the proposed scope without letting unverified fields enter
 * a result.
 */

export const AUSTRALIAN_SCOPE_DRAFT = {
  sourceCommit: '81d776b',
  compiledDate: '2026-07-18',
  status: 'candidate scope — not validated or used in calculations',
  pgxCandidates: [
    'citalopram',
    'escitalopram',
    'sertraline',
    'paroxetine',
    'fluvoxamine',
    'fluoxetine',
    'venlafaxine',
    'vortioxetine',
    'amitriptyline',
    'nortriptyline',
    'clomipramine',
    'imipramine',
    'doxepin',
    'trimipramine',
    'desipramine',
  ],
  noActionableCpicCandidates: [
    'desvenlafaxine',
    'duloxetine',
    'mirtazapine',
    'agomelatine',
    'moclobemide',
  ],
  blockers: [
    'ARTG identifiers and current registration status are not recorded.',
    'PBS item codes, formulations, restrictions and retrieval dates are not recorded.',
    'Short recommendation summaries must be reconciled row-by-row against the captured CPIC tables.',
    'Australian Product Information and Consumer Medicine Information are not yet captured as versioned evidence.',
  ],
} as const
