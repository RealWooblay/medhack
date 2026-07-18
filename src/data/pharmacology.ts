/**
 * Drug-specific pharmacology that the guideline tables do not carry, but which changes
 * the interpretation of a result. Each entry is sourced.
 */

export interface AutoInhibitor {
  drug: string
  enzyme: string
  note: string
  citationIds: string[]
}

/**
 * Drugs that inhibit the enzyme responsible for clearing them. Exposure then rises more
 * than proportionally with dose, so a genetically normal metaboliser can still accumulate.
 * This is the mechanism that explains early intolerance on paroxetine in a patient whose
 * genotype looks unremarkable.
 */
export const AUTO_INHIBITORS: AutoInhibitor[] = [
  {
    drug: 'paroxetine',
    enzyme: 'CYP2D6',
    note:
      'Paroxetine is both a CYP2D6 substrate and a potent CYP2D6 inhibitor, so it suppresses its own ' +
      'clearance. Plasma concentrations rise disproportionately as the dose increases, and a patient ' +
      'with an unremarkable CYP2D6 genotype can still reach poor-metaboliser-like exposure within the ' +
      'first weeks of treatment.',
    citationIds: ['cpic-2023-sri', 'fda-interaction-table'],
  },
  {
    drug: 'fluoxetine',
    enzyme: 'CYP2D6',
    note:
      'Fluoxetine and its active metabolite norfluoxetine are potent CYP2D6 inhibitors, and fluoxetine ' +
      'is itself partly cleared by CYP2D6, so clearance falls as treatment continues.',
    citationIds: ['cpic-2023-sri', 'fda-interaction-table'],
  },
]

export function autoInhibitorFor(drug: string): AutoInhibitor | undefined {
  return AUTO_INHIBITORS.find((a) => a.drug.toLowerCase() === drug.toLowerCase())
}

/**
 * How long an inhibitor keeps acting after the last dose.
 *
 * This matters more than it first appears. Stopping fluoxetine does not restore CYP2D6
 * activity that week — norfluoxetine has a long elimination half-life, so the functional
 * poor-metaboliser state persists well into the switch to the next drug. A cross-taper
 * planned as though the inhibition stops with the tablet will under-dose or over-dose the
 * incoming drug. No genotype-only tool models this at all.
 */
export interface InhibitorPersistence {
  drug: string
  enzyme: string
  /** Lower and upper bound of the washout window in days. */
  washoutDaysLow: number
  washoutDaysHigh: number
  note: string
  citationIds: string[]
}

export const INHIBITOR_PERSISTENCE: InhibitorPersistence[] = [
  {
    drug: 'fluoxetine',
    enzyme: 'CYP2D6',
    washoutDaysLow: 25,
    washoutDaysHigh: 60,
    note:
      'Fluoxetine has an elimination half-life of 1 to 4 days and its active metabolite norfluoxetine ' +
      'a half-life of 7 to 15 days. CYP2D6 inhibition therefore persists for weeks after the last dose, ' +
      'so a drug started during the switch is still being metabolised by a functionally poor-metaboliser ' +
      'enzyme system.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drug: 'paroxetine',
    enzyme: 'CYP2D6',
    washoutDaysLow: 5,
    washoutDaysHigh: 10,
    note:
      'Paroxetine has a short half-life of around 21 hours, so CYP2D6 inhibition resolves within about ' +
      'a week of stopping. The same short half-life is why paroxetine has among the most pronounced ' +
      'discontinuation symptoms of the SSRIs.',
    citationIds: ['cpic-2023-sri'],
  },
]

export function persistenceFor(drug: string): InhibitorPersistence | undefined {
  return INHIBITOR_PERSISTENCE.find((p) => p.drug.toLowerCase() === drug.toLowerCase())
}

/**
 * Pairs that are not meaningfully different drugs.
 *
 * Offering citalopram to someone who has just failed escitalopram looks like a switch on a
 * shortlist and is not one — escitalopram is the active enantiomer of citalopram, so the
 * pharmacology is the same molecule. A ranking engine that treats every generic name as an
 * independent option will keep making this mistake, so the relationship is stated.
 */
export interface RelatedDrugs {
  drugs: [string, string]
  relationship: string
  citationIds: string[]
}

export const RELATED_DRUGS: RelatedDrugs[] = [
  {
    drugs: ['citalopram', 'escitalopram'],
    relationship:
      'Escitalopram is the S-enantiomer of citalopram — the active half of the same molecule. They ' +
      'are cleared by the same enzyme and act the same way, so moving between them after a ' +
      'non-response is not a meaningful change of drug.',
    citationIds: ['cpic-2023-sri'],
  },
  {
    drugs: ['venlafaxine', 'desvenlafaxine'],
    relationship:
      'Desvenlafaxine is the active metabolite that CYP2D6 produces from venlafaxine. Giving it ' +
      'directly bypasses the CYP2D6 step, which is a real difference for a poor metaboliser — but it ' +
      'is the same active compound, so a genuine non-response to venlafaxine carries over.',
    citationIds: ['cpic-2023-sri'],
  },
]

export function relatedTo(drug: string): RelatedDrugs[] {
  const d = drug.toLowerCase()
  return RELATED_DRUGS.filter((r) => r.drugs.some((x) => x.toLowerCase() === d))
}

export function relationshipBetween(a: string, b: string): RelatedDrugs | undefined {
  const pair = [a.toLowerCase(), b.toLowerCase()]
  return RELATED_DRUGS.find((r) => {
    const drugs = r.drugs.map((x) => x.toLowerCase())
    return pair.every((p) => drugs.includes(p)) && pair[0] !== pair[1]
  })
}
