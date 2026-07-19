/**
 * RESEARCH ONLY — not imported by the validation application.
 *
 * This client belongs to the unvalidated free-writing daily-plan experiment. It must not be
 * connected to patient UI until the underlying claims have structured source IDs and exact
 * anchors, the response has a strict schema, and every displayed claim passes verification.
 */

import type { SupportPhase } from '../data/support-protocols'

export interface DailyPlan {
  today: {
    headline: string
    morning: string
    eat: string[]
    watchFor: string
    skip: string
  }
  thisWeek: string
  ifItIsHard: string
}

export type DailyPlanResult =
  | { status: 'ok'; plan: DailyPlan; model: string; protocolsUsed: number }
  | { status: 'rejected'; note: string; problems: string[] }
  | { status: 'not_configured' }
  | { status: 'error'; message: string }

const ENDPOINT = (import.meta.env.VITE_PLAN_ENDPOINT ?? '').trim()

export function dailyPlanConfigured(): boolean {
  return ENDPOINT.length > 0
}

export async function requestDailyPlan(input: {
  drug: string
  phase: SupportPhase
  dayLabel: string
}): Promise<DailyPlanResult> {
  if (!ENDPOINT) return { status: 'not_configured' }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    return { status: 'error', message: 'Could not reach the plan service.' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'error', message: 'The plan service returned an unreadable response.' }
  }

  if (!response.ok) {
    const code = (body as { error?: string })?.error ?? `http_${response.status}`
    return { status: 'error', message: `The plan could not be generated (${code}).` }
  }

  const record = body as Record<string, unknown>
  if (record.status === 'rejected') {
    return {
      status: 'rejected',
      note: String(record.note ?? 'The generated plan was withheld.'),
      problems: Array.isArray(record.problems) ? record.problems.map(String) : [],
    }
  }
  if (record.status === 'ok' && record.plan) {
    return {
      status: 'ok',
      plan: record.plan as DailyPlan,
      model: String(record.model ?? 'unknown'),
      protocolsUsed: Number(record.protocolsUsed ?? 0),
    }
  }
  return { status: 'error', message: 'The plan service returned an unexpected response.' }
}
