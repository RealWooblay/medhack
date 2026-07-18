import { describe, expect, it } from 'vitest'
import { CITATIONS } from '../../data/citations'
import { FDA_CYP_SOURCE, effectOf } from '../../data/interactions'
import { INTERACTION_RULES, LIFESTYLE_RULES, interactionRulesFor, rulesForDrug } from '../../data/lifestyle-rules'
import { FDA_LABEL_SOURCE, LABELS, evidenceFor } from '../../data/openfda'
import { buildProtocol } from '../lifestyle'
import { computePhenoconversion } from '../phenoconversion'
import type { GeneCall } from '../types'

function cyp2d6(overrides: Partial<GeneCall> = {}): GeneCall {
  return {
    gene: 'CYP2D6',
    callSource: 'MATCHER',
    alleleDefinitionVersion: 'test',
    phenotypeVersion: 'test',
    diplotype: '*1/*4',
    phenotype: 'Intermediate Metabolizer',
    activityScore: 1,
    positionsCalled: null,
    positionsMissing: null,
    missingPositionLabels: [],
    coverageScope: 'report-json-only',
    structuralVariationUnresolved: true,
    ...overrides,
  }
}

describe('versioned regulatory data', () => {
  it('loads a dated, integrity-labelled FDA CYP snapshot', () => {
    expect(FDA_CYP_SOURCE.contentCurrentAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(FDA_CYP_SOURCE.sourceDigestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(FDA_CYP_SOURCE.completeness).toMatch(/non-exhaustive/i)

    expect(effectOf('bupropion', 'CYP2D6')).toBe('strong_inhibitor')
    expect(effectOf('fluoxetine', 'CYP2C19')).toBe('strong_inhibitor')
    expect(effectOf('sertraline', 'CYP2D6')).toBe('weak_inhibitor')
    expect(effectOf('rifampin', 'CYP2C19')).toBe('strong_inducer')
    expect(effectOf('rifampin', 'CYP2B6')).toBe('moderate_inducer')
  })

  it('pins every prescribing-information record and every rendered rule to exact evidence', () => {
    expect(FDA_LABEL_SOURCE.recordCount).toBeGreaterThan(0)
    for (const label of Object.values(LABELS)) {
      expect(label.setId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(label.versionId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(label.sourceDigestSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(label.sourceUrl).toContain(label.setId)
      expect(label.dosageForm).toMatch(/\S/)
      expect(label.productNdc).toMatch(/^\d{4,5}-\d{3,4}$/)
      expect(label.ndcApiUrl).toContain(encodeURIComponent(label.productNdc))
    }

    const rules = [...LIFESTYLE_RULES, ...INTERACTION_RULES]
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length)
    for (const rule of rules) {
      expect(evidenceFor(rule.id)).not.toBeNull()
      expect(rule.citationIds).toHaveLength(1)
      expect(CITATIONS[rule.citationIds[0]]).toMatchObject({ kind: 'fda-label' })
    }
  })

  it('normalises brands for lifestyle and interaction rules', () => {
    expect(rulesForDrug('Zoloft').map((rule) => rule.id)).toContain('sertraline-food')
    expect(interactionRulesFor('Trintellix', ['Advil']).map((rule) => rule.id))
      .toContain('vortioxetine-ibuprofen-bleeding')
    expect(buildProtocol('Trintellix', ['Nurofen']).interactionItems).toHaveLength(1)
  })
})

describe('bounded phenoconversion estimates', () => {
  it('does not model a multi-modifier regimen as if it were one inhibitor', () => {
    const result = computePhenoconversion(cyp2d6(), ['fluoxetine', 'bupropion'])
    expect(result.status).toBe('unvalidated_method')
    expect(result.modeledFunctionalPhenotype).toBeNull()
    expect(result.unresolvedWarning?.text).toMatch(/multi-modifier|all classified modifiers/i)
  })

  it('deduplicates brand/generic repetitions before applying a modifier', () => {
    const result = computePhenoconversion(cyp2d6(), ['Prozac', 'fluoxetine'])
    expect(result.modifiers).toHaveLength(1)
    expect(result.status).toBe('uncertain_extent')
  })

  it('does not calculate an estimate from an indeterminate or invalid activity score', () => {
    const indeterminate = computePhenoconversion(
      cyp2d6({ phenotype: 'Indeterminate' }),
      ['fluoxetine'],
    )
    const invalid = computePhenoconversion(cyp2d6({ activityScore: -1 }), ['fluoxetine'])
    expect(indeterminate.status).toBe('unvalidated_method')
    expect(indeterminate.modeledFunctionalPhenotype).toBeNull()
    expect(invalid.status).toBe('unvalidated_method')
    expect(invalid.modeledFunctionalPhenotype).toBeNull()
  })
})
