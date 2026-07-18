/**
 * The clinician view — dense, cited, and explicit about what it declined to conclude.
 *
 * The most useful thing on this page is the genotype-only comparison: the same guideline
 * table, queried with the genetic phenotype, is what a genotype-only report would have
 * handed the prescriber. Showing both side by side is the clearest possible answer to
 * "PharmCAT already does this".
 */

import { Cite } from './Citation'
import { proseFor } from '../engine/validator'
import { CPIC_SCOPE_NOTE } from '../data/cpic'
import type { AnalysisResult } from '../engine/types'

export function ClinicianView({ result }: { result: AnalysisResult }) {
  const { genes, pharmcat, narrative, shortlist } = result

  const divergent = shortlist
    .map((drug) => {
      const ours = drug.geneFindings.find((f) => f.usedFunctionalPhenotype)
      if (!ours) return null
      const baseline = pharmcat.recommendations.find(
        (r) => r.drug === drug.drug && r.gene === ours.gene,
      )
      if (!baseline || baseline.action === ours.action) return null
      return { drug, ours, baseline }
    })
    .filter(Boolean) as Array<{
    drug: (typeof shortlist)[number]
    ours: NonNullable<(typeof shortlist)[number]['geneFindings'][number]>
    baseline: (typeof pharmcat.recommendations)[number]
  }>

  return (
    <div className="stack">
      {/* ---- phenotype table ---- */}
      <div>
        <p className="eyebrow">Phenotypes</p>
        <h3 style={{ marginBottom: '0.75rem' }}>Genetic and functional</h3>
        {genes.map((gene) => (
          <div className="kv" key={gene.gene}>
            <span className="kv__key">{gene.gene}</span>
            <span>
              <strong>{gene.diplotype}</strong> · {gene.geneticPhenotype}
              {gene.geneticActivityScore !== null && ` · AS ${gene.geneticActivityScore}`}
              {' → '}
              <strong>{gene.functionalPhenotype}</strong>
              {gene.functionalActivityScore !== null &&
                gene.converted &&
                ` · AS ${gene.functionalActivityScore}`}
              <br />
              <span className="faint">
                confidence {gene.confidence.level} ({gene.confidence.score})
                {gene.modifiers.length > 0 &&
                  ` · modifiers: ${gene.modifiers.map((m) => `${m.drug} (${m.effect.replace('_', ' ')})`).join(', ')}`}
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* ---- rationale ---- */}
      <div style={{ paddingTop: '1rem' }}>
        <p className="eyebrow">Rationale</p>
        <h3 style={{ marginBottom: '0.75rem' }}>Phenoconversion and confidence</h3>
        {proseFor(narrative, 'clinician_rationale').map((claim, i) => (
          <p key={i} style={{ fontSize: '0.94rem' }}>
            {claim.text}
            <Cite ids={claim.citationIds} />
          </p>
        ))}
      </div>

      {/* ---- the contrast ---- */}
      {divergent.length > 0 && (
        <div style={{ paddingTop: '1rem' }}>
          <p className="eyebrow">Against a genotype-only report</p>
          <h3 style={{ marginBottom: '0.75rem' }}>
            Where medication context changes the recommendation
          </h3>
          <p className="muted" style={{ fontSize: '0.94rem' }}>
            Both columns query the same CPIC table. The difference is entirely that one of them
            knows what the patient is currently taking.
          </p>
          {divergent.map(({ drug, ours, baseline }) => (
            <div className="card" key={drug.drug} style={{ marginBottom: '0.7rem' }}>
              <strong>{drug.drug}</strong>
              <div className="kv" style={{ borderTop: 'none', paddingTop: '0.5rem' }}>
                <span className="kv__key">Genotype only</span>
                <span>
                  {baseline.phenotype} → <strong>{baseline.action.replace(/_/g, ' ')}</strong>
                  <br />
                  <span className="faint">{baseline.text}</span>
                  <Cite ids={baseline.citationIds} />
                </span>
              </div>
              <div className="kv">
                <span className="kv__key">With medication context</span>
                <span>
                  {ours.phenotypeUsed} → <strong>{ours.action.replace(/_/g, ' ')}</strong>
                  <br />
                  <span className="faint">{ours.guidelineText}</span>
                  <Cite ids={ours.citationIds} />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- scope ---- */}
      <div className="card" style={{ background: 'var(--sunken)', marginTop: '1.5rem' }}>
        <div className="detail-block__label">Guideline scope</div>
        <p style={{ margin: 0, fontSize: '0.9rem' }} className="muted">
          {CPIC_SCOPE_NOTE}
          <Cite ids={['cpic-2023-sri']} />
        </p>
      </div>
    </div>
  )
}
