/**
 * The patient view — the default, and the one that matters.
 *
 * Three blocks: what happened before, what might come next, and what taking it actually
 * looks like day to day. The tone rule throughout is that nothing here should read as a
 * verdict on the person. A drug that did not work is a fact about pharmacokinetics, not a
 * fact about them.
 */

import { Claim, Cite } from './Citation'
import { proseFor } from '../engine/validator'
import { dailyRhythm } from '../engine/lifestyle'
import type { AnalysisResult, ProtocolItem, TrialReconstruction } from '../engine/types'

const OUTCOME_TEXT: Record<TrialReconstruction['outcome'], string> = {
  no_effect: 'did not help',
  side_effects: 'side effects',
  helped: 'helped',
  stopped_other: 'stopped',
}

function ProtocolRow({ item }: { item: ProtocolItem }) {
  return (
    <div className={`protocol-item protocol-item--${item.severity}`}>
      <span className="protocol-item__icon">{item.icon}</span>
      <span className="protocol-item__label">{item.label}</span>
      <span>
        <span className="protocol-item__rule">{item.rule}</span>
        <span className="protocol-item__why">
          {item.why}
          <Cite ids={item.citationIds} />
        </span>
        {item.pinned && <div className="pinned-note">Important — kept open on purpose</div>}
      </span>
    </div>
  )
}

export function PatientView({ result }: { result: AnalysisResult }) {
  const { narrative, history, protocol } = result
  const top = result.shortlist.filter((d) => !d.isCurrentMedication)[0]
  const rhythm = protocol ? dailyRhythm(protocol) : []
  const rest = protocol ? protocol.items.filter((i) => !rhythm.includes(i)) : []
  const critical = rest.filter((i) => i.severity === 'critical')
  const optional = rest.filter((i) => i.severity !== 'critical')

  return (
    <div className="stack">
      {/* ---- what is actually going on ---- */}
      <div>
        <p className="eyebrow">What is going on</p>
        <h3 style={{ marginBottom: '1rem' }}>The short version</h3>
        {proseFor(narrative, 'phenoconversion_explainer').map((claim, i) => (
          <Claim key={i} text={claim.text} ids={claim.citationIds} />
        ))}
      </div>

      {/* ---- why past trials failed ---- */}
      <div style={{ paddingTop: '1.5rem' }}>
        <p className="eyebrow">Looking back</p>
        <h3 style={{ marginBottom: '1rem' }}>Why the ones you tried may not have worked</h3>

        <div className="timeline">
          {history.map((trial) => (
            <div
              className={`timeline__item ${
                trial.explanation === 'not_explained_by_genetics'
                  ? 'timeline__item--unexplained'
                  : 'timeline__item--explained'
              }`}
              key={trial.drug}
            >
              <div className="timeline__drug">
                {trial.drug}
                <span
                  className={`badge ${
                    trial.outcome === 'helped' ? 'badge--preferred' : 'badge--neutral'
                  }`}
                >
                  {OUTCOME_TEXT[trial.outcome]}
                </span>
                {trial.explanation === 'not_explained_by_genetics' && (
                  <span className="badge badge--neutral">genetics does not explain this</span>
                )}
              </div>
              <div className="timeline__body">
                {trial.patientSummary}
                {trial.mechanism && <Cite ids={trial.mechanism.citationIds} />}
              </div>
            </div>
          ))}
        </div>

        {history.length === 0 && (
          <p className="muted">
            You have not recorded any previous antidepressants, so there is nothing to look back at
            yet.
          </p>
        )}
      </div>

      {/* ---- what next ---- */}
      <div style={{ paddingTop: '1.5rem' }}>
        <p className="eyebrow">Looking forward</p>
        <h3 style={{ marginBottom: '1rem' }}>What your prescriber might consider next</h3>
        {proseFor(narrative, 'what_next').map((claim, i) => (
          <Claim key={i} text={claim.text} ids={claim.citationIds} />
        ))}
      </div>

      {/* ---- daily protocol ---- */}
      {protocol && top && (
        <div style={{ paddingTop: '1.5rem' }}>
          <p className="eyebrow">If you and your prescriber choose {protocol.drug}</p>
          <h3 style={{ marginBottom: '1rem' }}>Your daily protocol</h3>
          {proseFor(narrative, 'protocol_intro').map((claim, i) => (
            <Claim key={i} text={claim.text} ids={claim.citationIds} />
          ))}

          <div className="protocol" style={{ marginTop: '1.25rem' }}>
            {rhythm.map((item) => (
              <ProtocolRow key={item.id} item={item} />
            ))}
            {critical.map((item) => (
              <ProtocolRow key={item.id} item={item} />
            ))}
          </div>

          {protocol.interactionItems.length > 0 && (
            <div style={{ marginTop: '1.25rem' }}>
              <p className="eyebrow">Because of what else you take</p>
              <div className="protocol">
                {protocol.interactionItems.map((item) => (
                  <ProtocolRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}

          {optional.length > 0 && (
            <details style={{ marginTop: '1rem' }}>
              <summary>Everything else worth knowing ({optional.length})</summary>
              <div className="protocol" style={{ marginTop: '0.7rem' }}>
                {optional.map((item) => (
                  <ProtocolRow key={item.id} item={item} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ---- the boundary, in plain words ---- */}
      <div className="card" style={{ marginTop: '2rem', background: 'var(--sunken)' }}>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
          One thing this report cannot tell you
        </h3>
        <p style={{ margin: 0, fontSize: '0.94rem' }} className="muted">
          It cannot tell you which antidepressant will lift your mood. Genetics can say how much of
          a drug reaches you, how likely you are to tolerate it, and which options are unsafe for
          you — and that is genuinely useful when a dose has been wrong. It cannot predict whether a
          medicine will work, because depression is not a single-gene condition and anyone claiming
          otherwise is overselling. What this gives you is a better starting point, not a guarantee.
        </p>
      </div>
    </div>
  )
}
