/**
 * Journey assembly.
 *
 * This is the deterministic half of the "my first weeks" experience, and it is where the
 * product's integrity lives. The model that writes the plan never chooses what is
 * clinically appropriate — it is handed an already-approved set of actions and goals for
 * this specific person, and its only job is to sequence and personalise them.
 *
 * The pipeline per request:
 *   1. Match the action library on drug, phase, the side effects the person actually
 *      reports, and the substances they actually use.
 *   2. Drop any action a stated constraint contraindicates (eating-disorder history is the
 *      load-bearing one — it blocks every meal-structuring and weight-focused action).
 *   3. Filter food suggestions against diet and allergies.
 *   4. Fold the person's genetic exposure picture in as context, so the plan can say "you
 *      clear this slowly, so watch the first weeks" — but only because the deterministic
 *      PGx result already said so, never because the model inferred it.
 *
 * The output of this file is the ONLY material the model is allowed to build on.
 */

import library from '../data/sources/action-library.json'
import type { GenePhenotypeResult } from './types'

export type JourneyPhase = 'first_weeks' | 'ongoing' | 'switching'

export type Signal =
  | 'nausea' | 'loose_stools' | 'insomnia' | 'vivid_dreams' | 'daytime_fatigue'
  | 'appetite_gain' | 'appetite_loss' | 'low_libido' | 'anxiety_jitter' | 'headache'
  | 'bruising_bleeding' | 'dizzy_confused'

export type Substance = 'high_caffeine' | 'smoking' | 'alcohol' | 'grapefruit' | 'nsaids' | 'supplements'

export interface ActionModule {
  id: string
  drugs: string[]
  phase: JourneyPhase
  goal: string
  signals: Signal[]
  substances: Substance[]
  bodyEffect: string
  mechanism: string
  actions: string[]
  foods: string[]
  avoid: string[]
  contraindications: string[]
  track: string
  timeline: string
  evidenceStrength: 'label' | 'guideline' | 'clinical_studies' | 'mechanistic_inference'
  source: string
}

const ACTIONS = (library as { actions: ActionModule[] }).actions

/* ------------------------------------------------------------------ */
/* The person                                                          */
/* ------------------------------------------------------------------ */

export interface PersonContext {
  drug: string
  phase: JourneyPhase
  /** How far in, free text — "day 9", "month 4". Context only, never parsed for dosing. */
  dayLabel: string
  /** Side effects they are actually experiencing. */
  signals: Signal[]
  /** What they actually consume. */
  substances: Substance[]
  /** Recovery goals in their words, chosen from a fixed set. */
  goals: string[]
  diet: DietContext
}

export interface DietContext {
  pattern: 'no_restriction' | 'vegetarian' | 'vegan' | 'halal' | 'kosher'
  allergies: string[]
  eatingDisorderHistory: boolean
  budgetConscious: boolean
}

/* ------------------------------------------------------------------ */
/* Food filtering                                                      */
/* ------------------------------------------------------------------ */

const ANIMAL = /\b(chicken|egg|eggs|yogurt|yoghurt|fish|salmon|tuna|beef|meat|dairy|milk|cheese|whey|broth)\b/i
const MEAT = /\b(chicken|fish|salmon|tuna|beef|meat|broth)\b/i
const ALLERGEN_WORDS: Record<string, RegExp> = {
  nuts: /\b(nut|nuts|peanut|almond|cashew|walnut)\b/i,
  dairy: /\b(dairy|milk|cheese|yogurt|yoghurt|whey)\b/i,
  eggs: /\b(egg|eggs)\b/i,
  fish: /\b(fish|salmon|tuna|seafood)\b/i,
  gluten: /\b(bread|toast|wheat|pasta|cracker|oats?)\b/i,
  soy: /\b(soy|tofu|edamame|miso)\b/i,
}

function foodAllowed(food: string, diet: DietContext): boolean {
  if (diet.pattern === 'vegan' && ANIMAL.test(food)) return false
  if (diet.pattern === 'vegetarian' && MEAT.test(food)) return false
  for (const allergy of diet.allergies) {
    const re = ALLERGEN_WORDS[allergy.toLowerCase()]
    if (re && re.test(food)) return false
  }
  return true
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface ApprovedAction extends ActionModule {
  /** Why this fired for this person — surfaced so the match is inspectable. */
  matchedOn: string[]
}

export interface JourneyContext {
  drug: string
  phase: JourneyPhase
  dayLabel: string
  /** One line per gene, straight from the deterministic PGx result. Model context only. */
  metabolism: string[]
  goals: string[]
  diet: DietContext
  /** The complete set of clinically-approved actions for this person. */
  approvedActions: ApprovedAction[]
  /** Goals that are on the table, deduped. The model may not pursue any goal outside this. */
  approvedGoals: string[]
}

function metabolismLines(genes: GenePhenotypeResult[]): string[] {
  const lines: string[] = []
  for (const gene of genes) {
    if (gene.functionalPhenotype === 'Indeterminate') continue
    const converted =
      gene.converted && gene.modeledFunctionalPhenotype && gene.modeledFunctionalPhenotype !== gene.geneticPhenotype
    if (converted) {
      lines.push(
        `${gene.gene}: genetically ${gene.geneticPhenotype.toLowerCase()}, but currently functioning like a ` +
          `${gene.modeledFunctionalPhenotype!.toLowerCase()} because of another medicine.`,
      )
    } else {
      lines.push(`${gene.gene}: ${gene.geneticPhenotype.toLowerCase()}.`)
    }
  }
  return lines
}

export function assembleJourney(person: PersonContext, genes: GenePhenotypeResult[]): JourneyContext {
  const drug = person.drug.toLowerCase()
  const signalSet = new Set(person.signals)
  const substanceSet = new Set(person.substances)

  const approved: ApprovedAction[] = []

  for (const action of ACTIONS) {
    if (!action.drugs.some((d) => d.toLowerCase() === drug)) continue

    const matchedOn: string[] = []
    // Phase-general baseline actions (no signal) fire for the current phase.
    if (action.phase === person.phase && action.signals.length === 0 && action.substances.length === 0) {
      matchedOn.push(`phase: ${person.phase}`)
    }
    for (const s of action.signals) if (signalSet.has(s)) matchedOn.push(`you reported: ${s.replace(/_/g, ' ')}`)
    for (const s of action.substances) if (substanceSet.has(s)) matchedOn.push(`you use: ${s.replace(/_/g, ' ')}`)
    if (!matchedOn.length) continue

    // Contraindication gate. Eating-disorder history is the one that must never be crossed.
    if (person.diet.eatingDisorderHistory && action.contraindications.includes('eating_disorder_history')) {
      continue
    }

    const foods = action.foods.filter((f) => foodAllowed(f, person.diet))
    approved.push({ ...action, foods, matchedOn })
  }

  // Deduplicate by id, strongest match first (signal matches before phase-baseline).
  const byId = new Map<string, ApprovedAction>()
  for (const a of approved) if (!byId.has(a.id)) byId.set(a.id, a)
  const finalActions = [...byId.values()].sort(
    (a, b) => Number(b.signals.length > 0) - Number(a.signals.length > 0),
  )

  return {
    drug,
    phase: person.phase,
    dayLabel: person.dayLabel,
    metabolism: metabolismLines(genes),
    goals: person.goals,
    diet: person.diet,
    approvedActions: finalActions,
    approvedGoals: [...new Set(finalActions.map((a) => a.goal))],
  }
}

/* ------------------------------------------------------------------ */
/* Static option sets for the check-in UI                              */
/* ------------------------------------------------------------------ */

export const SIGNAL_OPTIONS: Array<{ value: Signal; label: string }> = [
  { value: 'nausea', label: 'Nausea or stomach upset' },
  { value: 'loose_stools', label: 'Loose stools' },
  { value: 'insomnia', label: 'Trouble sleeping' },
  { value: 'vivid_dreams', label: 'Vivid or strange dreams' },
  { value: 'daytime_fatigue', label: 'Tired or foggy in the day' },
  { value: 'appetite_gain', label: 'Appetite up / weight gain' },
  { value: 'appetite_loss', label: 'Appetite down / weight loss' },
  { value: 'low_libido', label: 'Sexual side effects' },
  { value: 'anxiety_jitter', label: 'Jittery or on edge' },
  { value: 'headache', label: 'Headaches' },
  { value: 'bruising_bleeding', label: 'Easy bruising or bleeding' },
  { value: 'dizzy_confused', label: 'Dizzy or unusually confused' },
]

export const SUBSTANCE_OPTIONS: Array<{ value: Substance; label: string }> = [
  { value: 'high_caffeine', label: 'A lot of coffee / caffeine' },
  { value: 'smoking', label: 'I smoke (or am quitting)' },
  { value: 'alcohol', label: 'I drink alcohol' },
  { value: 'grapefruit', label: 'Grapefruit' },
  { value: 'nsaids', label: 'Ibuprofen / aspirin regularly' },
  { value: 'supplements', label: "St John's Wort / herbal supplements" },
]

export const GOAL_OPTIONS: string[] = [
  'Get back to work or study',
  'Sleep normally again',
  'Have energy for the day',
  'Get moving / exercise',
  'See people again',
  'Feel like myself',
  'Get through the side effects',
]

export function hasJourneyContent(drug: string): boolean {
  const d = drug.toLowerCase()
  return ACTIONS.some((a) => a.drugs.some((x) => x.toLowerCase() === d))
}
