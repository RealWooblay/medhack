/**
 * Journey client.
 *
 * Sends the deterministically-assembled journey context to the Sol agent and returns the
 * plan. The context is built by the engine (assembleJourney), so the model only ever sees an
 * already-approved set of actions — the browser cannot widen what it is allowed to say.
 */

import type { JourneyContext } from '../engine/journey'

export interface JourneyPlan {
  headline: string
  today: Array<{ do: string; because: string }>
  eatToday: string[]
  thisWeek: Array<{ goal: string; step: string }>
  watchFor: Array<{ sign: string; meaning: string }>
  clinicianSummary: string
}

export type JourneyResult =
  | { status: 'ok'; plan: JourneyPlan; model: string; actionsUsed: number }
  | { status: 'rejected'; note: string; problems: string[] }
  | { status: 'not_configured' }
  | { status: 'error'; message: string }

const ENDPOINT = (import.meta.env.VITE_JOURNEY_ENDPOINT ?? '').trim()

export function journeyConfigured(): boolean {
  return ENDPOINT.length > 0
}

export async function requestJourney(
  context: JourneyContext & { person?: Record<string, unknown> },
): Promise<JourneyResult> {
  if (!ENDPOINT) return { status: 'not_configured' }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(context),
    })
  } catch {
    return { status: 'error', message: 'Could not reach the journey service.' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'error', message: 'The journey service returned an unreadable response.' }
  }

  const record = body as Record<string, unknown>
  if (!response.ok) {
    const code = (record?.error as string) ?? `http_${response.status}`
    return { status: 'error', message: `The plan could not be generated (${code}).` }
  }
  if (record.status === 'rejected') {
    return {
      status: 'rejected',
      note: String(record.note ?? 'The plan was withheld.'),
      problems: Array.isArray(record.problems) ? record.problems.map(String) : [],
    }
  }
  if (record.status === 'ok' && record.plan) {
    return {
      status: 'ok',
      plan: record.plan as JourneyPlan,
      model: String(record.model ?? 'unknown'),
      actionsUsed: Number(record.actionsUsed ?? 0),
    }
  }
  return { status: 'error', message: 'The journey service returned an unexpected response.' }
}
