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

  if (care.lifestyle.mealRoutine !== 'regular') {
    add(
      fact(protocol, 'vilazodone-food', {
        dimension: 'meals',
        verdict: 'needs_planning',
        title: 'Needs a reliable meal',
        detail:
          'You described meals as irregular or variable. This medicine has a specific food requirement, so missed meals could also mean an unreliable dose.',
      }),
    )
  }

  if (care.lifestyle.dailySchedule !== 'regular') {
    const flexibleIds = protocol.drug === 'escitalopram'
        ? ['escitalopram-timing']
        : []
    for (const flexibleId of flexibleIds) {
      add(
        fact(protocol, flexibleId, {
          dimension: 'schedule',
          verdict: 'supports_routine',
          title: 'The label allows morning or evening dosing',
          detail:
            'You recorded a variable schedule. The captured label allows morning or evening dosing; a consistent plan still needs to be agreed.',
        }),
      )
    }
    for (const fixedId of ['fluoxetine-morning', 'paroxetine-morning', 'mirtazapine-evening', 'venlafaxine-food-time', 'desvenlafaxine-time']) {
      add(
        fact(protocol, fixedId, {
          dimension: 'schedule',
          verdict: 'needs_planning',
          title: 'The label timing needs a plan',
          detail:
            'You recorded a variable schedule and this captured label has a specific timing instruction. Discuss a workable, consistent plan.',
        }),
      )
    }
  }

  if (care.lifestyle.sleep === 'trouble_sleeping') {
    unknowns.push(
      'Trouble sleeping was recorded, but this evidence snapshot does not compare antidepressants by their effect on sleep.',
    )
  }

  if (care.lifestyle.sleep === 'sleeping_too_much') {
    add(
      fact(protocol, 'mirtazapine-somnolence', {
        dimension: 'sleep',
        verdict: 'clinician_review',
        title: 'The label warning matters for your current sleep pattern',
        detail:
          'You reported sleeping too much. The captured mirtazapine label warns that somnolence is very common, so this needs prescriber review.',
      }),
    )
  }

  if (care.lifestyle.alcohol !== 'none') {
    for (const alcoholId of ['sertraline-alcohol', 'bupropion-alcohol']) {
      add(
        fact(protocol, alcoholId, {
          dimension: 'alcohol',
          verdict: alcoholId === 'bupropion-alcohol' ? 'clinician_review' : 'needs_planning',
          title: 'The recorded alcohol use needs review against the label',
          detail:
            'You recorded alcohol use and this medicine has a drug-specific label warning. Discuss it rather than changing regular use abruptly on your own.',
        }),
      )
    }
  }

  if (care.lifestyle.drivingOrMachinery) {
    add(
      fact(protocol, `${protocol.drug}-driving`, {
        dimension: 'driving',
        verdict: 'needs_planning',
        title: 'This drug has a specific driving precaution',
        detail:
          'You recorded driving or machinery use. The captured label for this exact medicine includes an impairment precaution, so a safety plan is needed.',
      }),
    )
    if (!facts.some((value) => value.dimension === 'driving')) {
      unknowns.push(
        'Driving or machinery was recorded, but this evidence snapshot has no drug-specific driving comparison for this option.',
      )
    }
  }

  if (care.lifestyle.missedDoses !== 'rarely') {
    unknowns.push(
      'Missed doses were recorded. This build does not score one medicine as more forgiving than another; ask for an adherence plan.',
    )
  }

  if (care.lifestyle.eatingDisorderHistory) {
    add(
      fact(protocol, 'bupropion-eating-disorder', {
        dimension: 'medical_history',
        verdict: 'clinician_review',
        title: 'The recorded history matches a label contraindication',
        detail:
          'You recorded current or prior anorexia nervosa or bulimia. The captured bupropion label lists that history as a contraindication; the prescriber must review it.',
      }),
    )
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
