import { describe, expect, it } from 'vitest'
import { HISTORY_CONDITIONS, historyFlagsFor, worstHistoryEffect } from '../../data/history-modifiers'

describe('medical history changes medicine choice', () => {
  it('contraindicates bupropion for a seizure history', () => {
    const flags = historyFlagsFor('bupropion', ['seizure_history'])
    expect(worstHistoryEffect(flags)).toBe('avoid')
    expect(flags[0].reason).toMatch(/seizure threshold/i)
  })

  it('contraindicates bupropion for an eating disorder history', () => {
    expect(worstHistoryEffect(historyFlagsFor('bupropion', ['eating_disorder']))).toBe('avoid')
  })

  it('does not touch an unrelated medicine', () => {
    expect(historyFlagsFor('sertraline', ['seizure_history'])).toHaveLength(0)
  })

  it('flags the QT signal on citalopram and escitalopram for cardiac history', () => {
    for (const drug of ['citalopram', 'escitalopram']) {
      const flags = historyFlagsFor(drug, ['long_qt_cardiac'])
      expect(worstHistoryEffect(flags), drug).toBe('caution')
      expect(flags.some((f) => /QT/i.test(f.reason)), drug).toBe(true)
    }
  })

  it('applies class rules to every tricyclic', () => {
    for (const tca of ['amitriptyline', 'nortriptyline', 'imipramine']) {
      expect(worstHistoryEffect(historyFlagsFor(tca, ['glaucoma'])), tca).toBe('caution')
    }
  })

  it('prefers bupropion when sexual side effects are a dealbreaker, and cautions the SSRIs', () => {
    expect(worstHistoryEffect(historyFlagsFor('bupropion', ['priority_sexual']))).toBe('prefer')
    expect(worstHistoryEffect(historyFlagsFor('sertraline', ['priority_sexual']))).toBe('caution')
  })

  it('lets avoid win over prefer when a person has both', () => {
    // Wants to protect weight (bupropion preferred) but has a seizure history (contraindicated).
    const flags = historyFlagsFor('bupropion', ['priority_weight', 'seizure_history'])
    expect(worstHistoryEffect(flags)).toBe('avoid')
  })

  it('every condition carries a reason and a source', () => {
    for (const condition of HISTORY_CONDITIONS) {
      expect(condition.effects.length, condition.id).toBeGreaterThan(0)
      for (const effect of condition.effects) {
        expect(effect.reason.length, condition.id).toBeGreaterThan(30)
        expect(effect.source.length, condition.id).toBeGreaterThan(10)
        expect(Boolean(effect.drugs?.length) || Boolean(effect.drugClass), condition.id).toBe(true)
      }
    }
  })
})
