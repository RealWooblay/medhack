/**
 * Citation registry.
 *
 * Every clinical string rendered anywhere in this product resolves to one or more ids in
 * here. `resolveCitations` throws on an unknown id rather than silently rendering an
 * unsourced badge — a missing source should break the build path, not degrade quietly.
 */

import type { Citation } from '../engine/types'

export const CITATIONS: Record<string, Citation> = {
  /* ---- Guidelines ---------------------------------------------------- */
  'cpic-2023-sri': {
    id: 'cpic-2023-sri',
    label: 'CPIC 2023',
    kind: 'cpic',
    title:
      'CPIC Guideline for CYP2D6, CYP2C19, CYP2B6, SLC6A4, and HTR2A Genotypes and Serotonin Reuptake Inhibitor Antidepressants (Bousman et al., Clin Pharmacol Ther)',
    url: 'https://cpicpgx.org/guidelines/guideline-for-selective-serotonin-reuptake-inhibitors-and-cyp2d6-and-cyp2c19/',
    year: '2023',
  },
  'cpic-2016-tca': {
    id: 'cpic-2016-tca',
    label: 'CPIC 2016',
    kind: 'cpic',
    title:
      'CPIC Guideline for CYP2D6 and CYP2C19 Genotypes and Dosing of Tricyclic Antidepressants: 2016 Update (Hicks et al., Clin Pharmacol Ther)',
    url: 'https://cpicpgx.org/guidelines/guideline-for-tricyclic-antidepressants-and-cyp2d6-and-cyp2c19/',
    year: '2016',
  },
  'cpic-activity-score': {
    id: 'cpic-activity-score',
    label: 'CPIC/DPWG consensus',
    kind: 'cpic',
    title:
      'Standardizing CYP2D6 Genotype to Phenotype Translation: Consensus Recommendations from CPIC and DPWG (Caudle et al., Clin Transl Sci)',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7226310/',
    year: '2020',
  },

  /* ---- Regulatory ---------------------------------------------------- */
  'fda-interaction-table': {
    id: 'fda-interaction-table',
    label: 'FDA interaction table',
    kind: 'fda-table',
    title:
      'FDA — Drug Development and Drug Interactions: Table of Substrates, Inhibitors and Inducers',
    url: 'https://www.fda.gov/drugs/drug-interactions-labeling/drug-development-and-drug-interactions-table-substrates-inhibitors-and-inducers',
  },
  'fda-pgx-associations': {
    id: 'fda-pgx-associations',
    label: 'FDA PGx associations',
    kind: 'fda-table',
    title: 'FDA — Table of Pharmacogenetic Associations',
    url: 'https://www.fda.gov/medical-devices/precision-medicine/table-pharmacogenetic-associations',
  },

  /* ---- Tooling / provenance ------------------------------------------ */
  pharmcat: {
    id: 'pharmcat',
    label: 'PharmCAT',
    kind: 'pharmgkb',
    title:
      'PharmCAT: the Pharmacogenomics Clinical Annotation Tool (PharmGKB / Stanford). Reference implementation for VCF to star allele to CPIC recommendation.',
    url: 'https://github.com/PharmGKB/PharmCAT',
  },
  /* ---- Literature ---------------------------------------------------- */
  'lit-tyramine-2022': {
    id: 'lit-tyramine-2022',
    label: 'MAOI diet review 2022',
    kind: 'literature',
    title:
      "Van den Eynde V, et al. The Prescriber's Guide to the MAOI Diet — Thinking Through Tyramine Troubles. Psychopharmacology Bulletin. Modern tyramine measurements supporting a narrowed, quantity-aware restriction list rather than blanket prohibition.",
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9235318/',
    year: '2022',
  },
  'lit-ziprasidone-food-2009': {
    id: 'lit-ziprasidone-food-2009',
    label: 'Gandelman 2009',
    kind: 'literature',
    title:
      'Gandelman K, et al. The impact of calories and fat content of meals on oral ziprasidone absorption. J Clin Psychiatry. Absorption approaches maximum at meals of at least 500 calories; fat content does not materially affect it.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/19538903/',
    year: '2009',
  },
  'lit-discontinuation-2022': {
    id: 'lit-discontinuation-2022',
    label: 'Quilichini 2022',
    kind: 'literature',
    title:
      'Quilichini JB, et al. Comparative effects of 15 antidepressants on the risk of withdrawal syndrome: a real-world study using the WHO pharmacovigilance database. J Affect Disord. PMID 34699855. A disproportionate reporting signal, strongest for paroxetine, venlafaxine and desvenlafaxine.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/34699855/',
    year: '2022',
  },
  'lit-antipsychotic-metabolic-2020': {
    id: 'lit-antipsychotic-metabolic-2020',
    label: 'Pillinger 2020',
    kind: 'literature',
    title:
      'Pillinger T, et al. Comparative effects of 18 antipsychotics on metabolic function. Lancet Psychiatry. Establishes that metabolic risk is drug-specific rather than uniform across the class.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/31860457/',
    year: '2020',
  },

  'pharmgkb-cyp2d6-structural': {
    id: 'pharmgkb-cyp2d6-structural',
    label: 'PharmGKB CYP2D6',
    kind: 'pharmgkb',
    title:
      'PharmGKB / PharmVar CYP2D6 allele definitions, including copy number variation, gene duplication and CYP2D6-CYP2D7 hybrid structural alleles',
    url: 'https://www.pharmvar.org/gene/CYP2D6',
  },
}

/** openFDA label citations are registered at load time from the cached label data. */
export function registerLabelCitation(citation: Citation): void {
  CITATIONS[citation.id] = citation
}

export function citationFor(id: string): Citation {
  const c = CITATIONS[id]
  if (!c) throw new Error(`Unknown citation id "${id}". Every clinical claim must resolve to a registered source.`)
  return c
}

export function resolveCitations(ids: string[]): Citation[] {
  return ids.map(citationFor)
}
