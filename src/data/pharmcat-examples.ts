/** Real, non-patient examples published by the PharmCAT project. */
export interface OfficialPharmCATExample {
  id: string
  title: string
  description: string
  reportUrl: string
  sourcePageUrl: string
  suggestedMedications: string[]
}

export const OFFICIAL_PHARMCAT_EXAMPLES: OfficialPharmCATExample[] = [
  {
    id: 'pharmcat-example-1',
    title: 'Official example: normal-function calls + CYP2D6 outside call',
    description: 'Published PharmCAT output with CYP2C19, CYP2B6 and an outside CYP2D6 call.',
    reportUrl: 'https://pharmcat.clinpgx.org/examples/pharmcat.example.report.json',
    sourcePageUrl: 'https://pharmcat.clinpgx.org/examples/',
    suggestedMedications: [],
  },
  {
    id: 'pharmcat-example-2',
    title: 'Official example: non-reference alleles',
    description: 'Published PharmCAT output with CYP2C19 *2/*2, CYP2B6 *1/*6 and no CYP2D6 result.',
    reportUrl: 'https://pharmcat.clinpgx.org/examples/pharmcat.example2.report.json',
    sourcePageUrl: 'https://pharmcat.clinpgx.org/examples/',
    suggestedMedications: [],
  },
]
