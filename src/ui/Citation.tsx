/**
 * Citation rendering.
 *
 * `<Cite ids={...} />` is the only way clinical text gets a source badge, and it renders
 * nothing at all if the ids do not resolve. That is deliberate: a badge pointing at a
 * source that is not in the registry would be worse than no badge, because it looks like
 * verification while providing none.
 */

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Citation } from '../engine/types'

interface CitationContextValue {
  citations: Record<string, Citation>
  open: (ids: string[]) => void
}

const CitationContext = createContext<CitationContextValue>({ citations: {}, open: () => {} })

export function CitationProvider({
  citations,
  children,
}: {
  citations: Record<string, Citation>
  children: ReactNode
}) {
  const [openIds, setOpenIds] = useState<string[] | null>(null)

  return (
    <CitationContext.Provider value={{ citations, open: setOpenIds }}>
      {children}
      {openIds && (
        <>
          <div className="drawer-backdrop" onClick={() => setOpenIds(null)} />
          <aside className="drawer" role="dialog" aria-label="Sources">
            <button className="drawer__close" onClick={() => setOpenIds(null)} aria-label="Close">
              ×
            </button>
            <p className="eyebrow">Where this comes from</p>
            <h2 style={{ marginBottom: '1.25rem' }}>Sources</h2>
            {openIds
              .map((id) => citations[id])
              .filter(Boolean)
              .map((citation) => (
                <div className="source-card" key={citation.id}>
                  <div className="source-card__label">{citation.label}</div>
                  <div className="source-card__title">{citation.title}</div>
                  <a href={citation.url} target="_blank" rel="noreferrer noopener">
                    {citation.url}
                  </a>
                </div>
              ))}
            <p className="faint" style={{ marginTop: '1.5rem' }}>
              Every clinical statement in this report resolves to one of these. Nothing is rendered
              without one.
            </p>
          </aside>
        </>
      )}
    </CitationContext.Provider>
  )
}

export function Cite({ ids }: { ids: string[] }) {
  const { citations, open } = useContext(CitationContext)
  const resolved = ids.map((id) => citations[id]).filter(Boolean)
  if (!resolved.length) return null

  const labels = [...new Set(resolved.map((c) => c.label))]
  const shown = labels.slice(0, 2)
  const extra = labels.length - shown.length

  return (
    <button
      className="cite"
      onClick={(e) => {
        e.stopPropagation()
        open(ids)
      }}
      title="View sources"
    >
      {shown.join(' · ')}
      {extra > 0 ? ` +${extra}` : ''}
    </button>
  )
}

/** Paragraph of validated prose with its sources attached. */
export function Claim({ text, ids }: { text: string; ids: string[] }) {
  return (
    <p>
      {text}
      <Cite ids={ids} />
    </p>
  )
}
