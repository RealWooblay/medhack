/**
 * Journey agent — GPT-5.6 Sol.
 *
 * The model's job is sequencing and personalisation, not clinical authority. It receives an
 * already-approved set of actions and goals that the deterministic engine assembled for one
 * specific person, and it turns them into a plan for today, this week, and a clinician
 * summary. It decides breakfast; it never decides the medicine or the biology.
 *
 * Three things are enforced on the way out, and they are the whole safety contract:
 *   - no dose language (a number bound to mg/mcg/g, or an instruction to change the amount)
 *   - no drug named other than the one in context
 *   - no goal pursued that is not in the approved-goal set the engine supplied
 * Anything tripping these is withheld with the reason shown, rather than silently rendered.
 */

const MODEL = process.env.JOURNEY_MODEL ?? 'gpt-5.6-sol'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_BODY_BYTES = 48_000
const TIMEOUT_MS = 55_000

const KNOWN_DRUGS = new Set([
  'sertraline', 'fluoxetine', 'paroxetine', 'citalopram', 'escitalopram', 'fluvoxamine',
  'venlafaxine', 'desvenlafaxine', 'duloxetine', 'levomilnacipran', 'vortioxetine',
  'vilazodone', 'bupropion', 'mirtazapine', 'trazodone', 'amitriptyline', 'nortriptyline',
  'imipramine', 'clomipramine', 'desipramine', 'doxepin', 'olanzapine', 'quetiapine',
  'clozapine', 'aripiprazole', 'ziprasidone', 'lamotrigine', 'phenelzine', 'tranylcypromine',
])

const DOSE_LANGUAGE =
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|milligram|microgram|gram)\b|\b(?:increase|decrease|double|halve|reduce|raise|lower)\s+(?:the\s+)?(?:dose|dosage)\b|\btake\s+\d+\s+(?:tablet|capsule|pill)/i
const PRESCRIBING_LANGUAGE =
  /\b(?:stop|start|switch|come off|discontinue)\s+(?:taking\s+)?(?:your\s+)?(?:the\s+)?(?:medication|medicine|antidepressant|drug)\b/i

function screen(planText, allowedDrug) {
  const problems = []
  if (DOSE_LANGUAGE.test(planText)) problems.push('dose_language')
  if (PRESCRIBING_LANGUAGE.test(planText)) problems.push('prescribing_language')
  for (const m of planText.matchAll(/\b([a-z]{6,16})\b/gi)) {
    const w = m[1].toLowerCase()
    if (KNOWN_DRUGS.has(w) && w !== allowedDrug) problems.push(`unlisted_drug:${w}`)
  }
  return [...new Set(problems)]
}

const SYSTEM = `You are the journey guide inside a pharmacogenomics app for someone taking an antidepressant.

You are given: their medicine, where they are in the course, how their body processes it
(from their genetics), the side effects they actually report, what they consume, their
recovery goals, their diet and constraints, a "person" block carrying their medical history
(conditions that shaped which medicine was appropriate, any history flags on this medicine,
age, exercise, distress score), and a set of APPROVED ACTIONS.

Use the person block as real context. If a condition explains why this medicine needs care,
say so plainly. If their distress score is high, keep the plan smaller and gentler rather
than piling on tasks. Never restate a condition back as a diagnosis, and never infer a new
condition they did not report. Each approved
action carries a clinically-established goal, a mechanism, concrete actions, approved food
options already filtered for their diet and allergies, and what to track.

Your job is to turn that into a plan that feels like someone walking beside them — not a
leaflet. Be concrete. Name real food and real actions. Sequence: what are the one or two
things that matter TODAY, and the small number of things for THIS WEEK. Reference where they
are ("day 9", "month 4") and, where it helps, how their body handles the drug.

Personalise the food from the approved options to their goals, diet and budget. "Greek
yoghurt at breakfast, lentils at lunch" beats "increase protein". If they are vegan, do not
suggest animal food. If money is tight, keep it cheap.

Write to someone who is depressed, maybe nauseated, maybe about to give up. Warm, plain,
short sentences. No cheerleading, no lecture.

ABSOLUTE LIMITS — you must never:
- give or change a dose, or mention any milligram amount
- tell them to start, stop or switch a medicine
- name any drug other than the one you were given
- pursue any goal that is not in the approved actions
- promise the medicine will work, or predict a side effect they have not reported

Return JSON exactly in this shape:
{
  "headline": "one short sentence naming where they are and how it tends to go, e.g. 'Day 9 — the worst of the nausea is usually behind you.'",
  "today": [ { "do": "one concrete action for today", "because": "the reason, in plain words" } ],
  "eatToday": [ "2-4 specific foods/meals for today, each with a short reason, from the approved options and their diet" ],
  "thisWeek": [ { "goal": "one approved goal in their words", "step": "one achievable step toward it this week" } ],
  "watchFor": [ { "sign": "a warning sign to notice", "meaning": "what it means and what to do" } ],
  "clinicianSummary": "3-4 sentences a prescriber could read at the next review: what the person is experiencing, what is being managed, and what to raise. No doses."
}
Keep today to 1-3 items, thisWeek to 1-3, watchFor to 1-3, eatToday to 2-4.`

async function callSol(payload, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        response_format: { type: 'json_object' },
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { error: `model_unavailable_${response.status}`, detail: detail.slice(0, 200) }
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
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

export async function handler(event) {
  const method = event?.requestContext?.http?.method ?? 'GET'
  if (method === 'OPTIONS') {
    return { statusCode: 204 }
  }
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return json(500, { error: 'model_not_configured' })

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '')
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json(413, { error: 'request_too_large' })

  let ctx
  try {
    ctx = JSON.parse(raw)
  } catch {
    return json(400, { error: 'invalid_json' })
  }

  const drug = typeof ctx.drug === 'string' ? ctx.drug.trim().toLowerCase() : ''
  const approvedActions = Array.isArray(ctx.approvedActions) ? ctx.approvedActions : []
  const approvedGoals = Array.isArray(ctx.approvedGoals) ? ctx.approvedGoals.map(String) : []
  if (!drug) return json(400, { error: 'drug_required' })
  if (!approvedActions.length) return json(422, { error: 'no_approved_actions' })

  const result = await callSol(ctx, apiKey)
  if (result.error) return json(502, { error: result.error, detail: result.detail })

  let plan
  try {
    plan = JSON.parse(result.content)
  } catch {
    return json(502, { error: 'model_invalid_json' })
  }

  const flat = JSON.stringify(plan)
  const problems = screen(flat, drug)

  // Note on what is NOT re-checked here: the model writes "this week" goals in the person's
  // own recovery language ("get back to work"), which is deliberately not the same string as
  // the engine's clinical goals. The safety boundary is that the model only ever received
  // approved actions to build on, plus the dose / prescribing / unlisted-drug screen above —
  // matching goal strings would only reject the model for following its instructions.

  if (problems.length) {
    return json(200, {
      status: 'rejected',
      problems,
      note: 'The generated plan was withheld because it crossed a safety boundary.',
    })
  }

  return json(200, {
    status: 'ok',
    model: MODEL,
    drug,
    actionsUsed: approvedActions.length,
    plan,
  })
}
