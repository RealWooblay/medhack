/**
 * Compact test snapshot of PharmCAT's official Example 1 Reporter JSON.
 *
 * This is not a hand-authored clinical scenario and it is never used as a runtime fallback.
 * The values below were captured from the official output at the source URL on 2026-07-18;
 * the browser validation demo fetches the full current file directly from PharmCAT.
 */

import type { AssayType, PharmCATReport, Phenotype } from '../types'
import {
  PharmCATReportJsonAdapter,
  type GenomeInput,
  type PharmCATAdapter,
} from './adapter'

export const OFFICIAL_EXAMPLE_SOURCE =
  'https://pharmcat.clinpgx.org/examples/pharmcat.example.report.json'

interface CapturedGene {
  gene: 'CYP2C19' | 'CYP2D6' | 'CYP2B6'
  label: string
  phenotype: Phenotype
  activityScore?: string | null
  callSource: 'MATCHER' | 'OUTSIDE'
}

const capturedGenes: CapturedGene[] = [
  { gene: 'CYP2C19', label: '*38/*38', phenotype: 'Normal Metabolizer', activityScore: null, callSource: 'MATCHER' },
  { gene: 'CYP2D6', label: '*1/*3', phenotype: 'Intermediate Metabolizer', activityScore: '1.0', callSource: 'OUTSIDE' },
  { gene: 'CYP2B6', label: '*1/*1', phenotype: 'Normal Metabolizer', activityScore: null, callSource: 'MATCHER' },
]

function capturedDiplotype(gene: CapturedGene): Record<string, unknown> {
  return {
    gene: gene.gene,
    label: gene.label,
    phenotypes: [gene.phenotype],
    activityScore: gene.activityScore ?? null,
  }
}

function capturedGeneReport(gene: CapturedGene): Record<string, unknown> {
  const diplotype = capturedDiplotype(gene)
  return {
    callSource: gene.callSource,
    alleleDefinitionVersion: '2026-07-13-11-40',
    phenotypeVersion: '2026-07-13-11-40',
    sourceDiplotypes: [diplotype],
    recommendationDiplotypes: [diplotype],
    uncalledHaplotypes: [],
    variants: [{}],
  }
}

interface CapturedRecommendation {
  drug: string
  text: string
  classification: string
  url: string
  genes: CapturedGene['gene'][]
  dosingInformation: boolean
}

const capturedRecommendations: CapturedRecommendation[] = [
  {
    drug: 'amitriptyline',
    text: 'Consider a 25% reduction of recommended starting dose. Utilize therapeutic drug monitoring to guide dose adjustments.',
    classification: 'Moderate',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166105006',
    genes: ['CYP2C19', 'CYP2D6'],
    dosingInformation: true,
  },
  {
    drug: 'citalopram',
    text: 'Initiate therapy with recommended starting dose',
    classification: 'Strong',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166127638',
    genes: ['CYP2C19'],
    dosingInformation: false,
  },
  {
    drug: 'escitalopram',
    text: 'Initiate therapy with recommended starting dose',
    classification: 'Strong',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166127638',
    genes: ['CYP2C19'],
    dosingInformation: false,
  },
  {
    drug: 'nortriptyline',
    text: 'Consider a 25% reduction of recommended starting dose. Titrate dose to observed clinical response with symptom improvement and minimal (if any) side effects. Utilize therapeutic drug monitoring to guide dose adjustments.',
    classification: 'Optional',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166104998',
    genes: ['CYP2D6'],
    dosingInformation: true,
  },
  {
    drug: 'paroxetine',
    text: 'Consider a lower starting dose and slower titration schedule as compared to normal metabolizers.',
    classification: 'Optional',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166127636',
    genes: ['CYP2D6'],
    dosingInformation: true,
  },
  {
    drug: 'sertraline',
    text: 'Initiate therapy with recommended starting dose.',
    classification: 'Strong',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166127639',
    genes: ['CYP2B6', 'CYP2C19'],
    dosingInformation: false,
  },
  {
    drug: 'venlafaxine',
    text: 'No action recommended based on genotype for venlafaxine because of minimal evidence regarding the impact on efficacy or side effects.',
    classification: 'No recommendation',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166288201',
    genes: ['CYP2D6'],
    dosingInformation: false,
  },
  {
    drug: 'vortioxetine',
    text: 'Initiate therapy with recommended starting dose.',
    classification: 'Moderate',
    url: 'https://www.clinpgx.org/guidelineAnnotation/PA166288221',
    genes: ['CYP2D6'],
    dosingInformation: false,
  },
]

function capturedDrugReport(recommendation: CapturedRecommendation): Record<string, unknown> {
  return {
    name: recommendation.drug,
    urls: [recommendation.url],
    guidelines: [{
      url: recommendation.url,
      annotations: [{
        drugRecommendation: recommendation.text,
        classification: recommendation.classification,
        population: 'general',
        dosingInformation: recommendation.dosingInformation,
        alternateDrugAvailable: false,
        otherPrescribingGuidance: false,
        genotypes: [{
          diplotypes: recommendation.genes.map((name) =>
            capturedDiplotype(capturedGenes.find((gene) => gene.gene === name)!),
          ),
        }],
      }],
    }],
  }
}

export const CAPTURED_PHARMCAT_EXAMPLE = {
  title: 'pharmcat.example',
  timestamp: '2026-07-13T22:32:26.437Z',
  pharmcatVersion: 'v3.3.0-8-g8ff5870f',
  dataVersion: '2026-07-13-11-40',
  genes: Object.fromEntries(capturedGenes.map((gene) => [gene.gene, capturedGeneReport(gene)])),
  drugs: {
    'CPIC Guideline Annotation': Object.fromEntries(
      capturedRecommendations.map((recommendation) => [
        recommendation.drug,
        capturedDrugReport(recommendation),
      ]),
    ),
  },
}

export const CAPTURED_PHARMCAT_EXAMPLE_JSON = JSON.stringify(CAPTURED_PHARMCAT_EXAMPLE)

/** Test-only adapter that still exercises the production Reporter JSON parser. */
export class CapturedPharmCATExampleAdapter implements PharmCATAdapter {
  readonly name = 'Captured official PharmCAT example'
  readonly provenance = 'pharmcat-json' as const

  async analyze(input: GenomeInput): Promise<PharmCATReport> {
    const adapter = new PharmCATReportJsonAdapter()
    return adapter.analyze({
      ...input,
      contents: CAPTURED_PHARMCAT_EXAMPLE_JSON,
    })
  }
}

export const CAPTURED_EXAMPLE_ASSAY: AssayType = 'unknown'
