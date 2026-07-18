/**
 * The moment between asking and knowing.
 *
 * The analysis itself takes milliseconds. Rather than invent a progress bar, this reveals
 * the real pipeline steps one at a time with their real timings — so the pause is spent
 * showing the person what was actually done on their behalf, and which single step involved
 * a language model at all.
 */

import { useEffect, useState } from 'react'
import type { TraceStep } from '../engine/types'

const STAGGER_MS = 260

export function Running({ trace, onDone }: { trace: TraceStep[]; onDone: () => void }) {
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (shown >= trace.length) {
      const timer = window.setTimeout(onDone, 550)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => setShown((n) => n + 1), STAGGER_MS)
    return () => window.clearTimeout(timer)
  }, [shown, trace.length, onDone])

  return (
    <div className="shell shell--narrow running">
      <p className="eyebrow">Working</p>
      <h2 style={{ marginBottom: '2rem' }}>Reading your results</h2>

      {trace.slice(0, shown).map((step, i) => (
        <div className="trace-line" key={i}>
          <span className="trace-line__mark">
            {step.kind === 'model' ? '◇' : step.kind === 'validator' ? '⊘' : '✓'}
          </span>
          <span>
            <strong style={{ fontSize: '0.94rem' }}>{step.step}</strong>
            <div className="trace-line__detail">{step.detail}</div>
          </span>
          <span className="trace-line__ms">{step.ms}ms</span>
        </div>
      ))}
    </div>
  )
}
