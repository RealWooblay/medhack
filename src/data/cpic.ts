/**
 * CPIC guideline lookup.
 *
 * The recommendation rows in `sources/cpic-sri-2023.json` and `sources/cpic-tca-2016.json`
 * were extracted from the CPIC-hosted guideline PDFs and are stored as captured source
 * data rather than retyped here, so the provenance chain from PDF to rendered badge stays
 * intact and reviewable.
 *
 * This table is the guideline knowledge PharmCAT itself embeds. We query it twice per
 * drug: once with the genetic phenotype, which reproduces what PharmCAT alone would say,
 * and once with the phenoconverted functional phenotype, which is the part PharmCAT
 * cannot do because it has never been told what else the patient is taking.
 */

import sriSource from './sources/cpic-sri-2023.json'
import tcaSource from './sources/cpic-tca-2016.json'
import type { Phenotype, RecommendationAction } from '../engine/types'

export interface CpicRecommendation {
  gene: string
  phenotype: Phenotype
  drug: string
  action: RecommendationAction
  text: string
  strength?: string
  citationIds: string[]
}

interface RawRecommendation {
  gene: string
  phenotype: string
  drug: string
  action: string
  text: string
  strength?: string
  citation: string
}

const VALID_ACTIONS: RecommendationAction[] = [
  'standard', 'increase', 'decrease', 'decrease_start', 'avoid', 'alternative', 'caution', 'no_recommendation',
]

/**
 * The guideline's own wording decides whether the STARTING dose changes.
 *
 * CPIC's intermediate-metaboliser rows for citalopram, escitalopram and sertraline are
 * coded "decrease" in the extracted table, but every one of them opens "Initiate therapy
 * with recommended starting dose" and the narrative states that existing data do not
 * support adjusting starting doses for intermediate metabolisers. Likewise the rapid
 * metaboliser rows coded "increase" are conditional — they escalate only if the patient
 * does not respond to standard maintenance dosing.
 *
 * Re-deriving this from the recommendation text keeps the guideline as the authority
 * rather than the extraction, and the raw action stays visible in the clinician view.
 */
const STANDARD_START = /^initiate therapy with (the )?recommended starting dose/i

function refineAction(action: RecommendationAction, text: string): RecommendationAction {
  if (!STANDARD_START.test(text.trim())) return action
  if (action === 'decrease') return 'standard_start_reduced_maintenance'
  if (action === 'increase') return 'standard_start_conditional_increase'
  return action
}

function normalise(raw: RawRecommendation, citationId: string): CpicRecommendation | null {
  const parsed = VALID_ACTIONS.includes(raw.action as RecommendationAction)
    ? (raw.action as RecommendationAction)
    : 'no_recommendation'
  const action = refineAction(parsed, raw.text ?? '')
  if (!raw.gene || !raw.drug || !raw.phenotype) return null
  return {
    gene: raw.gene.trim(),
    phenotype: raw.phenotype.trim() as Phenotype,
    drug: raw.drug.trim().toLowerCase(),
    action,
    text: raw.text.trim(),
    strength: raw.strength,
    citationIds: [citationId],
  }
}

export const CPIC_RECOMMENDATIONS: CpicRecommendation[] = [
  ...(sriSource.recommendations as RawRecommendation[]).map((r) => normalise(r, 'cpic-2023-sri')),
  ...(tcaSource.recommendations as RawRecommendation[]).map((r) => normalise(r, 'cpic-2016-tca')),
].filter((r): r is CpicRecommendation => r !== null)

export function lookupRecommendation(
  gene: string,
  phenotype: Phenotype,
  drug: string,
): CpicRecommendation | null {
  const d = drug.toLowerCase()
  return (
    CPIC_RECOMMENDATIONS.find(
      (r) => r.gene === gene && r.phenotype === phenotype && r.drug === d,
    ) ?? null
  )
}

/* ------------------------------------------------------------------ */
/* Drug profiles — which enzymes actually matter for each drug          */
/* ------------------------------------------------------------------ */

export interface DrugProfile {
  drug: string
  drugClass: string
  /** Genes CPIC issues dosing guidance on for this drug. */
  primaryGenes: string[]
  /** Genes involved in clearance but not dosing-actionable. */
  secondaryGenes: string[]
  /** Whether CPIC issues any dosing recommendation at all. */
  cpicCovered: boolean
  /** One line on the clearance route, shown when a row is expanded. */
  metabolicNote: string
  citationIds: string[]
}

/**
 * CPIC 2023 scope, verbatim from the guideline: "CYP2D6-guided recommendations are made
 * for paroxetine, fluvoxamine, venlafaxine, and vortioxetine; CYP2C19-guided
 * recommendations are made for citalopram, escitalopram, and sertraline; and CYP2B6-guided
 * recommendations are made for sertraline."
 *
 * Everything outside that list is carried with cpicCovered false, and the UI labels it as
 * having no guideline recommendation rather than quietly implying one exists.
 */
export const DRUG_PROFILES: DrugProfile[] = [
  {
    drug: 'sertraline',
    drugClass: 'SSRI',
    primaryGenes: ['CYP2C19', 'CYP2B6'],
    secondaryGenes: [],
    cpicCovered: true,
    metabolicNote:
      'Cleared mainly by CYP2C19 and CYP2B6. CPIC states that studies have found little to no effect of ' +
      'CYP2D6 genetic variation on sertraline exposure, and sertraline is not predominantly metabolised by ' +
      'CYP2D6 — so a CYP2D6 phenotype, genetic or phenoconverted, does not govern sertraline dosing.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'escitalopram',
    drugClass: 'SSRI',
    primaryGenes: ['CYP2C19'],
    secondaryGenes: ['CYP2D6', 'CYP3A4'],
    cpicCovered: true,
    metabolicNote: 'Predominantly CYP2C19, with minor CYP2D6 and CYP3A4 contribution.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'citalopram',
    drugClass: 'SSRI',
    primaryGenes: ['CYP2C19'],
    secondaryGenes: ['CYP2D6', 'CYP3A4'],
    cpicCovered: true,
    metabolicNote: 'Predominantly CYP2C19, with minor CYP2D6 and CYP3A4 contribution.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'paroxetine',
    drugClass: 'SSRI',
    primaryGenes: ['CYP2D6'],
    secondaryGenes: [],
    cpicCovered: true,
    metabolicNote:
      'Predominantly CYP2D6, which paroxetine also potently inhibits. CPIC notes that paroxetine-associated ' +
      'phenoconversion of normal metabolisers to intermediate or poor metabolisers due to CYP2D6 ' +
      'autoinhibition may occur.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'fluvoxamine',
    drugClass: 'SSRI',
    primaryGenes: ['CYP2D6'],
    secondaryGenes: ['CYP1A2'],
    cpicCovered: true,
    metabolicNote: 'CYP2D6 and CYP1A2. Fluvoxamine is itself a strong inhibitor of CYP1A2 and CYP2C19.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'fluoxetine',
    drugClass: 'SSRI',
    primaryGenes: [],
    secondaryGenes: ['CYP2D6', 'CYP2C19'],
    cpicCovered: false,
    metabolicNote:
      'CPIC assigns fluoxetine level C with no recommendation: ultrarapid and poor CYP2D6 metabolisers have ' +
      'different parent-to-metabolite ratios, but the sum of fluoxetine plus active norfluoxetine may not ' +
      'vary significantly by CYP2D6 phenotype. Fluoxetine is itself a strong inhibitor of both CYP2D6 and CYP2C19.',
    citationIds: ['cpic-2023-sri', 'fda-interaction-table'],
  },
  {
    drug: 'venlafaxine',
    drugClass: 'SNRI',
    primaryGenes: ['CYP2D6'],
    secondaryGenes: ['CYP3A4'],
    cpicCovered: true,
    metabolicNote: 'CYP2D6 converts venlafaxine to its active metabolite O-desmethylvenlafaxine (desvenlafaxine).',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'vortioxetine',
    drugClass: 'serotonin modulator',
    primaryGenes: ['CYP2D6'],
    secondaryGenes: [],
    cpicCovered: true,
    metabolicNote: 'Predominantly CYP2D6.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'desvenlafaxine',
    drugClass: 'SNRI',
    primaryGenes: [],
    secondaryGenes: [],
    cpicCovered: false,
    metabolicNote:
      'Desvenlafaxine is the already-formed active metabolite of venlafaxine. It is cleared primarily by ' +
      'UGT conjugation and renal excretion with minimal cytochrome P450 involvement, so it largely bypasses ' +
      'both CYP2D6 and CYP2C19. CPIC makes no dosing recommendation for it, so there is no guideline-backed ' +
      'dose here — only the observation that the enzymes in question are not the ones that clear it.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'duloxetine',
    drugClass: 'SNRI',
    primaryGenes: [],
    secondaryGenes: ['CYP1A2', 'CYP2D6'],
    cpicCovered: false,
    metabolicNote: 'CYP1A2 and CYP2D6. Duloxetine is itself a moderate CYP2D6 inhibitor.',
    citationIds: ['cpic-2023-sri', 'fda-interaction-table'],
  },
  {
    drug: 'vilazodone',
    drugClass: 'serotonin modulator',
    primaryGenes: [],
    secondaryGenes: ['CYP3A4'],
    cpicCovered: false,
    metabolicNote: 'Predominantly CYP3A4. Absorption depends substantially on being taken with food.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'levomilnacipran',
    drugClass: 'SNRI',
    primaryGenes: [],
    secondaryGenes: ['CYP3A4'],
    cpicCovered: false,
    metabolicNote: 'CYP3A4 and renal excretion.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'bupropion',
    drugClass: 'atypical antidepressant',
    primaryGenes: [],
    secondaryGenes: ['CYP2B6'],
    cpicCovered: false,
    metabolicNote:
      'A CYP2B6 substrate, and itself a strong CYP2D6 inhibitor — so starting bupropion would sustain a ' +
      'functional CYP2D6 poor-metaboliser state rather than resolve one.',
    citationIds: ['fda-interaction-table'],
  },
  {
    drug: 'mirtazapine',
    drugClass: 'atypical antidepressant',
    primaryGenes: [],
    secondaryGenes: ['CYP2D6', 'CYP3A4', 'CYP1A2'],
    cpicCovered: false,
    metabolicNote: 'Cleared by CYP2D6, CYP3A4 and CYP1A2 in parallel, which buffers the effect of any single enzyme.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'nortriptyline',
    drugClass: 'TCA',
    primaryGenes: ['CYP2D6'],
    secondaryGenes: [],
    cpicCovered: true,
    metabolicNote: 'A secondary amine TCA cleared by CYP2D6 only, without the CYP2C19 step the tertiary amines require.',
    citationIds: ['cpic-2016-tca'],
  },
  {
    drug: 'amitriptyline',
    drugClass: 'TCA',
    primaryGenes: ['CYP2D6', 'CYP2C19'],
    secondaryGenes: [],
    cpicCovered: true,
    metabolicNote: 'A tertiary amine: CYP2C19 demethylates it to nortriptyline, which CYP2D6 then hydroxylates.',
    citationIds: ['cpic-2016-tca'],
  },
]

export function profileOf(drug: string): DrugProfile | undefined {
  return DRUG_PROFILES.find((p) => p.drug.toLowerCase() === drug.toLowerCase())
}

/** The candidate set the ranking engine considers when asked "what should I give?". */
export const SHORTLIST_CANDIDATES: string[] = [
  'sertraline', 'escitalopram', 'citalopram', 'paroxetine', 'fluvoxamine', 'fluoxetine',
  'venlafaxine', 'desvenlafaxine', 'duloxetine', 'vortioxetine', 'vilazodone',
  'bupropion', 'mirtazapine', 'nortriptyline', 'amitriptyline',
]

/** Guideline scope statement, rendered in the clinician view. */
export const CPIC_SCOPE_NOTE =
  'CPIC 2023 makes CYP2D6-guided recommendations for paroxetine, fluvoxamine, venlafaxine and vortioxetine; ' +
  'CYP2C19-guided recommendations for citalopram, escitalopram and sertraline; and CYP2B6-guided ' +
  'recommendations for sertraline. Drugs outside that scope are shown without a guideline dose.'
