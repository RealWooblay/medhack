/**
 * A separate daily-life compatibility layer.
 *
 * These facts never change the PGx category or medicine order. They connect the person's stated routine to
 * drug-specific, cited label rules already captured by the protocol engine. Unknown means
 * exactly that: the local evidence set is not specific enough to compare the priority.
 */

import type {
  CareContext,
  DailyFitFact,
  DailyFitVerdict,
  DrugLifestyleMatch,
  LifestyleContext,
  LifestyleProtocol,
} from './types'

const ORDER: Record<DailyFitVerdict, number> = {
  clinician_review: 0,
  needs_planning: 1,
  supports_routine: 2,
  unknown: 3,
}

function fact(
  protocol: LifestyleProtocol,
  id: string,
  values: Omit<DailyFitFact, 'citationIds'>,
): DailyFitFact | null {
  const rule = [...protocol.items, ...protocol.interactionItems].find((item) => item.id === id)
  return rule ? { ...values, citationIds: rule.citationIds } : null
}

function headlineFor(verdict: DailyFitVerdict): string {
  switch (verdict) {
    case 'supports_routine':
      return 'No conflict in the checked facts'
    case 'needs_planning':
      return 'A routine change is needed'
    case 'clinician_review':
      return 'Check this before use'
    default:
      return 'No matching lifestyle fact'
  }
}

export function matchLifestyle(
  protocol: LifestyleProtocol,
  care: CareContext,
  /** When supplied, only answers explicitly present here may produce a match fact. */
  confirmedLifestyle?: Partial<LifestyleContext>,
): DrugLifestyleMatch {
  const facts: DailyFitFact[] = []
  const unknowns: string[] = []
  const add = (value: DailyFitFact | null) => {
    if (value) facts.push(value)
  }

  const protocolItems = [...protocol.items, ...protocol.interactionItems]
  const byId = (ids: string[]) => ids.find((id) => protocolItems.some((item) => item.id === id))
  const confirmed = (key: keyof LifestyleContext): boolean => Object.prototype.hasOwnProperty.call(
    confirmedLifestyle ?? care.lifestyle,
    key,
  )
  const value = <K extends keyof LifestyleContext>(key: K): LifestyleContext[K] | undefined =>
    confirmedLifestyle === undefined ? care.lifestyle[key] : confirmedLifestyle[key]

  const strictFoodId = byId(['vilazodone-food', 'venlafaxine-food-time'])
  const flexibleFoodId = byId([
    'paroxetine-morning', 'sertraline-food', 'escitalopram-timing', 'citalopram-daily',
    'desvenlafaxine-time', 'duloxetine-food', 'vortioxetine-food',
  ])
  const foodId = strictFoodId ?? flexibleFoodId
  if (foodId && confirmed('mealRoutine')) {
    const needsMealPlan = Boolean(strictFoodId) && value('mealRoutine') !== 'regular'
    add(fact(protocol, foodId, {
      dimension: 'meals',
      verdict: needsMealPlan ? 'needs_planning' : 'supports_routine',
      title: needsMealPlan
        ? 'Take this with food'
        : strictFoodId
          ? 'Your meal routine fits the food instruction'
          : 'Food timing is flexible',
      detail: needsMealPlan
        ? 'You recorded irregular or variable meals. The label says this medicine is taken with food.'
        : strictFoodId
          ? 'You recorded regular meals and the label says this medicine is taken with food.'
          : 'The label allows this medicine with or without food.',
    }))
  }

  const timingItem = protocolItems.find((item) => item.category === 'timing')
  if (timingItem && confirmed('dailySchedule')) {
    const flexibleTiming = ['escitalopram-timing', 'citalopram-daily'].includes(timingItem.id)
    const needsTimingPlan = value('dailySchedule') !== 'regular' && !flexibleTiming
    add(fact(protocol, timingItem.id, {
      dimension: 'schedule',
      verdict: needsTimingPlan ? 'needs_planning' : 'supports_routine',
      title: needsTimingPlan ? 'Choose a reliable dose time' : 'The dose timing fits your schedule',
      detail: needsTimingPlan
        ? 'You recorded a variable or shift-work schedule. This label has a specific dose-time instruction.'
        : flexibleTiming
          ? 'The label allows a dose time that can fit your schedule.'
          : 'You recorded a regular schedule for this dose-time instruction.',
    }))
  }

  if (protocolItems.some((item) => item.id === 'mirtazapine-somnolence') && confirmed('sleep')) {
    const excessiveSleep = value('sleep') === 'sleeping_too_much'
    if (excessiveSleep) {
      add(fact(protocol, 'mirtazapine-somnolence', {
        dimension: 'sleep',
        verdict: 'clinician_review',
        title: 'Sleepiness warning applies',
        detail: 'You recorded sleeping too much. The mirtazapine label warns about somnolence.',
      }))
    } else {
      unknowns.push('The label cannot predict how mirtazapine would affect your sleep.')
    }
  }

  const alcoholItem = protocolItems.find((item) => item.id.includes('alcohol'))
  if (alcoholItem && confirmed('alcohol')) {
    const usesAlcohol = value('alcohol') !== 'none'
    const heavyOnly = alcoholItem.id === 'duloxetine-heavy-alcohol'
    if (heavyOnly && usesAlcohol) {
      unknowns.push('Alcohol frequency does not show whether the duloxetine heavy-use warning applies.')
    } else {
      const verdict: Exclude<DailyFitVerdict, 'unknown'> = !usesAlcohol
        ? 'supports_routine'
        : alcoholItem.id === 'bupropion-alcohol'
          ? 'clinician_review'
          : 'needs_planning'
      add(fact(protocol, alcoholItem.id, {
        dimension: 'alcohol',
        verdict,
        title: !usesAlcohol
          ? 'No alcohol conflict recorded'
          : 'Alcohol warning applies',
        detail: !usesAlcohol
          ? 'You recorded no alcohol use.'
          : alcoholItem.id === 'bupropion-alcohol'
            ? 'The bupropion label says to minimise or avoid alcohol and warns against abruptly stopping heavy use.'
            : 'You recorded alcohol use and this medicine has a label warning about alcohol.',
      }))
    }
  }

  const drivingId = `${protocol.drug}-driving`
  if (protocolItems.some((item) => item.id === drivingId) && confirmed('drivingOrMachinery')) {
    add(fact(protocol, drivingId, {
      dimension: 'driving',
      verdict: value('drivingOrMachinery') ? 'needs_planning' : 'supports_routine',
      title: value('drivingOrMachinery') ? 'Driving precaution applies' : 'No driving conflict recorded',
      detail: value('drivingOrMachinery')
        ? 'You recorded driving or machinery use. The label warns about possible impairment.'
        : 'You recorded no usual driving or machinery use.',
    }))
  }

  if (protocolItems.some((item) => item.id === 'bupropion-eating-disorder') && confirmed('eatingDisorderHistory')) {
    add(fact(protocol, 'bupropion-eating-disorder', {
      dimension: 'medical_history',
      verdict: value('eatingDisorderHistory') ? 'clinician_review' : 'supports_routine',
      title: value('eatingDisorderHistory') ? 'Bupropion is contraindicated with this history' : 'No anorexia or bulimia history recorded',
      detail: value('eatingDisorderHistory')
        ? 'You reported current or past anorexia or bulimia, which the bupropion label lists as a contraindication.'
        : 'You did not report current or past anorexia or bulimia.',
    }))
  }

  const verdict = facts.length
    ? [...facts].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict])[0].verdict
    : 'unknown'

  return {
    drug: protocol.drug,
    verdict,
    headline: headlineFor(verdict),
    facts,
    unknowns,
  }
}
