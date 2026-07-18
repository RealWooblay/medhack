/**
 * The upload path.
 *
 * The fixtures render to real 23andMe-format files, so round-tripping one through the
 * parser and the tag-SNP caller proves the upload path works rather than asserting it does.
 */

import { describe, expect, it } from 'vitest'
import { TagSnpAdapter, parseGenomeFile } from '../pharmcat/adapter'
import { fixtureToFileText, fixtureById } from '../pharmcat/fixtures'
import { runAnalysis } from '../pipeline'

const VCF_SAMPLE = `##fileformat=VCFv4.2
##contig=<ID=chr10>
#CHROM	POS	ID	REF	ALT	QUAL	FILTER	INFO	FORMAT	SAMPLE
chr10	94781859	rs4244285	G	A	.	PASS	.	GT	0/1
chr10	94761900	rs12248560	C	T	.	PASS	.	GT	0/0
chr22	42128945	rs3892097	G	A	.	PASS	.	GT	0/0
`

describe('genome file parsing', () => {
  it('round-trips a fixture through the 23andMe format', () => {
    const fixture = fixtureById('demo-phenoconversion')!
    const parsed = parseGenomeFile(fixtureToFileText(fixture))

    expect(parsed.format).toBe('23andme')
    expect(parsed.calls).toEqual(fixture.calls)
  })

  it('parses a VCF, resolving genotypes against REF and ALT', () => {
    const parsed = parseGenomeFile(VCF_SAMPLE)

    expect(parsed.format).toBe('vcf')
    expect(parsed.calls.rs4244285).toBe('GA') // heterozygous -> CYP2C19*1/*2
    expect(parsed.calls.rs12248560).toBe('CC')
    expect(parsed.calls.rs3892097).toBe('GG')
  })

  it('ignores rsIDs it does not care about, and malformed lines', () => {
    const noisy = `# comment\nrs99999999\t1\t123\tAA\nrs4244285\t10\t94781859\tAG\nbroken line\n`
    const parsed = parseGenomeFile(noisy)

    expect(Object.keys(parsed.calls)).toEqual(['rs4244285'])
  })
})

describe('an uploaded file produces the same analysis as the fixture', () => {
  it('reaches the same phenotypes through the tag-SNP caller', async () => {
    const fixture = fixtureById('demo-phenoconversion')!
    const contents = fixtureToFileText(fixture)

    const result = await runAnalysis({
      adapter: new TagSnpAdapter(),
      genome: { fileName: 'uploaded.txt', contents, assayType: 'consumer-array' },
      input: {
        genomeFileName: 'uploaded.txt',
        assayType: 'consumer-array',
        currentMedications: ['fluoxetine'],
        pastTrials: fixture.suggestedTrials,
      },
    })

    const cyp2d6 = result.genes.find((g) => g.gene === 'CYP2D6')!
    const cyp2c19 = result.genes.find((g) => g.gene === 'CYP2C19')!

    expect(cyp2c19.diplotype).toBe('*1/*2')
    expect(cyp2c19.geneticPhenotype).toBe('Intermediate Metabolizer')
    expect(cyp2d6.diplotype).toBe('*1/*1')
    expect(cyp2d6.functionalPhenotype).toBe('Poor Metabolizer')
    expect(result.shortlist.filter((d) => !d.isCurrentMedication)[0].drug).toBe('sertraline')
  })

  it('reports an indeterminate phenotype rather than guessing when a gene has no coverage', async () => {
    // A file carrying only CYP2C19 positions says nothing about CYP2D6.
    const partial = `# rsid\tchromosome\tposition\tgenotype\nrs4244285\t10\t94781859\tAG\n`

    const result = await runAnalysis({
      adapter: new TagSnpAdapter(),
      genome: { fileName: 'partial.txt', contents: partial, assayType: 'consumer-array' },
      input: {
        genomeFileName: 'partial.txt',
        assayType: 'consumer-array',
        currentMedications: [],
        pastTrials: [],
      },
    })

    const cyp2d6 = result.genes.find((g) => g.gene === 'CYP2D6')!
    expect(cyp2d6.geneticPhenotype).toBe('Indeterminate')
    expect(cyp2d6.functionalPhenotype).toBe('Indeterminate')
    expect(cyp2d6.confidence.level).toBe('low')
    expect(cyp2d6.diplotype).toBe('unknown')
  })
})
