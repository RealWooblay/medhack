/**
 * Medical history that changes antidepressant choice.
 *
 * Genetics tells you how much drug reaches someone. It does not tell you that bupropion is
 * contraindicated in epilepsy, or that citalopram carries a dose-dependent QT signal. Those
 * come from the person, and for several of these conditions the history outranks the
 * genotype entirely — a CYP2D6 result is irrelevant if the drug is contraindicated outright.
 *
 * Each modifier is a structured condition mapped to an effect on specific drugs or classes,
 * with the reason and its source. Free-text history is kept alongside for the clinician, but
 * only these structured answers are allowed to move a medicine, because a ranking engine
 * cannot safely parse "bit of heart trouble years back".
 */

export type HistoryEffect = 'avoid' | 'caution' | 'prefer'

export interface HistoryCondition {
  id: string
  /** Question as the person reads it. */
  label: string
  group: 'conditions' | 'risks' | 'priorities'
  effects: Array<{
    /** Specific generics, or a class token resolved by drugClass. */
    drugs?: string[]
    drugClass?: 'SSRI' | 'SNRI' | 'TCA'
    effect: HistoryEffect
    reason: string
    source: string
  }>
}

const SSRIS = ['sertraline', 'fluoxetine', 'paroxetine', 'citalopram', 'escitalopram', 'fluvoxamine']
const TCAS = ['amitriptyline', 'nortriptyline', 'imipramine', 'clomipramine', 'desipramine', 'doxepin', 'trimipramine']
const ACTIVATING = ['fluoxetine', 'bupropion', 'venlafaxine']
const SEDATING = ['mirtazapine', 'trazodone']

export const HISTORY_CONDITIONS: HistoryCondition[] = [
  {
    id: 'seizure_history',
    label: 'Epilepsy or a history of seizures',
    group: 'conditions',
    effects: [{
      drugs: ['bupropion'],
      effect: 'avoid',
      reason: 'Bupropion lowers the seizure threshold and is contraindicated where there is a seizure disorder.',
      source: 'FDA bupropion label, Contraindications',
    }],
  },
  {
    id: 'eating_disorder',
    label: 'Anorexia or bulimia, now or in the past',
    group: 'conditions',
    effects: [{
      drugs: ['bupropion'],
      effect: 'avoid',
      reason: 'Bupropion is contraindicated in current or prior bulimia or anorexia because seizure risk is markedly higher.',
      source: 'FDA bupropion label, Contraindications',
    }],
  },
  {
    id: 'bipolar',
    label: 'Bipolar disorder, or a manic episode in the past',
    group: 'conditions',
    effects: [{
      drugs: [...SSRIS, 'venlafaxine', 'desvenlafaxine', 'duloxetine', 'mirtazapine', 'bupropion', 'vortioxetine'],
      effect: 'caution',
      reason: 'Antidepressants alone can precipitate a manic or mixed episode. Prescribing here is a specialist decision, usually alongside a mood stabiliser.',
      source: 'Antidepressant class labelling, Warnings — screening for bipolar disorder before treatment',
    }],
  },
  {
    id: 'long_qt_cardiac',
    label: 'Heart rhythm problem, long QT, or recent heart attack',
    group: 'conditions',
    effects: [{
      drugs: ['citalopram', 'escitalopram'],
      effect: 'caution',
      reason: 'Citalopram causes dose-dependent QT prolongation and the FDA sets a maximum dose in adults; escitalopram carries a related signal.',
      source: 'FDA Drug Safety Communication on citalopram and QT interval',
    }, {
      drugClass: 'TCA',
      effect: 'caution',
      reason: 'Tricyclics affect cardiac conduction and are generally avoided after a recent myocardial infarction.',
      source: 'FDA tricyclic labelling, Warnings',
    }],
  },
  {
    id: 'liver_impairment',
    label: 'Liver disease or impaired liver function',
    group: 'conditions',
    effects: [{
      drugs: [...SSRIS, 'venlafaxine', 'duloxetine', 'vortioxetine', 'mirtazapine'],
      effect: 'caution',
      reason: 'Most antidepressants are cleared hepatically, so impaired liver function raises exposure independently of genotype.',
      source: 'Antidepressant labelling, Use in Specific Populations — hepatic impairment',
    }, {
      drugs: ['duloxetine'],
      effect: 'avoid',
      reason: 'Duloxetine is not recommended in chronic liver disease or substantial alcohol use because of hepatotoxicity risk.',
      source: 'FDA duloxetine label, Warnings — hepatotoxicity',
    }],
  },
  {
    id: 'kidney_impairment',
    label: 'Kidney disease or impaired kidney function',
    group: 'conditions',
    effects: [{
      drugs: ['desvenlafaxine', 'venlafaxine', 'levomilnacipran'],
      effect: 'caution',
      reason: 'These depend on renal clearance, so reduced kidney function raises exposure and the dose usually needs adjusting.',
      source: 'FDA labelling, Use in Specific Populations — renal impairment',
    }],
  },
  {
    id: 'glaucoma',
    label: 'Narrow-angle glaucoma',
    group: 'conditions',
    effects: [{
      drugClass: 'TCA',
      effect: 'caution',
      reason: 'Anticholinergic effects can raise intraocular pressure and precipitate angle closure.',
      source: 'FDA tricyclic labelling, Warnings',
    }],
  },
  {
    id: 'pregnancy',
    label: 'Pregnant, or planning a pregnancy',
    group: 'conditions',
    effects: [{
      drugs: ['paroxetine'],
      effect: 'caution',
      reason: 'Paroxetine carries a cardiac malformation signal in first-trimester exposure and is usually avoided where an alternative exists.',
      source: 'FDA paroxetine label, Use in Specific Populations — pregnancy',
    }],
  },
  {
    id: 'bleeding_risk',
    label: 'Bleeding disorder, or taking a blood thinner',
    group: 'risks',
    effects: [{
      drugs: [...SSRIS, 'venlafaxine', 'desvenlafaxine', 'duloxetine'],
      effect: 'caution',
      reason: 'These deplete platelet serotonin, and the bleeding risk compounds with anticoagulants, aspirin and NSAIDs.',
      source: 'SSRI/SNRI labelling, Warnings — abnormal bleeding',
    }],
  },
  {
    id: 'low_sodium',
    label: 'Low sodium in the past, or aged over 65',
    group: 'risks',
    effects: [{
      drugs: SSRIS,
      effect: 'caution',
      reason: 'SSRIs can cause hyponatraemia through SIADH, and the risk is concentrated in older adults and those with prior episodes.',
      source: 'SSRI labelling, Warnings — hyponatremia',
    }],
  },
  {
    id: 'priority_sleep',
    label: 'Sleep is what I most want fixed',
    group: 'priorities',
    effects: [{
      drugs: SEDATING,
      effect: 'prefer',
      reason: 'Mirtazapine and trazodone are sedating, which is useful when insomnia is the dominant complaint.',
      source: 'FDA labelling, Adverse Reactions — somnolence profile',
    }, {
      drugs: ACTIVATING,
      effect: 'caution',
      reason: 'These are activating and more likely to disturb sleep early in treatment.',
      source: 'FDA labelling, Adverse Reactions — insomnia rates',
    }],
  },
  {
    id: 'priority_weight',
    label: 'I do not want to gain weight',
    group: 'priorities',
    effects: [{
      drugs: ['mirtazapine'],
      effect: 'caution',
      reason: 'Mirtazapine drives appetite and weight gain through H1 antagonism more than the other options here.',
      source: 'FDA mirtazapine label, Adverse Reactions — increased appetite and weight gain',
    }, {
      drugs: ['bupropion'],
      effect: 'prefer',
      reason: 'Bupropion is the least associated with weight gain and is often weight-neutral or reducing.',
      source: 'FDA bupropion label, Adverse Reactions',
    }],
  },
  {
    id: 'priority_sexual',
    label: 'Sexual side effects would be a dealbreaker',
    group: 'priorities',
    effects: [{
      drugs: ['bupropion'],
      effect: 'prefer',
      reason: 'Bupropion has a markedly lower rate of sexual dysfunction than the SSRIs and SNRIs.',
      source: 'FDA bupropion label, Adverse Reactions',
    }, {
      drugs: [...SSRIS, 'venlafaxine', 'desvenlafaxine'],
      effect: 'caution',
      reason: 'Sexual dysfunction is common on these and is a leading reason people stop taking them.',
      source: 'SSRI/SNRI labelling, Adverse Reactions',
    }],
  },
]

export interface HistoryFlag {
  conditionId: string
  conditionLabel: string
  effect: HistoryEffect
  reason: string
  source: string
}

function classOf(drug: string): 'SSRI' | 'SNRI' | 'TCA' | null {
  const d = drug.toLowerCase()
  if (SSRIS.includes(d)) return 'SSRI'
  if (['venlafaxine', 'desvenlafaxine', 'duloxetine', 'levomilnacipran'].includes(d)) return 'SNRI'
  if (TCAS.includes(d)) return 'TCA'
  return null
}

/** Every history-driven flag that applies to one drug, given the selected conditions. */
export function historyFlagsFor(drug: string, selectedConditionIds: string[]): HistoryFlag[] {
  const d = drug.toLowerCase()
  const drugClass = classOf(d)
  const flags: HistoryFlag[] = []

  for (const condition of HISTORY_CONDITIONS) {
    if (!selectedConditionIds.includes(condition.id)) continue
    for (const effect of condition.effects) {
      const matches =
        (effect.drugs?.some((x) => x.toLowerCase() === d) ?? false) ||
        (effect.drugClass !== undefined && effect.drugClass === drugClass)
      if (!matches) continue
      flags.push({
        conditionId: condition.id,
        conditionLabel: condition.label,
        effect: effect.effect,
        reason: effect.reason,
        source: effect.source,
      })
    }
  }
  return flags
}

/** Worst effect across a drug's flags — avoid beats caution beats prefer. */
export function worstHistoryEffect(flags: HistoryFlag[]): HistoryEffect | null {
  if (flags.some((f) => f.effect === 'avoid')) return 'avoid'
  if (flags.some((f) => f.effect === 'caution')) return 'caution'
  if (flags.some((f) => f.effect === 'prefer')) return 'prefer'
  return null
}
