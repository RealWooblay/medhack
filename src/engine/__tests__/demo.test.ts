import { describe, expect, it } from 'vitest'
import { runAnalysis } from '../pipeline'
import { FixturePharmCATAdapter, fixtureById } from '../pharmcat/fixtures'
import { adversarialProbe, factsFrom } from '../orchestrator'
import { buildAllowList, splitSentences, validateDraft } from '../validator'
import { CITATIONS } from '../../data/citations'
import type { AnalysisResult, Draft, PatientInput } from '../types'

async function runFixture(id: string, overrides: Partial<PatientInput> = {}): Promise<AnalysisResult> {
  const fixture = fixtureById(id)!
  const input: PatientInput = {
    genomeFileName: fixture.fileName,
    assayType: fixture.assayType,
    currentMedications: fixture.suggestedMedications,
    pastTrials: fixture.suggestedTrials,
    ...overrides,
  }
  return runAnalysis({
    adapter: new FixturePharmCATAdapter(fixture),
    genome: { fileName: fixture.fileName, assayType: fixture.assayType },
    input,
  })
}

describe('the phenoconversion demo patient', () => {
  it('converts CYP2D6 from normal to poor while fluoxetine is on board', async () => {
    const result = await runFixture('demo-phenoconversion')
    const cyp2d6 = result.genes.find((g) => g.gene === 'CYP2D6')!

    expect(cyp2d6.geneticPhenotype).toBe('Normal Metabolizer')
    expect(cyp2d6.functionalPhenotype).toBe('Poor Metabolizer')
    expect(cyp2d6.converted).toBe(true)
    expect(cyp2d6.geneticActivityScore).toBe(2)
    expect(cyp2d6.functionalActivityScore).toBe(0)
    expect(cyp2d6.modifiers[0].drug).toBe('fluoxetine')
    expect(cyp2d6.modifiers[0].effect).toBe('strong_inhibitor')
  })

  it('refuses to invent a converted CYP2C19 phenotype, and says why', async () => {
    const result = await runFixture('demo-phenoconversion')
    const cyp2c19 = result.genes.find((g) => g.gene === 'CYP2C19')!

    expect(cyp2c19.geneticPhenotype).toBe('Intermediate Metabolizer')
    // Fluoxetine is a strong CYP2C19 inhibitor, but CPIC has no validated adjustment method.
    expect(cyp2c19.functionalPhenotype).toBe('Intermediate Metabolizer')
    expect(cyp2c19.status).toBe('unvalidated_method')
    expect(cyp2c19.unresolvedWarning?.text).toMatch(/have not been\s+established/)
  })

  it('marks a fixture as non-clinical and keeps unresolved CYP2D6 low confidence', async () => {
    const result = await runFixture('demo-phenoconversion')
    const cyp2d6 = result.genes.find((g) => g.gene === 'CYP2D6')!
    const cyp2c19 = result.genes.find((g) => g.gene === 'CYP2C19')!

    expect(cyp2d6.confidence.level).toBe('low')
    expect(cyp2c19.confidence.level).toBe('moderate')
    expect(cyp2d6.confidence.reasons[0].text).toMatch(/structural variation/)
    expect(cyp2c19.confidence.reasons.some((reason) => /fictional/.test(reason.text))).toBe(true)
  })

  it('lists medication findings alphabetically rather than choosing a treatment', async () => {
    const result = await runFixture('demo-phenoconversion')
    const switchable = result.shortlist.filter((d) => !d.isCurrentMedication)

    expect(switchable.map((drug) => drug.drug)).toEqual(
      [...switchable.map((drug) => drug.drug)].sort((a, b) => a.localeCompare(b)),
    )
    expect(result.protocol?.drug).toBe(switchable[0].drug)
  })

  it('keeps PGx categories separate from a treatment recommendation', async () => {
    const result = await runFixture('demo-phenoconversion')
    const usual = result.shortlist.filter((d) => d.pgxCategory === 'usual_guidance' && !d.isCurrentMedication)
    expect(usual.map((d) => d.drug)).toEqual(['citalopram', 'escitalopram', 'sertraline'])
  })

  it('shows prior history without silently changing the PGx category', async () => {
    const result = await runFixture('demo-phenoconversion')
    const escitalopram = result.shortlist.find((d) => d.drug === 'escitalopram')!

    expect(escitalopram.pastTrial).not.toBeNull()
    expect(escitalopram.pgxCategory).toBe('usual_guidance')
    expect(escitalopram.retryRationale?.text).toMatch(/does not change the PGx category/)
  })

  it('does not infer that one recorded non-response transfers to another medicine', async () => {
    const result = await runFixture('demo-phenoconversion')
    const citalopram = result.shortlist.find((d) => d.drug === 'citalopram')!

    expect(citalopram.pastTrial).toBeNull()
    expect(citalopram.pgxCategory).toBe('usual_guidance')
    expect(citalopram.retryRationale).toBeNull()
  })

  it('labels a PGx exposure question as possible rather than a proven reason', async () => {
    const result = await runFixture('demo-ultrarapid')
    const escitalopram = result.shortlist.find((d) => d.drug === 'escitalopram')!

    expect(escitalopram.pastTrial?.explanation).toBe('possible')
    expect(escitalopram.pastTrial?.patientSummary).toMatch(/cannot show/)
    expect(escitalopram.retryRationale?.text).toMatch(/cannot infer why/)
  })

  it('puts the CYP2D6-dependent drugs in the avoid band', async () => {
    const result = await runFixture('demo-phenoconversion')
    const categoryOf = (drug: string) => result.shortlist.find((d) => d.drug === drug)?.pgxCategory

    expect(categoryOf('venlafaxine')).toBe('alternative_discussion')
    expect(categoryOf('paroxetine')).toBe('dose_or_titration_review')
    expect(categoryOf('vortioxetine')).toBe('dose_or_titration_review')
  })

  it('does not attribute paroxetine side effects without the full trial context', async () => {
    const result = await runFixture('demo-phenoconversion')
    const paroxetine = result.history.find((h) => h.drug === 'paroxetine')!

    expect(paroxetine.explanation).toBe('not_explained_by_genetics')
    expect(paroxetine.mechanism).toBeNull()
    expect(paroxetine.patientSummary).toMatch(/does not provide a supported explanation/)
  })

  it('keeps the escitalopram dosing question separate from the recorded non-response', async () => {
    const result = await runFixture('demo-phenoconversion')
    const escitalopram = result.history.find((h) => h.drug === 'escitalopram')!

    expect(escitalopram.explanation).toBe('not_explained_by_genetics')
    expect(escitalopram.mechanism?.text).toMatch(/does not establish why/)
  })

  it('does not calculate a washout treatment state without a clinician plan', async () => {
    const result = await runFixture('demo-phenoconversion')
    const text = result.narrative.accepted.flatMap((section) => section.claims).map((claim) => claim.text).join(' ')
    expect(text).toMatch(/does not create a washout, taper or cross-taper plan/)
  })
})

describe('other fixtures', () => {
  it('surfaces but does not prove an exposure explanation for non-response', async () => {
    const result = await runFixture('demo-ultrarapid')
    const cyp2c19 = result.genes.find((g) => g.gene === 'CYP2C19')!
    expect(cyp2c19.geneticPhenotype).toBe('Ultrarapid Metabolizer')

    const escitalopram = result.history.find((h) => h.drug === 'escitalopram')!
    expect(escitalopram.explanation).toBe('possible')
    expect(escitalopram.mechanism?.text).toMatch(/does not establish why/)
  })

  it('calls a genotype-only poor metaboliser with no interacting medication', async () => {
    const result = await runFixture('demo-poor-metaboliser')
    const cyp2d6 = result.genes.find((g) => g.gene === 'CYP2D6')!
    expect(cyp2d6.geneticPhenotype).toBe('Poor Metabolizer')
    expect(cyp2d6.converted).toBe(false)
    expect(cyp2d6.status).toBe('no_modifiers')
    // A targeted PGx panel resolves copy number, so confidence is not penalised.
    expect(cyp2d6.confidence.level).not.toBe('low')
  })
})

describe('the claim boundary', () => {
  it('accepts every sentence the deterministic composer produced', async () => {
    const result = await runFixture('demo-phenoconversion')

    // Every rejection must trace to the adversarial probe, never to the composer. Comparing
    // against the probe's own claim text is stricter than pattern matching on the rejection.
    const probeText = adversarialProbe(factsFrom(result))
      .claims.flatMap((c) => splitSentences(c.text))
      .map((s) => s.trim())

    for (const rejection of result.narrative.rejections) {
      expect(probeText, `unexpected rejection: ${rejection.text}`).toContain(rejection.text.trim())
    }
    expect(result.narrative.accepted.length).toBeGreaterThan(0)
  })

  it('rejects a real quantity that reuses a source number under a different unit', async () => {
    const result = await runFixture('demo-phenoconversion')
    // "50" is in the source as "50% reduction", so a bare-value check would wave "50 mg" through.
    expect(result.narrative.allowedNumbers).toContain('50')

    const allow = buildAllowList({
      facts: { note: 'Consider a 50% reduction in recommended starting dose.' },
      citationIds: ['cpic-2023-sri'],
    })
    const draft: Draft = {
      generator: 'recorded-model-run',
      model: 'test',
      claims: [{ section: 'what_next', text: 'Start at 50 mg daily.', citationIds: ['cpic-2023-sri'] }],
    }
    const report = validateDraft(draft, allow)
    expect(report.rejections).toHaveLength(1)
    expect(report.rejections[0].offendingToken).toBe('50 mg')
    expect(report.rejections[0].reason).toMatch(/different unit/)
  })

  it('rejects every adversarial probe claim, one per failure mode', async () => {
    const result = await runFixture('demo-phenoconversion')
    const kinds = result.narrative.rejections.map((r) => r.kind)

    expect(kinds).toContain('number_not_in_source')
    expect(kinds).toContain('drug_not_in_source')
    expect(kinds).toContain('citation_not_in_source')
    expect(kinds).toContain('uncited_clinical_claim')
    expect(result.narrative.rejections.length).toBeGreaterThanOrEqual(5)
  })

  it('names the exact offending token in each rejection', async () => {
    const result = await runFixture('demo-phenoconversion')
    const tokens = result.narrative.rejections.map((r) => r.offendingToken)

    expect(tokens.some((t) => t.includes('12.5') || t.includes('175') || t.includes('9'))).toBe(true)
    expect(tokens).toContain('lamotrigine')
    expect(tokens).toContain('cpic-2019-opioids')
  })

  it('renders no lifestyle rule without a resolvable citation', async () => {
    const result = await runFixture('demo-phenoconversion')

    for (const protocol of Object.values(result.protocolsByDrug)) {
      for (const item of [...protocol.items, ...protocol.interactionItems]) {
        expect(item.citationIds.length, `protocol item "${item.id}" must cite a source`).toBeGreaterThan(0)
        for (const id of item.citationIds) {
          expect(CITATIONS[id], `citation ${id} must resolve`).toBeDefined()
        }
      }
    }
    // And the protocol is not empty as a side effect of that filtering.
    expect(result.protocol!.items.length).toBeGreaterThan(0)
  })

  it('renders no clinical claim without a resolvable citation', async () => {
    const result = await runFixture('demo-phenoconversion')
    for (const section of result.narrative.accepted) {
      for (const claim of section.claims) {
        expect(claim.citationIds.length).toBeGreaterThan(0)
        for (const id of claim.citationIds) {
          expect(CITATIONS[id], `citation ${id} must resolve`).toBeDefined()
        }
      }
    }
  })
})

describe('genotype-only baseline', () => {
  it('differs from the phenoconverted result, which is the whole point', async () => {
    const result = await runFixture('demo-phenoconversion')
    const genotypeOnlyParoxetine = result.pharmcat.recommendations.find(
      (r) => r.drug === 'paroxetine' && r.gene === 'CYP2D6',
    )!
    const phenoconverted = result.shortlist.find((d) => d.drug === 'paroxetine')!.geneFindings[0]

    expect(genotypeOnlyParoxetine.phenotype).toBe('Normal Metabolizer')
    expect(genotypeOnlyParoxetine.action).toBe('standard')
    expect(phenoconverted.phenotypeUsed).toBe('Poor Metabolizer')
    expect(phenoconverted.action).toBe('decrease')
  })
})
