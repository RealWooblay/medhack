import { describe, expect, it } from 'vitest'
import { CAPTURED_PHARMCAT_EXAMPLE_JSON } from '../pharmcat/fixtures'
import { inspectGenomeInput } from '../pharmcat/input-inspection'

const VCF_HEADER = `##fileformat=VCFv4.2
##reference=GRCh38
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tPERSON_A`

describe('deterministic genome input inspection', () => {
  it('recognizes PharmCAT Reporter JSON from content, not the file extension', async () => {
    const result = await inspectGenomeInput('not-a-report.txt', CAPTURED_PHARMCAT_EXAMPLE_JSON)

    expect(result.kind).toBe('pharmcat-report-json')
    expect(result.status).toBe('ready')
    expect(result.canRunAnalysis).toBe(true)
    expect(result.blockingCode).toBeNull()
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects malformed and non-PharmCAT JSON with stable codes', async () => {
    const malformed = await inspectGenomeInput('input.json', '{"genes":')
    const generic = await inspectGenomeInput('input.json', '{"hello":"world"}')

    expect(malformed.blockingCode).toBe('MALFORMED_JSON')
    expect(generic.blockingCode).toBe('JSON_NOT_PHARMCAT_REPORT')
    expect(malformed.canRunAnalysis).toBe(false)
    expect(generic.canRunAnalysis).toBe(false)
  })

  it('accepts only a VCF with fileformat, #CHROM, sample, and GT structure', async () => {
    const result = await inspectGenomeInput('anything.bin', `${VCF_HEADER}
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT:DP\t0/1:20
chr10\t94761900\trs12248560\tC\tT\t.\tPASS\t.\tGT\t0/0
`)

    expect(result).toMatchObject({
      kind: 'vcf',
      formatLabel: 'VCF genotype file',
      status: 'limited-preview',
      blockingCode: null,
      canRunAnalysis: false,
      recognizedVariantCount: 2,
      sampleNames: ['PERSON_A'],
    })
    expect(result).not.toHaveProperty('genomeBuild')
    expect(result.warnings.join(' ')).toContain('Genome build')
    expect(result.warnings.join(' ')).toContain('official PharmCAT pipeline')
  })

  it('returns specific VCF blocking codes instead of guessing', async () => {
    const withoutFileformat = await inspectGenomeInput('sample.vcf', `#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t0/1`)
    const withoutHeader = await inspectGenomeInput('sample.vcf', `##fileformat=VCFv4.2
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t0/1`)
    const withoutGt = await inspectGenomeInput('sample.vcf', `${VCF_HEADER}
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tDP\t20`)

    expect(withoutFileformat.blockingCode).toBe('VCF_MISSING_FILEFORMAT')
    expect(withoutHeader.blockingCode).toBe('VCF_MISSING_COLUMN_HEADER')
    expect(withoutGt.blockingCode).toBe('VCF_MISSING_GT')
  })

  it('blocks a multi-sample VCF until a sample can be selected explicitly', async () => {
    const result = await inspectGenomeInput('cohort.vcf', `##fileformat=VCFv4.2
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tPERSON_A\tPERSON_B
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t0/1\t0/0`)

    expect(result.blockingCode).toBe('MULTIPLE_SAMPLES')
    expect(result.sampleNames).toEqual(['PERSON_A', 'PERSON_B'])
    expect(result.canRunAnalysis).toBe(false)
  })

  it('does not turn VCF no-calls or invalid ALT indexes into reference calls', async () => {
    const result = await inspectGenomeInput('sample.vcf', `${VCF_HEADER}
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t./.
chr10\t94761900\trs12248560\tC\tT\t.\tPASS\t.\tGT\t2/2
chr22\t42128945\trs3892097\tG\tA\t.\tPASS\t.\tGT\t0/1
`)

    expect(result.recognizedVariantCount).toBe(1)
    expect(result.warnings.join(' ')).toContain('invalid allele-index')
  })

  it('normalizes comma and whitespace consumer rows without changing allele values', async () => {
    const result = await inspectGenomeInput('consumer.csv', `# source declaration is not verified\r
rs4244285,10,94781859,ag\r
rs12248560 10 94761900 TT\r
rs3892097,22,42128945,--\r
i4000757,XY,0,II\r
`)

    expect(result).toMatchObject({
      kind: 'consumer-genotype',
      status: 'limited-preview',
      blockingCode: null,
      canRunAnalysis: false,
      recognizedVariantCount: 2,
    })
    expect(result.normalizedContents).toContain('rs4244285\t10\t94781859\tAG')
    expect(result.normalizedContents).toContain('rs12248560\t10\t94761900\tTT')
    expect(result.normalizedContents).toContain('rs3892097\t22\t42128945\t--')
    expect(result.transformations).toEqual(expect.arrayContaining([
      'Changed line endings to LF.',
      'Converted comma-delimited consumer rows to tab-delimited rows.',
      'Converted whitespace-delimited consumer rows to tab-delimited rows.',
      'Uppercased genotype letters without changing their values.',
    ]))
  })

  it('blocks malformed and mixed consumer input with stable codes', async () => {
    const malformed = await inspectGenomeInput('consumer.txt', `rs4244285 10 94781859 AG
this line cannot be normalized safely`)
    const mixed = await inspectGenomeInput('mixed.txt', `${VCF_HEADER}
rs4244285 10 94781859 AG`)

    expect(malformed.blockingCode).toBe('MALFORMED_CONSUMER_ROWS')
    expect(mixed.blockingCode).toBe('AMBIGUOUS_FORMAT')
    expect(mixed.kind).toBe('unknown')
  })

  it('blocks conflicting duplicate supported calls', async () => {
    const consumer = await inspectGenomeInput('consumer.txt', `rs4244285\t10\t94781859\tAG
rs4244285\t10\t94781859\tGG`)
    const vcf = await inspectGenomeInput('sample.vcf', `${VCF_HEADER}
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t0/1
chr10\t94781859\trs4244285\tG\tA\t.\tPASS\t.\tGT\t0/0`)

    expect(consumer.blockingCode).toBe('CONFLICTING_DUPLICATE')
    expect(vcf.blockingCode).toBe('CONFLICTING_DUPLICATE')
    expect(consumer.canRunAnalysis).toBe(false)
    expect(vcf.canRunAnalysis).toBe(false)
  })

  it('keeps consumer -- as a no-call and refuses to produce a result', async () => {
    const result = await inspectGenomeInput('consumer.txt', 'rs4244285\t10\t94781859\t--\n')

    expect(result.kind).toBe('consumer-genotype')
    expect(result.recognizedVariantCount).toBe(0)
    expect(result.blockingCode).toBeNull()
    expect(result.canRunAnalysis).toBe(false)
  })

  it('does not use a plausible file name to classify unknown content', async () => {
    const result = await inspectGenomeInput('looks-valid.vcf', 'not genome data')

    expect(result.kind).toBe('unknown')
    expect(result.blockingCode).toBe('UNRECOGNIZED_FORMAT')
  })
})
