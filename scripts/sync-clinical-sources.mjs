#!/usr/bin/env node

/**
 * Refresh the two regulatory snapshots used by the deterministic runtime.
 *
 * The generated files are committed so a clinical result never changes because an API
 * changed between requests. Refreshes are explicit, reviewable source-data updates.
 */

import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FDA_CYP_URL =
  'https://www.fda.gov/drugs/drug-interactions-labeling/healthcare-professionals-fdas-examples-drugs-interact-cyp-enzymes-and-transporter-systems'
const OPENFDA_URL = 'https://api.fda.gov/drug/label.json'
const OPENFDA_NDC_URL = 'https://api.fda.gov/drug/ndc.json'

// A source record is selected once, then pinned by SPL set_id. Changing a set_id is a
// clinical-data review, not an automatic "latest label" substitution.
const LABEL_SET_IDS = {
  amitriptyline: '0067b698-ee1d-4524-b1cc-af1028d13736',
  bupropion: '004d8121-59d4-46c4-acb8-b2dd097bf556',
  citalopram: '0109f365-bebd-4810-a56f-4451e10245db',
  desvenlafaxine: '0f43610c-f290-46ea-d186-4f998ed99fce',
  duloxetine: '00628e5e-4c5b-2573-e063-6294a90a0e3b',
  escitalopram: '0458445b-e431-4c82-86b8-90373813c10a',
  fluoxetine: '02283de9-6087-45f7-a9ce-3b082ce860de',
  mirtazapine: '0f19ab40-1a30-4ac2-9bd7-c2f8199e29e1',
  nortriptyline: '017f7717-e160-4142-9a5a-1a2bd9776707',
  paroxetine: '009d8b89-eab9-43ba-b077-86bfa993a745',
  sertraline: '00179766-980b-44b0-99d3-1fee2bb27e37',
  venlafaxine: '017a84aa-0e1f-f560-e063-6294a90a9069',
  vilazodone: '0374fbb1-b0fb-4150-b1e7-92e2b0d32ecf',
  vortioxetine: '1a5b68e2-14d0-419d-9ec6-1ca97145e838',
}

const LABEL_EVIDENCE = {
  amitriptyline: {
    'amitriptyline-driving': {
      fields: ['information_for_patients', 'precautions'],
      exact: ['patients should be advised as to the possible impairment of mental and/or physical abilities required for performance of hazardous tasks, such as operating machinery or driving a motor vehicle'],
    },
  },
  bupropion: {
    'bupropion-alcohol': {
      fields: ['information_for_patients', 'spl_medguide'],
      exact: [
        'Advise patients to minimize or avoid the use of alcohol.',
        'the excessive use or the abrupt discontinuation of alcohol, benzodiazepines, antiepileptic drugs, or sedatives/hypnotics can increase the risk of seizure',
      ],
    },
    'bupropion-eating-disorder': {
      fields: ['contraindications', 'spl_medguide', 'warnings_and_cautions'],
      exact: ['Current or prior diagnosis of bulimia or anorexia nervosa'],
    },
  },
  citalopram: {
    'citalopram-daily': {
      fields: ['dosage_and_administration'],
      exact: ['Administer once daily with or without food'],
    },
  },
  desvenlafaxine: {
    'desvenlafaxine-time': {
      fields: ['dosage_and_administration'],
      exact: ['with or without food', 'PRISTIQ should be taken at approximately the same time each day.'],
    },
    'desvenlafaxine-alcohol': {
      fields: ['information_for_patients', 'drug_interactions', 'spl_medguide'],
      exact: ['Advise patients to avoid alcohol while taking PRISTIQ'],
    },
  },
  duloxetine: {
    'duloxetine-food': {
      fields: ['dosage_and_administration'],
      exact: ['Administer Duloxetine delayed-release capsules orally (with or without meals)'],
    },
    'duloxetine-heavy-alcohol': {
      fields: ['warnings_and_cautions', 'drug_interactions'],
      exact: ['concomitantly with heavy alcohol intake may be associated with severe liver injury'],
    },
  },
  escitalopram: {
    'escitalopram-timing': {
      fields: ['dosage_and_administration'],
      exact: ['Administer once daily, morning or evening, with or without food'],
    },
    'escitalopram-driving': {
      fields: ['warnings_and_cautions'],
      exact: ['patients should be cautioned about operating hazardous machinery, including automobiles, until they are reasonably certain that escitalopram therapy does not affect their ability'],
    },
  },
  fluoxetine: {
    'fluoxetine-morning': {
      fields: ['dosage_and_administration'],
      exact: ['Initiate fluoxetine 20 mg/day orally in the morning.'],
    },
    'fluoxetine-driving': {
      fields: ['warnings_and_cautions'],
      exact: ['Patients should be cautioned about operating hazardous machinery, including automobiles, until they are reasonably certain that the drug treatment does not affect them adversely.'],
    },
  },
  mirtazapine: {
    'mirtazapine-evening': {
      fields: ['dosage_and_administration'],
      exact: ['Administer orally once daily, preferably in the evening prior to sleep.'],
    },
    'mirtazapine-somnolence': {
      fields: ['warnings_and_cautions'],
      exact: ['Somnolence: May impair judgment, thinking and/or motor skills.'],
    },
    'mirtazapine-driving': {
      fields: ['warnings_and_cautions'],
      exact: ['Use with caution when engaging in activities requiring alertness, such as driving or operating machinery.'],
    },
  },
  nortriptyline: {
    'nortriptyline-driving': {
      fields: ['warnings', 'information_for_patients'],
      exact: ['may impair the mental and/or physical abilities required for the performance of hazardous tasks, such as operating machinery or driving a car'],
    },
  },
  paroxetine: {
    'paroxetine-morning': {
      fields: ['dosage_and_administration'],
      exact: ['Administer paroxetine tablets as a single daily dose in the morning, with or without food.'],
    },
  },
  sertraline: {
    'sertraline-food': {
      fields: ['spl_medguide'],
      exact: ['Sertraline tablets may be taken with or without food.'],
    },
    'sertraline-alcohol': {
      fields: ['information_for_patients', 'precautions'],
      exact: ['the concomitant use of sertraline hydrochloride and alcohol is not advised.'],
    },
  },
  venlafaxine: {
    'venlafaxine-food-time': {
      fields: ['dosage_and_administration'],
      exact: ['taken with food'],
    },
    'venlafaxine-driving': {
      fields: ['information_for_patients', 'precautions'],
      exact: ['patients should be cautioned about operating hazardous machinery, including automobiles, until they are reasonably certain that venlafaxine tablets therapy does not adversely affect their ability'],
    },
    'venlafaxine-alcohol': {
      fields: ['information_for_patients', 'precautions'],
      exact: ['patients should be advised to avoid alcohol while taking venlafaxine tablets.'],
    },
  },
  vilazodone: {
    'vilazodone-food': {
      fields: ['dosage_and_administration'],
      exact: ['Recommended target dosage: 20 mg to 40 mg once daily with food'],
    },
  },
  vortioxetine: {
    'vortioxetine-food': {
      fields: ['dosage_and_administration'],
      exact: ['administered orally once daily without regard to meals'],
    },
    'vortioxetine-ibuprofen-bleeding': {
      fields: ['warnings_and_cautions'],
      exact: ['Concomitant use of aspirin, nonsteroidal anti-inflammatory drugs (NSAIDs), warfarin, and other anticoagulants may add to this risk.'],
    },
  },
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decodeHtml(value) {
  return value
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&ge;/gi, '≥')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json,text/html', 'user-agent': 'antidepressant-pgx-source-sync/1.0' },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
  return response.text()
}

function parseCypSnapshot(html) {
  const current = html.match(/Content current as of:[\s\S]{0,250}?datetime="(\d{4}-\d{2}-\d{2})/i)?.[1]
  const table = html.match(/<table[^>]+summary="Table 1\."[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i)?.[1]
  if (!current || !table) throw new Error('FDA CYP page no longer matches the reviewed table structure.')

  const effectsByDrug = new Map()
  const columns = [
    'strong_inhibitor', 'moderate_inhibitor', 'weak_inhibitor',
    'strong_inducer', 'moderate_inducer', 'weak_inducer',
  ]
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1]))
    if (cells.length !== 11) throw new Error(`Unexpected FDA CYP row width: ${cells.length}`)
    const drug = cells[0].toLowerCase()
    const effects = []
    columns.forEach((effect, index) => {
      for (const gene of ['CYP2D6', 'CYP2C19', 'CYP2B6']) {
        const token = gene.replace('CYP', '')
        if (new RegExp(`(?:^|[^0-9A-Z])${token}(?:$|[^0-9A-Z])`, 'i').test(cells[index + 1])) {
          effects.push({ gene, effect })
        }
      }
    })
    if (effects.length) {
      const existing = effectsByDrug.get(drug) ?? []
      effectsByDrug.set(drug, [...existing, ...effects])
    }
  }

  const modifiers = [...effectsByDrug.entries()]
    .map(([drug, effects]) => ({
      drug,
      effects: [...new Map(effects.map((effect) => [`${effect.gene}:${effect.effect}`, effect])).values()]
        .sort((a, b) => `${a.gene}:${a.effect}`.localeCompare(`${b.gene}:${b.effect}`)),
    }))
    .sort((a, b) => a.drug.localeCompare(b.drug))

  const has = (drug, gene, effect) => modifiers.some((row) =>
    row.drug === drug && row.effects.some((item) => item.gene === gene && item.effect === effect))
  const sentinels = [
    ['bupropion', 'CYP2D6', 'strong_inhibitor'],
    ['fluoxetine', 'CYP2C19', 'strong_inhibitor'],
    ['fluoxetine', 'CYP2D6', 'strong_inhibitor'],
    ['sertraline', 'CYP2D6', 'weak_inhibitor'],
    ['rifampin', 'CYP2C19', 'strong_inducer'],
    ['rifampin', 'CYP2B6', 'moderate_inducer'],
  ]
  for (const sentinel of sentinels) {
    if (!has(...sentinel)) throw new Error(`FDA CYP sentinel missing: ${sentinel.join(' / ')}`)
  }

  const snapshot = {
    schemaVersion: 1,
    authority: 'US Food and Drug Administration',
    title: "FDA's Examples of Drugs that Interact with CYP Enzymes and Transporter Systems",
    sourceUrl: FDA_CYP_URL,
    contentCurrentAsOf: current,
    scope: ['CYP2D6', 'CYP2C19', 'CYP2B6'],
    completeness: 'Complete extraction of inhibitor and inducer rows for the three listed enzymes; the FDA table itself is non-exhaustive.',
    modifiers,
  }
  return { ...snapshot, sourceDigestSha256: digest(snapshot) }
}

function normaliseSourceText(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function extractEvidence(record, generic) {
  const requested = LABEL_EVIDENCE[generic]
  if (!requested) throw new Error(`No evidence specification for ${generic}`)
  return Object.fromEntries(Object.entries(requested).map(([id, spec]) => {
    for (const field of spec.fields) {
      const text = Array.isArray(record[field]) ? normaliseSourceText(record[field].join(' ')) : ''
      if (!text) continue
      const exactText = []
      let supported = true
      for (const expected of spec.exact) {
        const index = text.toLocaleLowerCase('en-US').indexOf(expected.toLocaleLowerCase('en-US'))
        if (index === -1) {
          supported = false
          break
        }
        exactText.push(text.slice(index, index + expected.length))
      }
      if (supported) return [id, { sourceField: field, exactText }]
    }
    throw new Error(`Pinned ${generic} label does not contain reviewed evidence for ${id}`)
  }))
}

async function fetchLabel(generic, setId) {
  const query = new URL(OPENFDA_URL)
  query.searchParams.set('search', `set_id:"${setId}"`)
  query.searchParams.set('limit', '1')
  const payload = JSON.parse(await fetchText(query))
  const record = payload.results?.[0]
  if (!record || record.set_id !== setId) throw new Error(`Pinned SPL not returned for ${generic}: ${setId}`)

  const productNdc = record.openfda?.product_ndc?.[0]
  if (!productNdc) throw new Error(`Pinned SPL has no product NDC for ${generic}: ${setId}`)
  const ndcQuery = new URL(OPENFDA_NDC_URL)
  ndcQuery.searchParams.set('search', `product_ndc:"${productNdc}"`)
  ndcQuery.searchParams.set('limit', '1')
  const ndcPayload = JSON.parse(await fetchText(ndcQuery))
  const ndcRecord = ndcPayload.results?.[0]
  if (
    !ndcRecord ||
    ndcRecord.product_ndc !== productNdc ||
    ndcRecord.application_number !== record.openfda?.application_number?.[0] ||
    typeof ndcRecord.dosage_form !== 'string' ||
    !ndcRecord.dosage_form.trim()
  ) {
    throw new Error(`FDA NDC record did not verify the dosage form for ${generic}: ${productNdc}`)
  }

  const evidence = extractEvidence(record, generic)
  const label = {
    generic,
    setId,
    versionId: record.id,
    effectiveTime: record.effective_time ?? null,
    openFdaApiCurrentAsOf: payload.meta?.last_updated ?? null,
    manufacturer: record.openfda?.manufacturer_name?.[0] ?? null,
    productName: record.openfda?.brand_name?.[0] ?? null,
    dosageForm: ndcRecord.dosage_form,
    productNdc,
    route: record.openfda?.route ?? [],
    productType: record.openfda?.product_type?.[0] ?? null,
    applicationNumber: record.openfda?.application_number?.[0] ?? null,
    sourceUrl: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`,
    apiUrl: query.toString(),
    ndcApiUrl: ndcQuery.toString(),
    evidence,
  }
  return { ...label, sourceDigestSha256: digest(label) }
}

async function main() {
  const cyp = parseCypSnapshot(await fetchText(FDA_CYP_URL))
  const labels = []
  for (const [generic, setId] of Object.entries(LABEL_SET_IDS)) labels.push(await fetchLabel(generic, setId))
  labels.sort((a, b) => a.generic.localeCompare(b.generic))

  const labelSnapshot = {
    schemaVersion: 1,
    authority: 'US FDA Structured Product Labeling via openFDA; stable display links use DailyMed',
    selectionPolicy: 'Each product is explicitly pinned by SPL set_id. A set_id change requires clinical review.',
    labels,
  }

  await writeFile(`${ROOT}/src/data/sources/fda-cyp-modifiers.json`, `${JSON.stringify(cyp, null, 2)}\n`)
  await writeFile(`${ROOT}/src/data/sources/fda-labels.json`, `${JSON.stringify(labelSnapshot, null, 2)}\n`)
}

await main()
