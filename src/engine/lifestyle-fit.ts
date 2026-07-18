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
      return 'One recorded routine factor may be easier to plan'
    case 'needs_planning':
      return 'Could work, with a practical plan'
    case 'clinician_review':
      return 'Raises a daily-life issue to review first'
    default:
      return 'Not enough specific lifestyle evidence to compare'
  }
}

export function matchLifestyle(
  protocol: LifestyleProtocol,
  care: CareContext,
): DrugLifestyleMatch {
  const facts: DailyFitFact[] = []
  const unknowns = [
    'This comparison does not predict whether the medicine will improve depression.',
    'Weight, sexual effects and comparative efficacy are not ranked because the current data is not head-to-head evidence.',
  ]
  const add = (value: DailyFitFact | null) => {
    if (value) facts.push(value)
  }

  const protocolItems = [...protocol.items, ...protocol.interactionItems]
  const byId = (ids: string[]) => ids.find((id) => protocolItems.some((item) => item.id === id))

  const strictFoodId = byId(['vilazodone-food', 'venlafaxine-food-time'])
  const flexibleFoodId = byId([
    'paroxetine-morning', 'sertraline-food', 'escitalopram-timing', 'citalopram-daily',
    'desvenlafaxine-time', 'duloxetine-food', 'vortioxetine-food',
  ])
  const foodId = strictFoodId ?? flexibleFoodId
  if (foodId) {
    const needsMealPlan = Boolean(strictFoodId) && care.lifestyle.mealRoutine !== 'regular'
    add(fact(protocol, foodId, {
      dimension: 'meals',
      verdict: needsMealPlan ? 'needs_planning' : 'supports_routine',
      title: needsMealPlan ? 'The food instruction needs a reliable meal plan' : 'The recorded meal pattern fits this captured food instruction',
      detail: needsMealPlan
        ? 'Meals were recorded as irregular or variable, while this draft label summary says the medicine is taken with food.'
        : 'This match checks only the captured food instruction; it is not a medicine-safety finding.',
    }))
  }

  const timingItem = protocolItems.find((item) => item.category === 'timing')
  if (timingItem) {
    const flexibleTiming = ['escitalopram-timing', 'citalopram-daily'].includes(timingItem.id)
    const needsTimingPlan = care.lifestyle.dailySchedule !== 'regular' && !flexibleTiming
    add(fact(protocol, timingItem.id, {
      dimension: 'schedule',
      verdict: needsTimingPlan ? 'needs_planning' : 'supports_routine',
      title: needsTimingPlan ? 'The timing instruction needs a routine plan' : 'The recorded schedule can be planned within this timing instruction',
      detail: needsTimingPlan
        ? 'A variable or shift-work schedule was recorded and this draft label summary has a specific time or consistency requirement.'
        : 'A consistent plan still needs to be agreed with the prescriber.',
    }))
  }

  if (care.lifestyle.sleep === 'trouble_sleeping') {
    unknowns.push(
      'Trouble sleeping was recorded, but this evidence snapshot does not compare antidepressants by their effect on sleep.',
    )
  }

  if (protocolItems.some((item) => item.id === 'mirtazapine-somnolence')) {
    const excessiveSleep = care.lifestyle.sleep === 'sleeping_too_much'
    if (excessiveSleep) {
      add(fact(protocol, 'mirtazapine-somnolence', {
        dimension: 'sleep',
        verdict: 'clinician_review',
        title: 'The somnolence warning matches the recorded sleep concern',
        detail: 'Sleeping too much was recorded and the draft mirtazapine summary includes a somnolence warning.',
      }))
    } else {
      unknowns.push('The mirtazapine somnolence warning cannot predict how the medicine would affect the recorded sleep pattern.')
    }
  }

  const alcoholItem = protocolItems.find((item) => item.id.includes('alcohol'))
  if (alcoholItem) {
    const usesAlcohol = care.lifestyle.alcohol !== 'none'
    const heavyOnly = alcoholItem.id === 'duloxetine-heavy-alcohol'
    if (heavyOnly && usesAlcohol) {
      unknowns.push('The alcohol answer records frequency, not amount, so it cannot establish whether the duloxetine heavy-intake warning applies.')
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
          ? 'No alcohol use was recorded against this warning'
          : 'The recorded alcohol use needs review against this warning',
        detail: 'This is a match to one draft drug-specific warning, not a general safety assessment.',
      }))
    }
  }

  const drivingId = `${protocol.drug}-driving`
  if (protocolItems.some((item) => item.id === drivingId)) {
    add(fact(protocol, drivingId, {
      dimension: 'driving',
      verdict: care.lifestyle.drivingOrMachinery ? 'needs_planning' : 'supports_routine',
      title: care.lifestyle.drivingOrMachinery ? 'The driving precaution needs a plan' : 'No driving or machinery use was recorded against this precaution',
      detail: 'This checks only the captured impairment precaution for this medicine.',
    }))
  }

  if (care.lifestyle.missedDoses !== 'rarely') {
    unknowns.push(
      'Missed doses were recorded. This build does not score one medicine as more forgiving than another; ask for an adherence plan.',
    )
  }

  if (protocolItems.some((item) => item.id === 'bupropion-eating-disorder')) {
    add(fact(protocol, 'bupropion-eating-disorder', {
      dimension: 'medical_history',
      verdict: care.lifestyle.eatingDisorderHistory ? 'clinician_review' : 'supports_routine',
      title: care.lifestyle.eatingDisorderHistory ? 'The recorded history matches this contraindication' : 'This contraindication was not reported in the answer',
      detail: 'This checks one captured history item only and does not establish that bupropion is suitable.',
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
