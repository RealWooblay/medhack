/**
 * The claim boundary.
 *
 * Everything the orchestrating model writes passes through here before it can reach the
 * screen. The rule is narrow and mechanical, which is the point — it is not a judgement
 * call and it is not another model grading the first one:
 *
 *   1. Every number in the prose must already appear in the structured clinical input.
 *   2. Every drug name in the prose must already appear in the structured clinical input.
 *   3. Every citation the prose attaches must be a citation the engine actually produced.
 *   4. A sentence that makes a clinical assertion with no citation at all is dropped.
 *
 * Violations are dropped at sentence granularity and written to a rejection log that the
 * UI renders. A partially-scrubbed clinical sentence is never shown — if a sentence
 * fails, the whole sentence goes, not just the offending token.
 *
 * This is defence in depth. Allow-list matching cannot establish that a sentence preserves
 * the clinical meaning of its source, so passing validation is not proof of correctness.
 */

import { findDrugMentions } from '../data/drug-lexicon'
import type {
  Draft,
  DraftClaim,
  NarrativeSection,
  Rejection,
  ValidatedProse,
  ValidationReport,
} from './types'

export interface AllowList {
  numbers: Set<string>
  /**
   * Value-with-unit pairs, e.g. "50|%" or "20|mg".
   *
   * Bare value matching alone is too loose: a guideline that says "a 50% reduction" would
   * license a model to write "50 mg", which is a different and potentially dangerous claim.
   * When a number in the prose carries a clinical unit, it must match a number carrying the
   * same unit in the source.
   */
  quantities: Set<string>
  drugs: Set<string>
  citationIds: Set<string>
}

/* ------------------------------------------------------------------ */
/* Number handling                                                     */
/* ------------------------------------------------------------------ */

const NUMBER_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g

/** "1,000" -> "1000", "1.50" -> "1.5", "07" -> "7". Comparison is value-based. */
export function normaliseNumber(raw: string): string {
  const cleaned = raw.replace(/,/g, '')
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? String(n) : cleaned
}

const WORD_NUMBERS: Record<string, number> = {
  half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
}

/**
 * Spelled-out numbers only count when they carry a clinical unit. "one of the reasons"
 * is prose; "one week" and "two doses" are clinical quantities.
 */
const SPELLED_QUANTITY_RE = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join('|')})[\\s-](?:to[\\s-]\\w+[\\s-])?` +
    `(mg|milligrams?|mcg|micrograms?|grams?|ml|millilitres?|milliliters?|percent|` +
    `weeks?|days?|hours?|months?|years?|glasses|calories|doses?|tablets?|pills?|times|fold)\\b`,
  'gi',
)

/* ------------------------------------------------------------------ */
/* Building the allow-list from the structured clinical result         */
/* ------------------------------------------------------------------ */

function walkStrings(value: unknown, visit: (s: string) => void, depth = 0): void {
  if (value == null || depth > 12) return
  if (typeof value === 'string') return visit(value)
  if (typeof value === 'number') return visit(String(value))
  if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, visit, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) walkStrings(v, visit, depth + 1)
  }
}

export interface AllowListInput {
  /** The deterministic engine output the prose is allowed to talk about. */
  facts: unknown
  /** Citation ids the engine actually emitted. */
  citationIds: string[]
  /**
   * Counts that are genuinely present in the structured input as collection sizes rather
   * than as literal digits — e.g. "you have tried 2 antidepressants". These are derived
   * mechanically by the pipeline, never by the model, and are listed separately in the
   * trust panel so the derivation stays visible.
   */
  derivedCounts?: number[]
}

/** Clinical units that make a number a quantity rather than an incidental figure. */
const UNIT_PATTERN =
  '(mg|mcg|micrograms?|milligrams?|g|grams?|mL|ml|millilitres?|milliliters?|%|percent|' +
  'weeks?|days?|hours?|months?|years?|glasses|calories|kcal|doses?|tablets?|pills?|times|fold)'

const QUANTITY_RE = new RegExp(`(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*-?\\s*${UNIT_PATTERN}\\b`, 'gi')

/** Units are normalised so "milligrams", "mg" and "MG" compare equal. */
function normaliseUnit(unit: string): string {
  const u = unit.toLowerCase().replace(/s$/, '')
  if (['milligram', 'mg'].includes(u)) return 'mg'
  if (['microgram', 'mcg'].includes(u)) return 'mcg'
  if (['millilitre', 'milliliter', 'ml'].includes(u)) return 'ml'
  if (['gram', 'g'].includes(u)) return 'g'
  if (['percent', '%'].includes(u)) return '%'
  if (['calorie', 'kcal'].includes(u)) return 'kcal'
  return u
}

function quantityKey(value: string, unit: string): string {
  return `${normaliseNumber(value)}|${normaliseUnit(unit)}`
}

export function buildAllowList({ facts, citationIds, derivedCounts = [] }: AllowListInput): AllowList {
  const numbers = new Set<string>()
  const quantities = new Set<string>()
  const drugs = new Set<string>()

  walkStrings(facts, (s) => {
    for (const m of s.matchAll(NUMBER_RE)) numbers.add(normaliseNumber(m[0]))
    for (const m of s.matchAll(QUANTITY_RE)) quantities.add(quantityKey(m[1], m[2]))
    for (const hit of findDrugMentions(s)) drugs.add(hit.generic.toLowerCase())
  })

  for (const c of derivedCounts) numbers.add(normaliseNumber(String(c)))

  return { numbers, quantities, drugs, citationIds: new Set(citationIds) }
}

/* ------------------------------------------------------------------ */
/* Sentence splitting                                                  */
/* ------------------------------------------------------------------ */

/** Sentinel stand-in for a period that must not be treated as a sentence end. */
const DOT = "\u0001";

export function splitSentences(text: string): string[] {
  const guarded = text
    // Decimal points: "0.5", "5.6"
    .replace(/(\d)\.(\d)/g, `$1${DOT}$2`)
    // Abbreviations whose period is not a sentence end.
    .replace(/\b(e\.g|i\.e|approx|vs|Dr|Mr|Ms|St|No|Fig|et al)\./gi, (m) => m.slice(0, -1) + DOT)

  return guarded
    .split(/(?<=[.!?])\s+(?=["’“(]?[A-Z0-9])/)
    .map((s) => s.split(DOT).join(".").trim())
    .filter(Boolean)
}

/* ------------------------------------------------------------------ */
/* Clinical assertion detection                                        */
/* ------------------------------------------------------------------ */

const CLINICAL_TRIGGER =
  /\b(dose|dosing|dosage|mg|mcg|start(?:ing)?|increase|decrease|reduce|lower|raise|avoid|switch|contraindicat\w*|metaboli\w+|phenotype|CYP\d\w*|inhibitor|inducer|guideline|recommend\w*|titrat\w+|plasma|concentration|level|toxic\w*|serotonin syndrome)\b/i

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function checkSentence(
  sentence: string,
  allow: AllowList,
  section: NarrativeSection,
): Rejection | null {
  // Rule 2 — drug names.
  for (const hit of findDrugMentions(sentence)) {
    if (!allow.drugs.has(hit.generic.toLowerCase())) {
      return {
        section,
        text: sentence,
        kind: 'drug_not_in_source',
        offendingToken: hit.surface,
        reason:
          `"${hit.surface}" resolves to the drug ${hit.generic}, which does not appear anywhere in ` +
          `the structured clinical input for this patient. The model introduced it.`,
      }
    }
  }

  // Rule 1a — quantities. A number carrying a clinical unit must match the same number
  // carrying the same unit in the source, not merely the same digits somewhere.
  const quantitySpans: Array<[number, number]> = []
  for (const m of sentence.matchAll(QUANTITY_RE)) {
    quantitySpans.push([m.index!, m.index! + m[0].length])
    const key = quantityKey(m[1], m[2])
    if (!allow.quantities.has(key)) {
      const bareValueExists = allow.numbers.has(normaliseNumber(m[1]))
      return {
        section,
        text: sentence,
        kind: 'number_not_in_source',
        offendingToken: m[0].trim(),
        reason: bareValueExists
          ? `The value ${normaliseNumber(m[1])} appears in the structured clinical input, but not as ` +
            `"${m[0].trim()}". Reusing a figure with a different unit changes what it means, so the ` +
            `quantity is treated as ungrounded.`
          : `The quantity ${m[0].trim()} does not appear in the structured clinical input. Doses, ` +
            `percentages and durations may only be repeated from the guideline lookup, never generated.`,
      }
    }
  }

  // Rule 1b — bare digits not already covered by a quantity match.
  for (const m of sentence.matchAll(NUMBER_RE)) {
    const start = m.index!
    if (quantitySpans.some(([s, e]) => start >= s && start < e)) continue
    const value = normaliseNumber(m[0])
    if (!allow.numbers.has(value)) {
      return {
        section,
        text: sentence,
        kind: 'number_not_in_source',
        offendingToken: m[0],
        reason:
          `The number ${m[0]} does not appear in the structured clinical input. Doses, ` +
          `percentages and durations may only be repeated from the guideline lookup, never generated.`,
      }
    }
  }

  // Rule 1c — spelled-out quantities carrying a clinical unit.
  for (const m of sentence.matchAll(SPELLED_QUANTITY_RE)) {
    const word = m[1].toLowerCase()
    const value = normaliseNumber(String(WORD_NUMBERS[word]))
    if (!allow.quantities.has(quantityKey(value, m[2]))) {
      return {
        section,
        text: sentence,
        kind: 'number_not_in_source',
        offendingToken: m[0],
        reason:
          `"${m[0]}" is a clinical quantity of ${value}, which does not appear in the structured ` +
          `clinical input. Spelling a number out does not exempt it from the check.`,
      }
    }
  }

  return null
}

function validateClaim(
  claim: DraftClaim,
  allow: AllowList,
): { accepted: { text: string; citationIds: string[] } | null; rejections: Rejection[] } {
  const rejections: Rejection[] = []

  // Rule 3 — the citations must be ones the engine actually produced.
  const badCitation = claim.citationIds.find((id) => !allow.citationIds.has(id))
  if (badCitation) {
    rejections.push({
      section: claim.section,
      text: claim.text,
      kind: 'citation_not_in_source',
      offendingToken: badCitation,
      reason:
        `Citation "${badCitation}" was not emitted by the deterministic engine for this patient. ` +
        `A claim cannot cite a source that was not consulted.`,
    })
    return { accepted: null, rejections }
  }

  const sentences = splitSentences(claim.text)
  const kept: string[] = []

  for (const sentence of sentences) {
    // Rule 4 — a clinical assertion with no citation at all.
    if (claim.citationIds.length === 0 && CLINICAL_TRIGGER.test(sentence)) {
      rejections.push({
        section: claim.section,
        text: sentence,
        kind: 'uncited_clinical_claim',
        offendingToken: sentence.match(CLINICAL_TRIGGER)?.[0] ?? '',
        reason:
          `This sentence makes a clinical assertion but carries no citation. No source, no render.`,
      })
      continue
    }

    const rejection = checkSentence(sentence, allow, claim.section)
    if (rejection) {
      rejections.push(rejection)
      continue
    }
    kept.push(sentence)
  }

  const accepted = kept.length ? { text: kept.join(' '), citationIds: claim.citationIds } : null
  return { accepted, rejections }
}

export function validateDraft(draft: Draft, allow: AllowList): ValidationReport {
  const bySection = new Map<NarrativeSection, ValidatedProse>()
  const rejections: Rejection[] = []

  for (const claim of draft.claims) {
    const { accepted, rejections: claimRejections } = validateClaim(claim, allow)
    rejections.push(...claimRejections)
    if (!accepted) continue

    const existing = bySection.get(claim.section)
    if (existing) existing.claims.push(accepted)
    else bySection.set(claim.section, { section: claim.section, claims: [accepted] })
  }

  return {
    generator: draft.generator,
    model: draft.model,
    accepted: [...bySection.values()],
    rejections,
    allowedNumbers: [...allow.numbers].sort((a, b) => Number(a) - Number(b)),
    allowedDrugs: [...allow.drugs].sort(),
    allowedCitationIds: [...allow.citationIds].sort(),
    claimsChecked: draft.claims.length,
  }
}

/** Convenience accessor used throughout the UI. */
export function proseFor(report: ValidationReport, section: NarrativeSection) {
  return report.accepted.find((a) => a.section === section)?.claims ?? []
}
