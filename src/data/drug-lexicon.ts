/**
 * Drug lexicon.
 *
 * Serves three jobs:
 *  1. the medication autocomplete in the input step,
 *  2. normalising brand names a patient types ("Prozac") to generics ("fluoxetine"),
 *  3. giving the constrained model-review verifier a closed drug vocabulary.
 *
 * The list is deliberately broader than the supported PGx evidence. Recognising a medicine
 * never implies that the system has guidance for it.
 */

export type DrugClass =
  | 'SSRI'
  | 'SNRI'
  | 'serotonin modulator'
  | 'atypical antidepressant'
  | 'TCA'
  | 'MAOI'
  | 'mood stabiliser'
  | 'antipsychotic'
  | 'anxiolytic / sedative'
  | 'stimulant'
  | 'other'

export interface LexiconEntry {
  generic: string
  brands: string[]
  drugClass: DrugClass
  /** Shown in the autocomplete to help a patient recognise what they take. */
  hint?: string
}

export const DRUG_LEXICON: LexiconEntry[] = [
  // ---- SSRIs -------------------------------------------------------------
  { generic: 'fluoxetine', brands: ['Prozac', 'Sarafem', 'Rapiflux', 'Selfemra'], drugClass: 'SSRI' },
  { generic: 'sertraline', brands: ['Zoloft', 'Lustral'], drugClass: 'SSRI' },
  { generic: 'paroxetine', brands: ['Paxil', 'Pexeva', 'Brisdelle', 'Seroxat'], drugClass: 'SSRI' },
  { generic: 'citalopram', brands: ['Celexa', 'Cipramil'], drugClass: 'SSRI' },
  { generic: 'escitalopram', brands: ['Lexapro', 'Cipralex'], drugClass: 'SSRI' },
  { generic: 'fluvoxamine', brands: ['Luvox', 'Faverin'], drugClass: 'SSRI' },

  // ---- SNRIs -------------------------------------------------------------
  { generic: 'venlafaxine', brands: ['Effexor', 'Effexor XR'], drugClass: 'SNRI' },
  { generic: 'desvenlafaxine', brands: ['Pristiq', 'Khedezla'], drugClass: 'SNRI' },
  { generic: 'duloxetine', brands: ['Cymbalta', 'Drizalma'], drugClass: 'SNRI' },
  { generic: 'levomilnacipran', brands: ['Fetzima'], drugClass: 'SNRI' },
  { generic: 'milnacipran', brands: ['Savella'], drugClass: 'SNRI' },

  // ---- Serotonin modulators ---------------------------------------------
  { generic: 'vortioxetine', brands: ['Trintellix', 'Brintellix'], drugClass: 'serotonin modulator' },
  { generic: 'vilazodone', brands: ['Viibryd'], drugClass: 'serotonin modulator' },
  { generic: 'trazodone', brands: ['Desyrel', 'Oleptro'], drugClass: 'serotonin modulator' },
  { generic: 'nefazodone', brands: ['Serzone'], drugClass: 'serotonin modulator' },

  // ---- Atypical ----------------------------------------------------------
  { generic: 'bupropion', brands: ['Wellbutrin', 'Zyban', 'Aplenzin', 'Forfivo'], drugClass: 'atypical antidepressant' },
  { generic: 'mirtazapine', brands: ['Remeron', 'RemeronSolTab'], drugClass: 'atypical antidepressant' },
  { generic: 'dextromethorphan-bupropion', brands: ['Auvelity'], drugClass: 'atypical antidepressant' },
  { generic: 'esketamine', brands: ['Spravato'], drugClass: 'atypical antidepressant' },

  // ---- TCAs --------------------------------------------------------------
  { generic: 'amitriptyline', brands: ['Elavil', 'Endep'], drugClass: 'TCA' },
  { generic: 'nortriptyline', brands: ['Pamelor', 'Aventyl'], drugClass: 'TCA' },
  { generic: 'desipramine', brands: ['Norpramin'], drugClass: 'TCA' },
  { generic: 'imipramine', brands: ['Tofranil'], drugClass: 'TCA' },
  { generic: 'clomipramine', brands: ['Anafranil'], drugClass: 'TCA' },
  { generic: 'doxepin', brands: ['Sinequan', 'Silenor'], drugClass: 'TCA' },
  { generic: 'trimipramine', brands: ['Surmontil'], drugClass: 'TCA' },
  { generic: 'protriptyline', brands: ['Vivactil'], drugClass: 'TCA' },

  // ---- MAOIs -------------------------------------------------------------
  { generic: 'phenelzine', brands: ['Nardil'], drugClass: 'MAOI' },
  { generic: 'tranylcypromine', brands: ['Parnate'], drugClass: 'MAOI' },
  { generic: 'isocarboxazid', brands: ['Marplan'], drugClass: 'MAOI' },
  { generic: 'selegiline', brands: ['Emsam', 'Eldepryl'], drugClass: 'MAOI' },

  // ---- Mood stabilisers --------------------------------------------------
  { generic: 'lithium', brands: ['Lithobid', 'Eskalith', 'lithium carbonate'], drugClass: 'mood stabiliser' },
  { generic: 'lamotrigine', brands: ['Lamictal'], drugClass: 'mood stabiliser' },
  { generic: 'valproate', brands: ['Depakote', 'divalproex', 'valproic acid', 'Depakene'], drugClass: 'mood stabiliser' },
  { generic: 'carbamazepine', brands: ['Tegretol', 'Equetro', 'Carbatrol'], drugClass: 'mood stabiliser' },

  // ---- Antipsychotics ----------------------------------------------------
  { generic: 'aripiprazole', brands: ['Abilify'], drugClass: 'antipsychotic' },
  { generic: 'quetiapine', brands: ['Seroquel'], drugClass: 'antipsychotic' },
  { generic: 'olanzapine', brands: ['Zyprexa'], drugClass: 'antipsychotic' },
  { generic: 'risperidone', brands: ['Risperdal'], drugClass: 'antipsychotic' },
  { generic: 'ziprasidone', brands: ['Geodon'], drugClass: 'antipsychotic' },
  { generic: 'lurasidone', brands: ['Latuda'], drugClass: 'antipsychotic' },
  { generic: 'clozapine', brands: ['Clozaril', 'Versacloz'], drugClass: 'antipsychotic' },
  { generic: 'haloperidol', brands: ['Haldol'], drugClass: 'antipsychotic' },
  { generic: 'brexpiprazole', brands: ['Rexulti'], drugClass: 'antipsychotic' },
  { generic: 'cariprazine', brands: ['Vraylar'], drugClass: 'antipsychotic' },

  // ---- Anxiolytics / sedatives -------------------------------------------
  { generic: 'alprazolam', brands: ['Xanax'], drugClass: 'anxiolytic / sedative' },
  { generic: 'lorazepam', brands: ['Ativan'], drugClass: 'anxiolytic / sedative' },
  { generic: 'clonazepam', brands: ['Klonopin'], drugClass: 'anxiolytic / sedative' },
  { generic: 'diazepam', brands: ['Valium'], drugClass: 'anxiolytic / sedative' },
  { generic: 'zolpidem', brands: ['Ambien'], drugClass: 'anxiolytic / sedative' },
  { generic: 'buspirone', brands: ['Buspar'], drugClass: 'anxiolytic / sedative' },
  { generic: 'hydroxyzine', brands: ['Vistaril', 'Atarax'], drugClass: 'anxiolytic / sedative' },

  // ---- Stimulants --------------------------------------------------------
  { generic: 'methylphenidate', brands: ['Ritalin', 'Concerta', 'Focalin'], drugClass: 'stimulant' },
  { generic: 'lisdexamfetamine', brands: ['Vyvanse'], drugClass: 'stimulant' },
  { generic: 'amphetamine', brands: ['Adderall', 'dextroamphetamine'], drugClass: 'stimulant' },
  { generic: 'atomoxetine', brands: ['Strattera'], drugClass: 'stimulant' },
  { generic: 'modafinil', brands: ['Provigil'], drugClass: 'stimulant' },

  // ---- Enzyme-relevant non-psychiatric drugs and supplements -------------
  { generic: 'quinidine', brands: [], drugClass: 'other', hint: 'heart rhythm' },
  { generic: 'terbinafine', brands: ['Lamisil'], drugClass: 'other', hint: 'fungal infection' },
  { generic: 'mirabegron', brands: ['Myrbetriq'], drugClass: 'other', hint: 'overactive bladder' },
  { generic: 'cinacalcet', brands: ['Sensipar'], drugClass: 'other', hint: 'parathyroid' },
  { generic: 'clopidogrel', brands: ['Plavix'], drugClass: 'other', hint: 'blood thinner' },
  { generic: 'ticlopidine', brands: ['Ticlid'], drugClass: 'other', hint: 'blood thinner' },
  { generic: 'omeprazole', brands: ['Prilosec', 'Losec'], drugClass: 'other', hint: 'acid reflux' },
  { generic: 'esomeprazole', brands: ['Nexium'], drugClass: 'other', hint: 'acid reflux' },
  { generic: 'pantoprazole', brands: ['Protonix'], drugClass: 'other', hint: 'acid reflux' },
  { generic: 'fluconazole', brands: ['Diflucan'], drugClass: 'other', hint: 'fungal infection' },
  { generic: 'rifampin', brands: ['Rifadin', 'rifampicin'], drugClass: 'other', hint: 'antibiotic' },
  { generic: 'efavirenz', brands: ['Sustiva'], drugClass: 'other', hint: 'HIV' },
  { generic: 'ritonavir', brands: ['Norvir'], drugClass: 'other', hint: 'HIV' },
  { generic: 'ketoconazole', brands: ['Nizoral'], drugClass: 'other', hint: 'fungal infection' },
  { generic: "St John's Wort", brands: ['hypericum', 'St. Johns Wort', 'St Johns Wort'], drugClass: 'other', hint: 'herbal supplement' },
  { generic: 'tramadol', brands: ['Ultram'], drugClass: 'other', hint: 'pain' },
  { generic: 'codeine', brands: [], drugClass: 'other', hint: 'pain' },
  { generic: 'tamoxifen', brands: ['Nolvadex'], drugClass: 'other', hint: 'breast cancer' },
  { generic: 'linezolid', brands: ['Zyvox'], drugClass: 'other', hint: 'antibiotic' },
  { generic: 'sumatriptan', brands: ['Imitrex'], drugClass: 'other', hint: 'migraine' },
  { generic: 'rizatriptan', brands: ['Maxalt'], drugClass: 'other', hint: 'migraine' },
  { generic: 'warfarin', brands: ['Coumadin'], drugClass: 'other', hint: 'blood thinner' },
  { generic: 'ibuprofen', brands: ['Advil', 'Motrin', 'Nurofen'], drugClass: 'other', hint: 'pain relief' },
  { generic: 'naproxen', brands: ['Aleve', 'Naprosyn'], drugClass: 'other', hint: 'pain relief' },
  { generic: 'aspirin', brands: ['acetylsalicylic acid'], drugClass: 'other', hint: 'pain relief' },
  { generic: 'metoprolol', brands: ['Lopressor', 'Toprol'], drugClass: 'other', hint: 'blood pressure' },
  { generic: 'propranolol', brands: ['Inderal'], drugClass: 'other', hint: 'blood pressure' },
  { generic: 'amiodarone', brands: ['Cordarone'], drugClass: 'other', hint: 'heart rhythm' },
  { generic: 'cimetidine', brands: ['Tagamet'], drugClass: 'other', hint: 'acid reflux' },
  { generic: 'diphenhydramine', brands: ['Benadryl'], drugClass: 'other', hint: 'antihistamine' },
  { generic: 'dextromethorphan', brands: ['Robitussin DM', 'Delsym'], drugClass: 'other', hint: 'cough' },
  { generic: 'ondansetron', brands: ['Zofran'], drugClass: 'other', hint: 'nausea' },
  { generic: 'phenytoin', brands: ['Dilantin'], drugClass: 'other', hint: 'seizures' },
  { generic: 'gabapentin', brands: ['Neurontin'], drugClass: 'other', hint: 'nerve pain' },
  { generic: 'pregabalin', brands: ['Lyrica'], drugClass: 'other', hint: 'nerve pain' },
  { generic: 'levothyroxine', brands: ['Synthroid', 'Levoxyl'], drugClass: 'other', hint: 'thyroid' },
  { generic: 'metformin', brands: ['Glucophage'], drugClass: 'other', hint: 'diabetes' },
  { generic: 'prednisone', brands: ['Deltasone'], drugClass: 'other', hint: 'inflammation' },
  { generic: 'oral contraceptive', brands: ['birth control pill'], drugClass: 'other', hint: 'contraception' },
]

/** generic name -> entry */
export const BY_GENERIC: Record<string, LexiconEntry> = Object.fromEntries(
  DRUG_LEXICON.map((e) => [e.generic.toLowerCase(), e]),
)

/**
 * Every recognised surface form (generic and brand, lowercased) mapped to its generic.
 * Sorted longest-first at match time so "lithium carbonate" wins over "lithium".
 */
export const SURFACE_FORMS: Array<{ form: string; generic: string }> = DRUG_LEXICON.flatMap((e) => [
  { form: e.generic.toLowerCase(), generic: e.generic },
  ...e.brands.map((b) => ({ form: b.toLowerCase(), generic: e.generic })),
]).sort((a, b) => b.form.length - a.form.length)

export function canonicalDrug(name: string): string | null {
  const needle = name.trim().toLowerCase()
  const hit = SURFACE_FORMS.find((s) => s.form === needle)
  return hit ? hit.generic : null
}

export function drugClassOf(generic: string): DrugClass | null {
  return BY_GENERIC[generic.toLowerCase()]?.drugClass ?? null
}

/**
 * Find every drug mentioned in a block of free text, returning canonical generics.
 * Word-boundary matched, longest-form-first so brand names containing a generic
 * (or multiword forms) are not double counted.
 */
export function findDrugMentions(text: string): Array<{ surface: string; generic: string; index: number }> {
  const found: Array<{ surface: string; generic: string; index: number }> = []
  const claimed: Array<[number, number]> = []
  const lower = text.toLowerCase()

  for (const { form, generic } of SURFACE_FORMS) {
    // Escape regex metacharacters that appear in names like "St John's Wort".
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(lower)) !== null) {
      const start = m.index
      const end = start + m[0].length
      const overlaps = claimed.some(([s, e]) => start < e && end > s)
      if (overlaps) continue
      claimed.push([start, end])
      found.push({ surface: text.slice(start, end), generic, index: start })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}
