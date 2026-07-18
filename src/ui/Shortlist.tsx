/**
 * The ranked shortlist — the inverted query made visible.
 *
 * Each row collapses a lot of reasoning into one line, and expands to the full guideline
 * text, the interaction flags, the washout window and the score arithmetic. Nothing in the
 * expansion is a summary: the guideline quote is the guideline's own words.
 */

import { useState } from 'react'
import { Cite } from './Citation'
import type { DrugAssessment, Verdict } from '../engine/types'

const MARK: Record<Verdict, string> = {
  preferred: '✅',
  caution: '⚠',
  avoid: '🚫',
  insufficient_evidence: '○',
}

const BADGE_CLASS: Record<Verdict, string> = {
  preferred: 'badge--preferred',
  caution: 'badge--caution',
  avoid: 'badge--avoid',
  insufficient_evidence: 'badge--neutral',
}

const VERDICT_LABEL: Record<Verdict, string> = {
  preferred: 'suitable',
  caution: 'needs care',
  avoid: 'avoid',
  insufficient_evidence: 'no guideline',
}

function ScoreBreakdown({ drug }: { drug: DrugAssessment }) {
  const max = Math.max(...drug.scoreBreakdown.map((c) => Math.abs(c.delta)), 1)
  return (
    <div>
      {drug.scoreBreakdown.map((component, i) => (
        <div className="score-bar" key={i} title={component.detail}>
          <span style={{ width: '11rem', flex: 'none' }}>{component.label}</span>
          <span className="score-bar__track">
            <span
              className={`score-bar__fill ${component.delta >= 0 ? 'score-bar__fill--pos' : 'score-bar__fill--neg'}`}
              style={{
                width: `${(Math.abs(component.delta) / max) * 50}%`,
                left: component.delta >= 0 ? '50%' : undefined,
                right: component.delta < 0 ? '50%' : undefined,
              }}
            />
          </span>
          <span className="score-bar__delta">
            {component.delta >= 0 ? '+' : ''}
            {component.delta}
          </span>
        </div>
      ))}
      <div className="score-bar" style={{ fontWeight: 600, marginTop: '0.3rem' }}>
        <span style={{ width: '11rem', flex: 'none' }}>Total</span>
        <span className="score-bar__track" />
        <span className="score-bar__delta">{drug.score}</span>
      </div>
    </div>
  )
}

function DrugRow({ drug, isTop }: { drug: DrugAssessment; isTop: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <div className={`drug-row ${isTop ? 'drug-row--top' : ''}`}>
      <button className="drug-row__button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="drug-row__mark">{MARK[drug.verdict]}</span>
        <span>
          <span className="drug-row__name">{drug.drug}</span>
          <span className="drug-row__class"> · {drug.drugClass}</span>
          {drug.isCurrentMedication && <div className="badge badge--current">taking now</div>}
          {drug.pastTrial && !drug.isCurrentMedication && (
            <div className="badge badge--current">
              {drug.pastTrial.outcome === 'helped' ? 'helped before' : 'tried before'}
            </div>
          )}
        </span>
        <span>
          <span className="drug-row__headline">{drug.headline}</span>
          <div className="drug-row__reason">{drug.reason}</div>
        </span>
        <span className="drug-row__chev">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="drug-row__detail">
          {drug.geneFindings.map((finding, i) => (
            <div className="detail-block" key={i}>
              <div className="detail-block__label">
                {finding.gene} — {finding.phenotypeUsed}
                {finding.usedFunctionalPhenotype && ' (functional, not genetic)'}
                {finding.strength && ` · ${finding.strength} recommendation`}
              </div>
              <blockquote className="guideline-quote">
                {finding.guidelineText}
                <Cite ids={finding.citationIds} />
              </blockquote>
            </div>
          ))}

          {drug.enzymeIndependence.length > 0 && (
            <div className="detail-block">
              <div className="detail-block__label">Why this sidesteps your problem</div>
              {drug.enzymeIndependence.map((claim, i) => (
                <p key={i} style={{ fontSize: '0.9rem' }}>
                  {claim.text}
                  <Cite ids={claim.citationIds} />
                </p>
              ))}
            </div>
          )}

          {drug.washoutNote && (
            <div className="washout">
              <div className="washout__states">
                <span className={`badge ${BADGE_CLASS[drug.verdict]}`}>
                  starting today · {VERDICT_LABEL[drug.verdict]}
                </span>
                {drug.postWashoutVerdict && (
                  <>
                    <span className="washout__arrow">→</span>
                    <span className={`badge ${BADGE_CLASS[drug.postWashoutVerdict]}`}>
                      after washout · {VERDICT_LABEL[drug.postWashoutVerdict]}
                    </span>
                  </>
                )}
              </div>
              <p style={{ fontSize: '0.88rem', margin: 0 }}>
                {drug.washoutNote.text}
                <Cite ids={drug.washoutNote.citationIds} />
              </p>
            </div>
          )}

          {drug.interactionFlags.length > 0 && (
            <div className="detail-block">
              <div className="detail-block__label">Interaction flags</div>
              {drug.interactionFlags.map((flag, i) => (
                <p key={i} style={{ fontSize: '0.9rem' }}>
                  <span className={`badge ${flag.severity === 'critical' ? 'badge--avoid' : 'badge--caution'}`}>
                    {flag.severity}
                  </span>{' '}
                  {flag.text}
                  <Cite ids={flag.citationIds} />
                </p>
              ))}
            </div>
          )}

          {drug.pastTrial && (
            <div className="detail-block">
              <div className="detail-block__label">You have tried this before</div>
              <p style={{ fontSize: '0.9rem' }}>{drug.pastTrial.patientSummary}</p>
            </div>
          )}

          {drug.retryRationale && (
            <div className="detail-block">
              <div className="detail-block__label">Worth a second look?</div>
              <p style={{ fontSize: '0.9rem' }}>
                {drug.retryRationale.text}
                <Cite ids={drug.retryRationale.citationIds} />
              </p>
            </div>
          )}

          <details>
            <summary>How this was ranked</summary>
            <div style={{ marginTop: '0.6rem' }}>
              <ScoreBreakdown drug={drug} />
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

export function Shortlist({ shortlist }: { shortlist: DrugAssessment[] }) {
  const [showAll, setShowAll] = useState(false)
  const switchable = shortlist.filter((d) => !d.isCurrentMedication)
  const visible = showAll ? shortlist : shortlist.slice(0, 6)

  return (
    <section>
      <div className="shell">
        <div className="section-head">
          <p className="eyebrow">The shortlist</p>
          <h2>What fits you, ranked</h2>
          <p className="lede" style={{ marginTop: '0.9rem' }}>
            Every antidepressant with a CPIC recommendation, checked against your functional
            metaboliser status rather than your genotype alone. Open any row to read the guideline
            wording it came from.
          </p>
        </div>

        <div className="shortlist">
          {visible.map((drug) => (
            <DrugRow key={drug.drug} drug={drug} isTop={drug === switchable[0]} />
          ))}
        </div>

        {shortlist.length > 6 && (
          <p style={{ marginTop: '1rem' }}>
            <button className="btn--plain" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${shortlist.length} candidates`}
            </button>
          </p>
        )}
      </div>
    </section>
  )
}
