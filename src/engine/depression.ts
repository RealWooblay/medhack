/**
 * Depression journey facts.
 *
 * PHQ-9 scoring is deterministic and kept separate from the language layer. It is a
 * symptom-severity and outcome-monitoring measure, not a diagnosis. A positive response
 * to item 9 triggers a fixed safety route in the UI; it is never delegated to a model.
 */

import type {
  CareContext,
  DepressionSummary,
  DepressionSeverity,
  PhqFrequency,
} from './types'

export const PHQ9_ITEMS = [
  'Little interest or pleasure in doing things',
  'Feeling down, depressed, or hopeless',
  'Trouble falling or staying asleep, or sleeping too much',
  'Feeling tired or having little energy',
  'Poor appetite or overeating',
  'Feeling bad about yourself — or that you are a failure or have let yourself or your family down',
  'Trouble concentrating on things, such as reading the newspaper or watching television',
  'Moving or speaking so slowly that other people could have noticed — or the opposite, being so fidgety or restless that you have been moving around a lot more than usual',
  'Thoughts that you would be better off dead, or of hurting yourself in some way',
] as const

export const PHQ_FREQUENCY_LABELS: Record<PhqFrequency, string> = {
  0: 'Not at all',
  1: 'Several days',
  2: 'More than half the days',
  3: 'Nearly every day',
}

export const DEFAULT_CARE_CONTEXT: CareContext = {
  checkIn: {
    responses: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    functionalImpact: 'not_difficult',
  },
  goals: [],
  lifestyle: {
    sleep: 'settled',
    mealRoutine: 'regular',
    dailySchedule: 'regular',
    alcohol: 'none',
    drivingOrMachinery: false,
    missedDoses: 'rarely',
    eatingDisorderHistory: false,
  },
  needsImmediateSupport: false,
}

function severityFor(score: number): DepressionSeverity {
  if (score <= 4) return 'minimal'
  if (score <= 9) return 'mild'
  if (score <= 14) return 'moderate'
  if (score <= 19) return 'moderately_severe'
  return 'severe'
}

export function normaliseCareContext(input: CareContext | undefined): CareContext {
  if (!input) return DEFAULT_CARE_CONTEXT
  const responses = PHQ9_ITEMS.map((_, index) => input.checkIn.responses[index] ?? 0)
  return {
    ...input,
    checkIn: { ...input.checkIn, responses },
  }
}

export function scoreDepressionCheckIn(care: CareContext): DepressionSummary {
  const score = care.checkIn.responses.reduce<number>((sum, response) => sum + response, 0)
  const severity = severityFor(score)
  const safetyResponsePositive = (care.checkIn.responses[8] ?? 0) > 0 || care.needsImmediateSupport

  return {
    instrument: 'PHQ-9',
    score,
    severity,
    functionalImpact: care.checkIn.functionalImpact,
    safetyResponsePositive,
    interpretation: {
      text:
        `The PHQ-9 score is ${score} out of 27, in the ${severity.replace('_', ' ')} symptom range. ` +
        'This is a symptom-monitoring result, not a diagnosis and not a medication recommendation.',
      citationIds: ['phq9-validation', 'nice-depression-2022'],
    },
    monitoringNote: {
      text:
        'NICE advises a first antidepressant review usually within 2 weeks after starting, or within 1 week ' +
        'for people aged 18 to 25 or where there is particular concern about suicide risk. Symptoms, side ' +
        'effects, adherence and suicidal thoughts should be reviewed separately.',
      citationIds: ['nice-depression-2022'],
    },
  }
}
