import { describe, expect, it } from 'vitest'
import { assembleJourney, hasJourneyContent, type PersonContext } from '../journey'
import type { GenePhenotypeResult } from '../types'

const genes = [
  { gene: 'CYP2C19', geneticPhenotype: 'Intermediate Metabolizer', functionalPhenotype: 'Intermediate Metabolizer', modeledFunctionalPhenotype: null, converted: false } as unknown as GenePhenotypeResult,
]

function person(over: Partial<PersonContext> = {}): PersonContext {
  return {
    drug: 'sertraline', phase: 'first_weeks', dayLabel: 'day 9',
    signals: [], substances: [], goals: [],
    diet: { pattern: 'no_restriction', allergies: [], eatingDisorderHistory: false, budgetConscious: false },
    ...over,
  }
}

describe('journey assembly — the deterministic half', () => {
  it('has journey content for the drugs the app recommends', () => {
    for (const d of ['sertraline', 'fluoxetine', 'venlafaxine', 'mirtazapine']) {
      expect(hasJourneyContent(d), d).toBe(true)
    }
  })

  it('fires more actions when the person reports side effects', () => {
    const base = assembleJourney(person(), genes)
    const withNausea = assembleJourney(person({ signals: ['nausea'] }), genes)
    expect(withNausea.approvedActions.length).toBeGreaterThan(base.approvedActions.length)
    expect(withNausea.approvedActions.some((a) => a.signals.includes('nausea'))).toBe(true)
  })

  it('never suggests animal food to a vegan', () => {
    const ctx = assembleJourney(person({ drug: 'mirtazapine', signals: ['appetite_gain'], diet: { pattern: 'vegan', allergies: [], eatingDisorderHistory: false, budgetConscious: false } }), genes)
    const foods = ctx.approvedActions.flatMap((a) => a.foods).join(' ').toLowerCase()
    expect(foods).not.toMatch(/chicken|egg|yoghurt|yogurt|fish|beef|dairy|cheese|whey/)
  })

  it('blocks meal-structuring and weight actions for eating-disorder history', () => {
    const withoutED = assembleJourney(person({ drug: 'mirtazapine', signals: ['appetite_gain'] }), genes)
    const withED = assembleJourney(person({ drug: 'mirtazapine', signals: ['appetite_gain'], diet: { pattern: 'no_restriction', allergies: [], eatingDisorderHistory: true, budgetConscious: false } }), genes)
    const blocked = withoutED.approvedActions.filter((a) => a.contraindications.includes('eating_disorder_history'))
    expect(blocked.length).toBeGreaterThan(0)
    for (const a of withED.approvedActions) {
      expect(a.contraindications.includes('eating_disorder_history')).toBe(false)
    }
  })

  it('only ever exposes goals from matched actions — the model cannot invent one', () => {
    const ctx = assembleJourney(person({ signals: ['nausea', 'insomnia'] }), genes)
    expect(ctx.approvedGoals.length).toBeGreaterThan(0)
    for (const a of ctx.approvedActions) {
      expect(ctx.approvedGoals).toContain(a.goal)
    }
  })

  it('carries the deterministic metabolism picture as context', () => {
    const ctx = assembleJourney(person(), genes)
    expect(ctx.metabolism.join(' ')).toMatch(/CYP2C19/)
  })
})
