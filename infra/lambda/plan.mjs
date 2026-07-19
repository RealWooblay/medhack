/**
 * RESEARCH ONLY — not deployed or called by the validation application.
 *
 * This free-writing prototype does not yet meet the fact-ID, typed-output or claim-level
 * provenance requirements of /api/clinical-review. Keep it disconnected from patient UI.
 *
 * Original prototype rationale:
 *
 * The clinical review gateway locks the model to emitting fact IDs with no free text,
 * because it speaks about doses, drug choice and interactions, where an invented number is
 * a safety event. That constraint is right there and stays.
 *
 * It is the wrong constraint for lifestyle. Telling someone that today is day nine, their
 * stomach should be settling, and plain starch will help is not the same class of claim as
 * "take 50 mg". Applying dose-grade guardrails to breakfast advice is what made the product
 * feel like a fact library instead of something that walks with you.
 *
 * So this endpoint lets the model actually write, but keeps three hard limits:
 *   1. It may only build on support protocols this server holds for that drug. The browser
 *      sends a drug and a phase, never the clinical content.
 *   2. Output is rejected if it contains dose language — a number attached to mg/mcg/g,
 *      or an instruction to change how much someone takes. That is the other endpoint's job.
 *   3. It may only name drugs the server already put in the context.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { protocols: PROTOCOLS } = JSON.parse(
  readFileSync(join(here, 'support-protocols.json'), 'utf8'),
)

const MODEL = process.env.PLAN_MODEL ?? 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_BODY_BYTES = 16_384
const TIMEOUT_MS = 25_000

const PHASES = new Set(['first_weeks', 'ongoing', 'switching'])

/* ------------------------------------------------------------------ */
/* Guardrails                                                          */
/* ------------------------------------------------------------------ */

/** A number bound to a dose unit, or an instruction to change the amount taken. */
const DOSE_LANGUAGE =
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|milligram|microgram|g\b|gram)|\b(?:increase|decrease|double|halve|reduce|raise|lower)\s+(?:the\s+)?(?:dose|dosage)|\btake\s+\d+\s+(?:tablet|capsule|pill)/i

/** Advice to start, stop or switch a medicine. Only a prescriber does that. */
const PRESCRIBING_LANGUAGE =
  /\b(?:stop|start|switch|come off|discontinue)\s+(?:taking\s+)?(?:your\s+)?(?:the\s+)?(?:medication|medicine|antidepressant|drug)\b/i

function screen(text, allowedDrugs) {
  const problems = []
  if (DOSE_LANGUAGE.test(text)) problems.push('dose_language')
  if (PRESCRIBING_LANGUAGE.test(text)) problems.push('prescribing_language')

  // Any drug named must be one the server put in the context.
  const known = new Set(allowedDrugs.map((d) => d.toLowerCase()))
  for (const m of text.matchAll(/\b([a-z]{6,16}(?:ine|one|am|ide|ol|pram|xetine|azodone))\b/gi)) {
    const word = m[1].toLowerCase()
    if (KNOWN_DRUG_WORDS.has(word) && !known.has(word)) problems.push(`unlisted_drug:${word}`)
  }
  return problems
}

const KNOWN_DRUG_WORDS = new Set([
  'sertraline', 'fluoxetine', 'paroxetine', 'citalopram', 'escitalopram', 'fluvoxamine',
  'venlafaxine', 'desvenlafaxine', 'duloxetine', 'vortioxetine', 'vilazodone', 'bupropion',
  'mirtazapine', 'trazodone', 'amitriptyline', 'nortriptyline', 'imipramine', 'clomipramine',
  'desipramine', 'doxepin', 'olanzapine', 'quetiapine', 'clozapine', 'aripiprazole',
  'ziprasidone', 'lamotrigine', 'phenelzine', 'tranylcypromine',
])

/* ------------------------------------------------------------------ */

function protocolsFor(drug, phase) {
  const needle = String(drug).toLowerCase()
  return PROTOCOLS.filter(
    (p) => p.drugs.some((d) => d.toLowerCase() === needle) && (!phase || p.phase === phase),
  )
}

const SYSTEM = `You write a short daily plan for someone taking an antidepressant.

You are given support protocols for their specific medicine. Build ONLY on those. They
describe what the drug does to the body and what helps.

Your job is to turn that into today, concretely. Name actual foods and actual actions. "Eat
porridge with banana this morning" beats "consider dietary fibre". Reference where they are
in the course so it feels like someone is walking alongside them, not reciting a leaflet.

Write to someone who is depressed and possibly nauseated and considering giving up. Warm,
plain, short sentences. No cheerleading, no medical lecture, no hedging.

HARD LIMITS. You must not:
- give or change a dose, or mention any milligram amount
- tell them to start, stop or switch a medicine
- name any drug other than the one given to you
- promise the medicine will work

Return JSON only:
{
  "today": {
    "headline": "one short sentence naming where they are, e.g. 'Day 9 — the worst of the nausea is usually behind you.'",
    "morning": "what to do this morning, concrete",
    "eat": ["2-3 specific foods or meals for today, each with a short reason"],
    "watchFor": "one thing to notice today and what it means",
    "skip": "one thing to avoid today, only if a protocol supports it, else empty string"
  },
  "thisWeek": "2-3 sentences on what shifts over the coming week",
  "ifItIsHard": "2-3 sentences for the moment they want to quit. Honest, not motivational-poster."
}`

async function callOpenAI(payload, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 900,
      }),
    })
    if (!response.ok) {
      return { error: `model_unavailable_${response.status}` }
    }
    const body = await response.json()
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return { error: 'model_invalid_response' }
    return { content }
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'model_timeout' : 'model_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  }
}

export async function handler(event) {
  const method = event?.requestContext?.http?.method ?? 'GET'
  if (method === 'OPTIONS') return { statusCode: 204, headers: { 'access-control-allow-origin': '*' } }
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return json(500, { error: 'model_not_configured' })

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '')
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json(413, { error: 'request_too_large' })

  let request
  try {
    request = JSON.parse(raw)
  } catch {
    return json(400, { error: 'invalid_json' })
  }

  const drug = typeof request.drug === 'string' ? request.drug.trim().toLowerCase() : ''
  const phase = PHASES.has(request.phase) ? request.phase : 'first_weeks'
  const dayLabel = typeof request.dayLabel === 'string' ? request.dayLabel.slice(0, 60) : ''
  if (!drug) return json(400, { error: 'drug_required' })

  const selected = protocolsFor(drug, phase)
  if (!selected.length) return json(404, { error: 'no_support_content_for_drug' })

  // The browser never sends clinical content. It sends a drug and a phase; the server
  // supplies every fact the model is allowed to build on.
  const payload = {
    medicine: drug,
    whereTheyAre: dayLabel || phase.replace('_', ' '),
    protocols: selected.map((p) => ({
      bodyEffect: p.bodyEffect,
      mechanism: p.mechanism,
      doThis: p.doThis,
      eatThis: p.eatThis,
      avoidThis: p.avoidThis,
      timeline: p.timeline,
    })),
  }

  const result = await callOpenAI(payload, apiKey)
  if (result.error) return json(502, { error: result.error })

  let plan
  try {
    plan = JSON.parse(result.content)
  } catch {
    return json(502, { error: 'model_invalid_json' })
  }

  const flat = JSON.stringify(plan)
  const problems = screen(flat, [drug])
  if (problems.length) {
    return json(200, {
      status: 'rejected',
      problems,
      note: 'The generated plan was withheld because it crossed into dose or prescribing advice.',
    })
  }

  return json(200, {
    status: 'ok',
    model: MODEL,
    drug,
    phase,
    protocolsUsed: selected.length,
    plan,
  })
}
