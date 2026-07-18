/**
 * The trust panel.
 *
 * This exists because "our LLM cannot hallucinate a dose" is a claim, and a claim about
 * safety should be inspectable rather than asserted in marketing copy. So the rejection log
 * is a product surface: here is what the narrative layer tried to write, here is the exact
 * token that failed, here is why it was dropped.
 */

import { Cite } from './Citation'
import type { AnalysisResult, ExcludedGeneCall, Rejection } from '../engine/types'

const KIND_LABEL: Record<Rejection['kind'], string> = {
  number_not_in_source: 'number not in source',
  drug_not_in_source: 'drug not in source',
  citation_not_in_source: 'citation not in source',
  uncited_clinical_claim: 'clinical claim with no source',
}

export function ExcludedGenes({ genes }: { genes: ExcludedGeneCall[] }) {
  if (!genes.length) return null
  return (
    <div className="excluded">
      <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>
        Reviewed — not clinically actionable
      </p>
      {genes.map((gene) => (
        <div key={gene.gene} style={{ marginBottom: '1rem' }}>
          <h3>
            {gene.gene} <span className="excluded__observed">{gene.observed}</span>
          </h3>
          <p style={{ fontSize: '0.88rem', margin: '0.3rem 0 0', maxWidth: '52ch' }}>
            {gene.rationale.text}
            <Cite ids={gene.rationale.citationIds} />
          </p>
        </div>
      ))}
    </div>
  )
}

export function TrustPanel({ result }: { result: AnalysisResult }) {
  const { narrative, trace } = result
  const deterministicSteps = trace.filter((t) => t.kind === 'deterministic').length
  const totalMs = Math.round(trace.reduce((sum, t) => sum + t.ms, 0))

  return (
    <section>
      <div className="shell">
        <div className="section-head">
          <p className="eyebrow">How to trust this</p>
          <h2>What the language model was and was not allowed to do</h2>
          <p className="lede" style={{ marginTop: '0.9rem' }}>
            Every dose, drug name and rule in this report came from a guideline lookup. The model
            was allowed to sequence and explain those facts, and nothing else. Anything it wrote
            containing a number, a drug or a citation that was not already in the structured input
            was dropped before rendering — including the sentences below.
          </p>
        </div>

        <div className="stat-row">
          <div className="stat">
            <div className="stat__value">{narrative.claimsChecked}</div>
            <div className="stat__label">claims checked</div>
          </div>
          <div className="stat">
            <div className="stat__value" style={{ color: 'var(--red)' }}>
              {narrative.rejections.length}
            </div>
            <div className="stat__label">rejected before render</div>
          </div>
          <div className="stat">
            <div className="stat__value">{Object.keys(result.citations).length}</div>
            <div className="stat__label">sources cited</div>
          </div>
          <div className="stat">
            <div className="stat__value">{deterministicSteps}</div>
            <div className="stat__label">deterministic steps</div>
          </div>
          <div className="stat">
            <div className="stat__value">{totalMs}ms</div>
            <div className="stat__label">total analysis</div>
          </div>
        </div>

        {/* ---- rejection log ---- */}
        <h3 style={{ marginBottom: '0.5rem' }}>Rejection log</h3>
        <p className="muted" style={{ fontSize: '0.92rem' }}>
          To show the check working rather than describe it, the narrative layer is also fed a set
          of realistic model failures — an invented starting dose, a response rate nobody measured,
          a drug that was never in your data, a citation that drifted to the wrong guideline, and a
          clinical assertion with no source at all. The validator sees them exactly as it would see
          live model output.
        </p>

        <div style={{ marginTop: '1.25rem' }}>
          {narrative.rejections.map((rejection, i) => (
            <div className="rejection" key={i}>
              <div className="rejection__kind">
                {KIND_LABEL[rejection.kind]} · {rejection.section.replace(/_/g, ' ')}
              </div>
              <div className="rejection__text">{rejection.text}</div>
              <div className="rejection__reason">
                <span className="rejection__token">{rejection.offendingToken}</span> — {rejection.reason}
              </div>
            </div>
          ))}
          {narrative.rejections.length === 0 && (
            <p className="muted">Nothing was rejected in this run.</p>
          )}
        </div>

        <details style={{ marginTop: '1.25rem' }}>
          <summary>What the validator checked against</summary>
          <div className="card" style={{ marginTop: '0.7rem' }}>
            <div className="detail-block__label">
              Permitted drug names ({narrative.allowedDrugs.length})
            </div>
            <p className="faint" style={{ maxWidth: 'none' }}>
              {narrative.allowedDrugs.join(', ')}
            </p>
            <div className="detail-block__label" style={{ marginTop: '1rem' }}>
              Permitted numbers ({narrative.allowedNumbers.length})
            </div>
            <p className="faint" style={{ maxWidth: 'none' }}>
              {narrative.allowedNumbers.join(', ')}
            </p>
            <div className="detail-block__label" style={{ marginTop: '1rem' }}>
              Permitted citations ({narrative.allowedCitationIds.length})
            </div>
            <p className="faint" style={{ maxWidth: 'none' }}>
              {narrative.allowedCitationIds.join(', ')}
            </p>
          </div>
        </details>

        {/* ---- pipeline trace ---- */}
        <h3 style={{ margin: '2.5rem 0 0.75rem' }}>What actually ran</h3>
        <div>
          {trace.map((step, i) => (
            <div className="trace-line" key={i} style={{ animationDelay: '0ms', opacity: 1 }}>
              <span className="trace-line__mark">
                {step.kind === 'model' ? '◇' : step.kind === 'validator' ? '⊘' : '✓'}
              </span>
              <span>
                <strong style={{ fontSize: '0.92rem' }}>{step.step}</strong>
                <span className="badge badge--neutral" style={{ marginLeft: '0.5rem' }}>
                  {step.kind}
                </span>
                <div className="trace-line__detail">{step.detail}</div>
              </span>
              <span className="trace-line__ms">{step.ms}ms</span>
            </div>
          ))}
        </div>

        <p className="faint" style={{ marginTop: '1rem' }}>
          Star alleles and phenotypes came from {result.pharmcat.pharmcatVersion}. Guideline text is
          CPIC's own wording, reproduced rather than paraphrased.
          <Cite ids={['pharmcat']} />
        </p>
      </div>
    </section>
  )
}
