/**
 * Extension 5 — the lifestyle protocol.
 *
 * Every rule here is sourced. Where a figure appeared in an earlier draft that could not be
 * traced back to the source it claimed, it was corrected or removed rather than softened —
 * an adversarial verification pass against the primary literature found several such
 * numbers, and the corrections are noted inline where they changed the advice.
 *
 * The raw captured research sits in `sources/lifestyle-rules.json`. This file is the
 * curated, corrected ruleset the product actually renders.
 *
 * Tone matters here more than in any other file. This is read by someone who is depressed
 * and has already had two medications not work. Rules are written to be actionable and
 * calm — no hedging, no alarm, and no implication that they have done something wrong.
 */

import { citeLabel } from './openfda'
import type { ProtocolCategory, Severity } from '../engine/types'

export interface LifestyleRule {
  id: string
  /** Generic names this applies to. */
  drugs: string[]
  label: string
  icon: string
  category: ProtocolCategory
  severity: Severity
  /** Patient-facing instruction. */
  rule: string
  /** One sentence of mechanism. */
  why: string
  citationIds: string[]
}

const SSRIS = ['fluoxetine', 'sertraline', 'paroxetine', 'citalopram', 'escitalopram', 'fluvoxamine']
const SNRIS = ['venlafaxine', 'desvenlafaxine', 'duloxetine', 'levomilnacipran']
const SEROTONERGIC = [...SSRIS, ...SNRIS, 'vortioxetine', 'vilazodone']

export const LIFESTYLE_RULES: LifestyleRule[] = [
  /* ---- Timing ------------------------------------------------------- */
  {
    id: 'fluoxetine-morning',
    drugs: ['fluoxetine'],
    label: 'MORNING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'Take fluoxetine in the morning.',
    why:
      'The label directs morning dosing, and fluoxetine tends to be activating — an evening dose is more ' +
      'likely to disturb sleep.',
    citationIds: citeLabel('fluoxetine', 'dosage_and_administration'),
  },
  {
    id: 'paroxetine-morning',
    drugs: ['paroxetine'],
    label: 'MORNING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'Take paroxetine as a single dose in the morning, with or without food.',
    why: 'This is the dosing schedule the label specifies.',
    citationIds: citeLabel('paroxetine', 'dosage_and_administration'),
  },
  {
    id: 'sertraline-timing',
    drugs: ['sertraline'],
    label: 'ANY TIME',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule:
      'Take sertraline once a day at whatever time you will actually remember. Pick one time and keep to it.',
    why:
      'The label does not specify morning or evening. Consistency matters more than the hour, because a steady ' +
      'level in your blood is what the dose is designed around.',
    citationIds: citeLabel('sertraline', 'dosage_and_administration'),
  },
  {
    id: 'escitalopram-timing',
    drugs: ['escitalopram', 'citalopram'],
    label: 'ANY TIME',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'Take once daily, in the morning or the evening, with or without food.',
    why: 'The label explicitly allows either, so choose the one you are most likely to keep to.',
    citationIds: citeLabel('escitalopram', 'dosage_and_administration'),
  },
  {
    id: 'bupropion-morning',
    drugs: ['bupropion'],
    label: 'MORNING',
    icon: '☀',
    category: 'timing',
    severity: 'caution',
    rule:
      'Take bupropion in the morning. If you are on a twice-daily form, leave at least 8 hours between doses ' +
      'and do not take the second dose late in the day.',
    why:
      'Bupropion is activating and commonly disturbs sleep. Spacing the doses also keeps the peak level down, ' +
      'which matters because bupropion lowers the seizure threshold.',
    citationIds: citeLabel('bupropion', 'dosage_and_administration'),
  },
  {
    id: 'mirtazapine-evening',
    drugs: ['mirtazapine'],
    label: 'EVENING',
    icon: '🌙',
    category: 'timing',
    severity: 'info',
    rule: 'Take mirtazapine at bedtime.',
    why: 'It is strongly sedating, which is useful at night and unhelpful during the day.',
    citationIds: citeLabel('mirtazapine', 'dosage_and_administration'),
  },
  {
    id: 'trazodone-evening',
    drugs: ['trazodone'],
    label: 'EVENING',
    icon: '🌙',
    category: 'timing',
    severity: 'info',
    // Corrected: the label frames bedtime dosing as a response to drowsiness, not a standing instruction.
    rule:
      'If trazodone makes you drowsy, the label notes that taking the larger part of the daily dose at bedtime ' +
      '— or lowering the dose — is the usual answer. Ask your prescriber which applies to you.',
    why: 'Drowsiness is the most commonly reported effect, and shifting the timing usually resolves it.',
    citationIds: citeLabel('trazodone', 'dosage_and_administration'),
  },

  /* ---- Food --------------------------------------------------------- */
  {
    id: 'sertraline-food',
    drugs: ['sertraline'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'info',
    rule:
      'No food restrictions. You can take sertraline with or without food — though taking it with a meal often ' +
      'settles early stomach upset.',
    why:
      'Food slightly increases how much you absorb and raises the peak level by about 25%, which is not enough ' +
      'to matter clinically but is enough to make it gentler on an empty stomach.',
    citationIds: [...citeLabel('sertraline', 'food_effect'), ...citeLabel('sertraline', 'dosage_and_administration')],
  },
  {
    id: 'vilazodone-food',
    drugs: ['vilazodone'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'caution',
    rule: 'Always take vilazodone with food. Never on an empty stomach.',
    why:
      'Taken fasting, absorption drops by roughly half, which can quietly make a correct-looking dose ' +
      'ineffective.',
    citationIds: citeLabel('vilazodone', 'food_effect'),
  },
  {
    id: 'ziprasidone-food',
    drugs: ['ziprasidone'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'caution',
    // Corrected: cite §12.3 Clinical Pharmacology rather than a version-dependent section number.
    rule:
      'Take ziprasidone twice a day with a real meal of at least 500 calories. A snack is not enough. Fat ' +
      'content does not matter — total calories do.',
    why:
      'Absorption approaches its maximum only with a meal of that size. With a small meal you can absorb ' +
      'dramatically less, so the dose on the box is not the dose you get.',
    citationIds: ['lit-ziprasidone-food-2009', ...citeLabel('ziprasidone', 'food_effect')],
  },
  {
    // Narrowed deliberately. An earlier version also asserted how common early GI effects
    // are, which could not be sourced to a per-drug label section that was actually
    // captured — so the unsourceable half of the claim was removed rather than attributed
    // to a neighbouring drug's label.
    id: 'ssri-gi-food',
    drugs: SEROTONERGIC,
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'info',
    rule: 'If your dose upsets your stomach, taking it with a meal usually helps.',
    why:
      'Food does not meaningfully change how much of the drug you absorb, so pairing the dose with a meal ' +
      'costs nothing and settles the stomach.',
    citationIds: citeLabel('sertraline', 'food_effect'),
  },

  /* ---- Avoid -------------------------------------------------------- */
  {
    id: 'sertraline-alcohol',
    drugs: ['sertraline'],
    label: 'AVOID',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    // Corrected: cite the sertraline label directly rather than asserting a class-wide statement.
    rule: 'The sertraline label advises against drinking alcohol while taking it.',
    why:
      'This is a direct label instruction. Notably, the same label reports that sertraline did not itself cause ' +
      'sedation or impair psychomotor performance in testing — so the caution is about the combination, not ' +
      'about the drug making you drowsy.',
    citationIds: citeLabel('sertraline', 'warnings_and_cautions'),
  },
  {
    id: 'bupropion-alcohol',
    drugs: ['bupropion'],
    label: 'AVOID',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule:
      'Keep alcohol low and steady. If you drink regularly, do not stop abruptly while on bupropion — talk to ' +
      'your prescriber about how to reduce it safely.',
    why:
      'Bupropion lowers the seizure threshold, and abrupt alcohol withdrawal raises it further. It is the ' +
      'combination of the two that carries the risk.',
    citationIds: citeLabel('bupropion', 'warnings_and_cautions'),
  },
  {
    id: 'bupropion-eating-disorder',
    drugs: ['bupropion'],
    label: 'TELL YOUR DOCTOR',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule:
      'Bupropion is not suitable if you have or have ever had bulimia or anorexia nervosa. Tell your prescriber ' +
      'if this applies to you.',
    why: 'Seizure risk is substantially higher in these patients.',
    citationIds: citeLabel('bupropion', 'warnings_and_cautions'),
  },
  {
    id: 'ssri-nsaid',
    drugs: SEROTONERGIC,
    label: 'CHECK FIRST',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    rule:
      'Check with your prescriber before using ibuprofen, naproxen or aspirin regularly. Occasional use is ' +
      'usually fine.',
    why:
      'Both raise bleeding risk, and taken together the effect is larger than either alone. Paracetamol is the ' +
      'usual alternative for everyday pain.',
    citationIds: citeLabel('escitalopram', 'warnings_and_cautions'),
  },
  {
    id: 'ssri-maoi',
    drugs: SEROTONERGIC,
    label: 'NEVER COMBINE',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule:
      'Never take this alongside an MAOI such as phenelzine or tranylcypromine, and leave the full washout gap ' +
      'your prescriber sets when switching between them.',
    why: 'The combination can cause serotonin syndrome, which is a medical emergency.',
    citationIds: citeLabel('phenelzine', 'warnings_and_cautions'),
  },

  /* ---- Watch -------------------------------------------------------- */
  {
    id: 'ssri-taper',
    drugs: SEROTONERGIC,
    label: 'WATCH',
    icon: '👁',
    category: 'watch',
    severity: 'caution',
    rule:
      'Do not stop suddenly, even if you feel better or the drug is not helping. Ask for a taper plan.',
    why:
      'Every label in this class recommends reducing the dose gradually rather than stopping abruptly. Stopping ' +
      'suddenly causes withdrawal effects that are easy to mistake for the depression returning.',
    citationIds: citeLabel('sertraline', 'warnings_and_cautions'),
  },
  {
    id: 'short-half-life-taper',
    drugs: ['paroxetine', 'venlafaxine', 'desvenlafaxine'],
    label: 'WATCH',
    icon: '👁',
    category: 'watch',
    severity: 'caution',
    // Corrected: described as a disproportionate reporting signal, not an incidence rate.
    rule:
      'These need an especially slow, planned taper, and you will notice a missed dose quickly. Keep a few ' +
      'days spare so you never run out.',
    why:
      'They leave the body fast. In the WHO pharmacovigilance database these three carry the strongest ' +
      'reporting signal for withdrawal reactions of the antidepressants studied.',
    citationIds: ['lit-discontinuation-2022', ...citeLabel('paroxetine', 'warnings_and_cautions')],
  },
  {
    id: 'fluoxetine-easy-stop',
    drugs: ['fluoxetine'],
    label: 'WATCH',
    icon: '👁',
    category: 'watch',
    severity: 'info',
    rule:
      'Fluoxetine is the gentlest antidepressant to come off, and a missed dose is much less noticeable than ' +
      'with most others.',
    why:
      'It stays in the body for weeks after the last dose, so levels fall slowly on their own. That is an ' +
      'advantage when stopping and a complication when switching.',
    citationIds: citeLabel('fluoxetine', 'warnings_and_cautions'),
  },
  {
    id: 'serotonin-syndrome',
    drugs: SEROTONERGIC,
    label: 'URGENT',
    icon: '👁',
    category: 'watch',
    severity: 'critical',
    rule:
      'Get urgent medical help for agitation or confusion combined with fever, heavy sweating, shivering, a ' +
      'racing heart, muscle twitching or stiffness.',
    why:
      'Together these can indicate serotonin syndrome. It is uncommon, it is treatable, and it needs to be seen ' +
      'the same day.',
    citationIds: citeLabel('sertraline', 'warnings_and_cautions'),
  },
  {
    id: 'driving',
    drugs: [...SEROTONERGIC, 'mirtazapine', 'trazodone'],
    label: 'WATCH',
    icon: '👁',
    category: 'watch',
    severity: 'caution',
    rule:
      'Do not drive or use machinery until you know how this affects you — the first week or two, and again ' +
      'after any dose change.',
    why: 'The label advises this until you are reasonably certain your ability is unaffected.',
    citationIds: citeLabel('escitalopram', 'warnings_and_cautions'),
  },
  {
    id: 'suicidality-monitoring',
    drugs: [...SEROTONERGIC, 'bupropion', 'mirtazapine', 'trazodone', 'nortriptyline', 'amitriptyline'],
    label: 'EARLY WEEKS',
    icon: '👁',
    category: 'watch',
    severity: 'critical',
    rule:
      'Tell someone you trust that you are starting this, and arrange a check-in for the first few weeks. If ' +
      'your mood drops sharply or you start having thoughts of harming yourself, contact your prescriber or ' +
      'emergency services straight away.',
    why:
      'Every antidepressant carries a boxed warning about increased suicidal thoughts and behaviours in ' +
      'children, adolescents and young adults, particularly in the early weeks and after dose changes. Being ' +
      'watched by someone is the practical protection.',
    citationIds: citeLabel('sertraline', 'boxed_warning'),
  },

  /* ---- Critical protocol drugs --------------------------------------- */
  {
    id: 'maoi-tyramine',
    drugs: ['phenelzine', 'tranylcypromine', 'isocarboxazid'],
    label: 'AVOID',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    // Corrected: quantity-aware, modern list. Blanket historical prohibitions removed.
    rule:
      'Avoid aged and matured cheeses, cured or fermented meats and sausages, soy sauce, miso, fermented ' +
      'soybean products, yeast extracts such as Marmite, and spontaneously fermented beers such as lambic. ' +
      'Ordinary draught beer is best limited rather than banned.',
    why:
      'These concentrate tyramine, which an MAOI stops you breaking down. Enough of it causes a sudden ' +
      'dangerous rise in blood pressure.',
    citationIds: ['lit-tyramine-2022', ...citeLabel('phenelzine', 'warnings_and_cautions')],
  },
  {
    id: 'maoi-low-risk-foods',
    drugs: ['phenelzine', 'tranylcypromine', 'isocarboxazid'],
    label: 'FINE TO EAT',
    icon: '🍽',
    category: 'food',
    severity: 'info',
    // Corrected: avocado and banana moved out of the unqualified low-risk list.
    rule:
      'Much of the old restriction list is now considered low risk in normal portions: fresh and commercial ' +
      'processed cheeses, fresh meat and fish, chocolate, and most wine. Avocado and banana are fine in normal ' +
      'amounts but not in large quantities.',
    why:
      'Modern measurements show most of these foods contain far less tyramine than the historical lists ' +
      'assumed. Over-restricting makes the diet unliveable without making it safer.',
    citationIds: ['lit-tyramine-2022'],
  },
  {
    id: 'maoi-freshness',
    drugs: ['phenelzine', 'tranylcypromine', 'isocarboxazid'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'caution',
    // Corrected: refrigeration slows tyramine formation but does not stop it.
    rule:
      'Eat food fresh. Avoid leftovers kept for several days, and anything spoiled or past its date, even if it ' +
      'has been refrigerated throughout.',
    why:
      'Tyramine builds up as protein ages. Refrigeration slows that down but does not stop it — beef held at ' +
      'fridge temperature keeps accumulating tyramine over weeks.',
    citationIds: ['lit-tyramine-2022'],
  },
  {
    id: 'maoi-crisis',
    drugs: ['phenelzine', 'tranylcypromine', 'isocarboxazid'],
    label: 'URGENT',
    icon: '👁',
    category: 'watch',
    severity: 'critical',
    rule:
      'Seek urgent care for a sudden severe headache, especially with a pounding or racing heartbeat, neck ' +
      'stiffness, nausea or sweating.',
    why: 'This is the presentation of a hypertensive crisis and needs treating immediately.',
    citationIds: citeLabel('phenelzine', 'warnings_and_cautions'),
  },
  {
    id: 'lithium-sodium',
    drugs: ['lithium'],
    label: 'FOOD',
    icon: '🍽',
    category: 'metabolic',
    severity: 'critical',
    rule:
      'Keep your daily salt intake steady. Do not start a low-salt diet, a sudden high-salt diet, or a new ' +
      'crash diet without telling your prescriber.',
    why:
      'Your kidneys handle lithium and sodium through the same route. Cutting salt makes your body hold on to ' +
      'lithium, and the level can climb into the toxic range without the dose changing at all.',
    citationIds: citeLabel('lithium carbonate', 'warnings_and_cautions'),
  },
  {
    id: 'lithium-fluid',
    drugs: ['lithium'],
    label: 'HYDRATION',
    icon: '💧',
    category: 'hydration',
    severity: 'critical',
    rule:
      'Drink fluids steadily through the day — the label points to roughly 2,500 to 3,000 mL. Take extra care ' +
      'in hot weather, during heavy exercise or sauna use, and if you have vomiting or diarrhoea.',
    why:
      'Dehydration concentrates lithium in the blood. The situations that dehydrate you fastest are exactly the ' +
      'ones that push the level toward toxicity.',
    citationIds: citeLabel('lithium carbonate', 'dosage_and_administration'),
  },
  {
    id: 'lithium-nsaid',
    drugs: ['lithium'],
    label: 'CHECK FIRST',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule:
      'Check with your prescriber before using ibuprofen, naproxen or other anti-inflammatory painkillers.',
    why: 'They reduce blood flow through the kidney, which raises lithium levels.',
    citationIds: citeLabel('lithium carbonate', 'drug_interactions'),
  },
  {
    id: 'lithium-toxicity',
    drugs: ['lithium'],
    label: 'URGENT',
    icon: '👁',
    category: 'watch',
    severity: 'critical',
    // Corrected: symptom list matched to the label's own Medication Guide wording.
    rule:
      'Stop lithium and contact your prescriber if you develop an abnormal heartbeat, vomiting, diarrhoea, ' +
      'drowsiness, weak muscles, blurred vision, clumsiness, ringing in the ears or muscle twitching.',
    why: 'These are the label\'s listed signs of lithium toxicity, which needs prompt attention.',
    citationIds: citeLabel('lithium carbonate', 'warnings_and_cautions'),
  },
  {
    id: 'antipsychotic-metabolic',
    drugs: ['olanzapine', 'clozapine'],
    label: 'MONITOR',
    icon: '⚖',
    category: 'metabolic',
    severity: 'caution',
    rule:
      'Ask for weight, blood sugar and cholesterol checks before you start and regularly afterwards. Building ' +
      'in activity and a plan for meals from week one is far easier than reversing weight gain later.',
    why:
      'Olanzapine and clozapine carry the highest metabolic burden of the antipsychotics, and the gain is ' +
      'fastest in the first months.',
    citationIds: ['lit-antipsychotic-metabolic-2020', ...citeLabel('olanzapine', 'warnings_and_cautions')],
  },
  {
    id: 'antipsychotic-metabolic-not-class',
    drugs: ['olanzapine', 'clozapine', 'aripiprazole', 'quetiapine', 'risperidone', 'lurasidone', 'ziprasidone'],
    label: 'CONTEXT',
    icon: '⚖',
    category: 'metabolic',
    severity: 'info',
    rule:
      'This metabolic risk is specific to certain drugs, not true of the whole class. Aripiprazole, lurasidone ' +
      'and ziprasidone sit at the low end.',
    why:
      'A direct comparison of 18 antipsychotics found the metabolic effect varies widely between them, so ' +
      '"antipsychotics cause weight gain" is too blunt to be useful.',
    citationIds: ['lit-antipsychotic-metabolic-2020'],
  },
]

/* ------------------------------------------------------------------ */
/* Rules triggered by the patient's OTHER medications                   */
/* ------------------------------------------------------------------ */

export interface InteractionRule {
  id: string
  /** Present in the patient's current medication list. */
  triggerDrug: string
  /** Applies when the drug being planned is in this list; empty means any. */
  appliesTo: string[]
  label: string
  icon: string
  category: ProtocolCategory
  severity: Severity
  rule: string
  why: string
  citationIds: string[]
}

export const INTERACTION_RULES: InteractionRule[] = [
  {
    id: 'sjw-ssri',
    triggerDrug: "St John's Wort",
    appliesTo: SEROTONERGIC,
    label: 'STOP AND ASK',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule:
      "Do not combine St John's Wort with this medication. If you are already taking both, tell your prescriber " +
      'before stopping either.',
    why:
      'Together they raise serotonin activity enough to risk serotonin syndrome, and St John\'s Wort also speeds ' +
      'up the breakdown of many other drugs.',
    citationIds: ['fda-interaction-table'],
  },
  {
    id: 'sjw-antipsychotic',
    triggerDrug: "St John's Wort",
    appliesTo: ['aripiprazole', 'quetiapine', 'olanzapine', 'risperidone'],
    label: 'STOP AND ASK',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule: "Do not start St John's Wort alongside an antipsychotic.",
    why:
      "St John's Wort strongly induces CYP3A4, which clears these drugs. Levels can fall far enough for the " +
      'medication to stop working.',
    citationIds: ['fda-interaction-table'],
  },
  {
    id: 'tramadol-serotonergic',
    triggerDrug: 'tramadol',
    appliesTo: SEROTONERGIC,
    label: 'TELL YOUR DOCTOR',
    icon: '👁',
    category: 'watch',
    severity: 'caution',
    rule:
      'Tell your prescriber you take tramadol before starting this. If you need both, watch for the serotonin ' +
      'syndrome signs listed above.',
    why:
      'Tramadol is serotonergic in its own right, and it also relies on CYP2D6 both to work as a painkiller and ' +
      'to be cleared.',
    citationIds: ['fda-interaction-table'],
  },
  {
    id: 'nsaid-bleeding',
    triggerDrug: 'ibuprofen',
    appliesTo: SEROTONERGIC,
    label: 'CHECK FIRST',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    rule: 'You are already taking ibuprofen. Ask your prescriber whether to continue it alongside this.',
    why: 'Taken together, the bleeding risk is higher than with either alone.',
    citationIds: ['fda-interaction-table'],
  },
]

export function rulesForDrug(drug: string): LifestyleRule[] {
  const d = drug.toLowerCase()
  return LIFESTYLE_RULES.filter((r) => r.drugs.some((x) => x.toLowerCase() === d))
}

export function interactionRulesFor(drug: string, currentMedications: string[]): InteractionRule[] {
  const d = drug.toLowerCase()
  const meds = currentMedications.map((m) => m.toLowerCase())
  return INTERACTION_RULES.filter(
    (r) =>
      meds.includes(r.triggerDrug.toLowerCase()) &&
      (r.appliesTo.length === 0 || r.appliesTo.some((x) => x.toLowerCase() === d)),
  )
}
