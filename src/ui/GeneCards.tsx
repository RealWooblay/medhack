/**
 * The metaboliser profile — genetic beside functional.
 *
 * The divergence is the hero moment of the whole product, so it is animated: the functional
 * phenotype drops into place and shifts colour a beat after the card appears. One card
 * showing "Normal" above "POOR" communicates the entire thesis faster than any paragraph.
 */

import { Cite } from './Citation'
import type { GenePhenotypeResult } from '../engine/types'

function shortPhenotype(phenotype: string): string {
  return phenotype.replace(' Metabolizer', '')
}

function GeneCard({ gene }: { gene: GenePhenotypeResult }) {
  const flagged = gene.status === 'unvalidated_method' || gene.status === 'uncertain_extent'
  const dominant = gene.modifiers[0]

  return (
    <article
      className={[
        'gene-card',
        gene.converted ? 'gene-card--converted' : '',
        flagged && !gene.converted ? 'gene-card--flagged' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="gene-card__name">
        {gene.gene} · {gene.geneticActivityScore !== null ? `activity score ${gene.geneticActivityScore}` : 'diplotype-based'}
      </div>

      <div className="pheno-row">
        <span className="pheno-row__label">From your genes</span>
        <span className="pheno-row__value">{shortPhenotype(gene.geneticPhenotype)}</span>
      </div>

      <div className={`pheno-row pheno-row--functional ${gene.converted ? 'pheno-row--animate' : ''}`}>
        <span className="pheno-row__label">In practice, today</span>
        <span className={`pheno-row__value ${gene.converted ? 'pheno-row__value--alarm' : ''}`}>
          {shortPhenotype(gene.functionalPhenotype)}
          {gene.converted && ' ⚠'}
        </span>
      </div>

      {gene.converted && gene.explanation && dominant && (
        <div className="gene-card__cause">
          <strong>{dominant.drug}</strong> is a strong inhibitor of {gene.gene}, which is why these two
          lines disagree.
          {gene.functionalActivityScore !== null && (
            <> Effective activity score falls to {gene.functionalActivityScore}.</>
          )}
          <Cite ids={gene.explanation.citationIds} />
        </div>
      )}

      {gene.unresolvedWarning && (
        <div className="gene-card__flag">
          <strong>Flagged, not calculated.</strong> {dominant?.drug} inhibits {gene.gene} too, but no
          guideline-validated way exists to convert that into a number — so this one is left as your
          genetic result with the interaction noted.
          <Cite ids={gene.unresolvedWarning.citationIds} />
        </div>
      )}

      <div className="confidence">
        <span className={`confidence__dot confidence__dot--${gene.confidence.level}`} />
        <span>{gene.confidence.headline}</span>
      </div>
      {gene.confidence.level !== 'high' && (
        <details>
          <summary>Why this call is uncertain</summary>
          {gene.confidence.reasons.map((reason, i) => (
            <p key={i} className="faint" style={{ marginTop: '0.5rem' }}>
              {reason.text}
              <Cite ids={reason.citationIds} />
            </p>
          ))}
        </details>
      )}
    </article>
  )
}

export function GeneCards({ genes }: { genes: GenePhenotypeResult[] }) {
  const converted = genes.filter((g) => g.converted)

  return (
    <section>
      <div className="shell">
        <div className="section-head">
          <p className="eyebrow">Your metaboliser profile</p>
          <h2>
            {converted.length
              ? 'Your genes say one thing. Your current medication says another.'
              : 'How your body handles these medicines'}
          </h2>
          {converted.length > 0 && (
            <p className="lede" style={{ marginTop: '0.9rem' }}>
              This gap is the part a genetic test on its own would miss, because a genetic test does
              not know what else you are taking.
            </p>
          )}
        </div>

        <div className="gene-grid">
          {genes.map((gene) => (
            <GeneCard key={gene.gene} gene={gene} />
          ))}
        </div>
      </div>
    </section>
  )
}
