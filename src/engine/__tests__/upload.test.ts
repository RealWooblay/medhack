import { describe, expect, it } from 'vitest'
import {
  parseGenomeFile,
  PharmCATReportJsonAdapter,
  recommendationActionFromText,
} from '../pharmcat/adapter'
import {
  CAPTURED_EXAMPLE_ASSAY,
  CAPTURED_PHARMCAT_EXAMPLE,
  CAPTURED_PHARMCAT_EXAMPLE_JSON,
} from '../pharmcat/fixtures'
import { runAnalysis } from '../pipeline'

const VCF_SAMPLE = `##fileformat=VCFv4.2
##contig=<ID=chr10>
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t0/1
chr10\t94761900\trs12248560\tC\tT\t.\tPASS\t.\tGT\t0/0
`

describe('raw-file syntax inspection helper', () => {
  it('can read selected marker syntax without producing a star allele', () => {
    const parsed = parseGenomeFile(VCF_SAMPLE)
    expect(parsed.format).toBe('vcf')
    expect(parsed.calls).toEqual({ rs4244285: 'GA', rs12248560: 'CC' })
  })

  it('does not coerce missing or invalid VCF allele indexes to reference', () => {
    const parsed = parseGenomeFile(`${VCF_SAMPLE}
chr10\t94780653\trs4986893\tG\tA\t.\tPASS\t.\tGT\t./.
chr22\t42130692\trs1065852\tG\tA\t.\tPASS\t.\tGT\t2/2`)
    expect(parsed.calls.rs4986893).toBeUndefined()
    expect(parsed.calls.rs1065852).toBeUndefined()
  })
})

describe('official PharmCAT Reporter JSON import', () => {
  it('parses the captured official example through the production adapter', async () => {
    const result = await runAnalysis({
      adapter: new PharmCATReportJsonAdapter(),
      genome: {
        fileName: 'pharmcat.example.report.json',
        contents: CAPTURED_PHARMCAT_EXAMPLE_JSON,
        assayType: CAPTURED_EXAMPLE_ASSAY,
      },
      input: {
        genomeFileName: 'pharmcat.example.report.json',
        assayType: CAPTURED_EXAMPLE_ASSAY,
        currentMedications: [],
        pastTrials: [],
      },
    })

    expect(result.pharmcat.pharmcatVersion).toBe('v3.3.0-8-g8ff5870f')
    expect(result.pharmcat.pharmcatDataVersion).toBe('2026-07-13-11-40')
    expect(result.genes.find((gene) => gene.gene === 'CYP2C19')).toMatchObject({
      diplotype: '*38/*38',
      geneticPhenotype: 'Normal Metabolizer',
    })
    expect(result.genes.find((gene) => gene.gene === 'CYP2D6')?.confidence.level).toBe('low')
  })

  it('preserves PharmCAT combined-gene annotations instead of intersecting flat rows', async () => {
    const report = await new PharmCATReportJsonAdapter().analyze({
      fileName: 'pharmcat.example.report.json',
      contents: CAPTURED_PHARMCAT_EXAMPLE_JSON,
      assayType: CAPTURED_EXAMPLE_ASSAY,
    })
    const sertraline = report.recommendations.find((item) => item.drug === 'sertraline')!
    const amitriptyline = report.recommendations.find((item) => item.drug === 'amitriptyline')!

    expect(sertraline.geneResults).toEqual([
      { gene: 'CYP2B6', phenotype: 'Normal Metabolizer' },
      { gene: 'CYP2C19', phenotype: 'Normal Metabolizer' },
    ])
    expect(amitriptyline.geneResults.map((item) => item.gene)).toEqual(['CYP2C19', 'CYP2D6'])
    expect(amitriptyline.action).toBe('decrease_start')
  })

  it('fails closed for malformed or generic JSON', async () => {
    const adapter = new PharmCATReportJsonAdapter()
    await expect(adapter.analyze({ fileName: 'bad.json', contents: '{', assayType: 'unknown' }))
      .rejects.toThrow(/not valid PharmCAT/i)
    await expect(adapter.analyze({ fileName: 'generic.json', contents: '{}', assayType: 'unknown' }))
      .rejects.toThrow(/supported PharmCAT Reporter structure/i)
  })

  it('accepts a valid Reporter result with no matched recommendations and creates no filler rows', async () => {
    const empty = structuredClone(CAPTURED_PHARMCAT_EXAMPLE) as Record<string, unknown>
    empty.drugs = {}
    const result = await runAnalysis({
      adapter: new PharmCATReportJsonAdapter(),
      genome: {
        fileName: 'no-recommendations.report.json',
        contents: JSON.stringify(empty),
        assayType: CAPTURED_EXAMPLE_ASSAY,
      },
      input: {
        genomeFileName: 'no-recommendations.report.json',
        assayType: CAPTURED_EXAMPLE_ASSAY,
        currentMedications: [],
        pastTrials: [],
      },
    })
    expect(result.pharmcat.recommendations).toEqual([])
    expect(result.shortlist).toEqual([])
  })

  it('does not substitute recommendation diplotypes for a missing source call', async () => {
    const changed = structuredClone(CAPTURED_PHARMCAT_EXAMPLE)
    changed.genes.CYP2D6.sourceDiplotypes = []
    const report = await new PharmCATReportJsonAdapter().analyze({
      fileName: 'missing-source.report.json',
      contents: JSON.stringify(changed),
      assayType: CAPTURED_EXAMPLE_ASSAY,
    })
    expect(report.genes.find((gene) => gene.gene === 'CYP2D6')).toMatchObject({
      diplotype: 'ambiguous or no call',
      phenotype: 'Indeterminate',
      activityScore: null,
    })
  })

  it('drops untrusted guideline URLs and does not turn an availability flag into a switch action', async () => {
    const changed = structuredClone(CAPTURED_PHARMCAT_EXAMPLE)
    const citalopram = changed.drugs['CPIC Guideline Annotation'].citalopram as {
      urls: string[]
      guidelines: Array<{
        url: string
        annotations: Array<{ alternateDrugAvailable: boolean }>
      }>
    }
    citalopram.urls = ['javascript:alert(1)']
    citalopram.guidelines[0].url = 'https://attacker.example/fake-guideline'
    citalopram.guidelines[0].annotations[0].alternateDrugAvailable = true
    const report = await new PharmCATReportJsonAdapter().analyze({
      fileName: 'untrusted-url.report.json',
      contents: JSON.stringify(changed),
      assayType: CAPTURED_EXAMPLE_ASSAY,
    })
    const recommendation = report.recommendations.find((item) => item.drug === 'citalopram')!
    expect(recommendation.sourceUrl).toBeUndefined()
    expect(recommendation.alternateDrugAvailable).toBe(true)
    expect(recommendation.action).toBe('standard')
  })

  it('does not relabel non-antidepressant PharmCAT annotations with an antidepressant guideline source', async () => {
    const changed = structuredClone(CAPTURED_PHARMCAT_EXAMPLE)
    const citalopram = structuredClone(changed.drugs['CPIC Guideline Annotation'].citalopram)
    citalopram.name = 'clopidogrel'
    changed.drugs['CPIC Guideline Annotation'].clopidogrel = citalopram
    const report = await new PharmCATReportJsonAdapter().analyze({
      fileName: 'mixed-specialty.report.json',
      contents: JSON.stringify(changed),
      assayType: CAPTURED_EXAMPLE_ASSAY,
    })
    expect(report.recommendations.some((item) => item.drug === 'clopidogrel')).toBe(false)
  })

  it('uses recommendation wording only to create neutral UI groups', () => {
    expect(recommendationActionFromText('Initiate therapy with recommended starting dose.')).toBe('standard')
    expect(recommendationActionFromText('Consider a 25% reduction of recommended starting dose.')).toBe('decrease_start')
    expect(recommendationActionFromText('Avoid use. Consider an alternative drug.')).toBe('avoid')
    expect(recommendationActionFromText('Consider a clinically appropriate antidepressant not predominantly metabolized by CYP2C19.')).toBe('alternative')
    expect(recommendationActionFromText('Consider a slower titration schedule and lower maintenance dose, or select a clinically appropriate alternative.')).toBe('alternative')
    expect(recommendationActionFromText('No recommendation.')).toBe('no_recommendation')
  })
})

describe('recommendationActionFromText branch order', () => {
  // Real CPIC wording. Both of these open by telling the prescriber to start at the normal
  // dose, then qualify it. Before the anchored branch was moved ahead of the unanchored
  // avoid/alternative tests, both were classified into the most alarming bucket and the row
  // rendered under "Discuss a different medicine" while quoting a guideline that says the
  // opposite.
  it('does not read a trailing switch clause as "choose a different drug"', () => {
    const cyp2c19RapidCitalopram =
      'Initiate therapy with recommended starting dose. If patient does not adequately respond '
      + 'to recommended maintenance dosing, consider titrating to a higher maintenance dose or '
      + 'switching to a clinically appropriate alternative antidepressant not predominantly '
      + 'metabolized by CYP2C19.'

    expect(recommendationActionFromText(cyp2c19RapidCitalopram)).toBe(
      'standard_start_conditional_increase',
    )
  })

  it('does not read "to avoid adverse effects" as an instruction to avoid the drug', () => {
    const doseGuidance =
      'Initiate therapy with recommended starting dose. Consider a slower titration schedule '
      + 'and a lower maintenance dose to avoid adverse effects.'

    expect(recommendationActionFromText(doseGuidance)).toBe('standard_start_reduced_maintenance')
  })

  it('still classifies genuine avoid and alternative wording', () => {
    expect(recommendationActionFromText('Avoid amitriptyline use.')).toBe('avoid')
    expect(
      recommendationActionFromText('Select alternative drug not predominantly metabolized by CYP2D6.'),
    ).toBe('alternative')
  })
})
