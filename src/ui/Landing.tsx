/**
 * The way in.
 *
 * Three steps, all visible at once, none of them mandatory-feeling. The genome step accepts
 * a real file and also offers prepared cases, because most people arriving here will not
 * have a VCF on their desktop and the product should still be able to show them what it does.
 */

import { useMemo, useRef, useState } from 'react'
import { DRUG_LEXICON } from '../data/drug-lexicon'
import { FIXTURES, fixtureToFileText, type Fixture } from '../engine/pharmcat/fixtures'
import type { AssayType, PastTrial, TrialOutcome } from '../engine/types'

export interface RunConfig {
  fixtureId: string | null
  uploadedText: string | null
  fileName: string
  assayType: AssayType
  medications: string[]
  trials: PastTrial[]
}

const OUTCOME_LABEL: Record<TrialOutcome, string> = {
  no_effect: 'did not help',
  side_effects: 'side effects',
  helped: 'it helped',
  stopped_other: 'stopped for another reason',
}

/* ------------------------------------------------------------------ */

function DrugAutocomplete({
  placeholder,
  onPick,
  exclude,
}: {
  placeholder: string
  onPick: (generic: string) => void
  exclude: string[]
}) {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return DRUG_LEXICON.filter(
      (entry) =>
        !exclude.includes(entry.generic) &&
        (entry.generic.toLowerCase().includes(q) ||
          entry.brands.some((b) => b.toLowerCase().includes(q))),
    ).slice(0, 7)
  }, [query, exclude])

  return (
    <div className="autocomplete">
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 150)}
      />
      {focused && matches.length > 0 && (
        <div className="autocomplete__menu">
          {matches.map((entry) => (
            <button
              key={entry.generic}
              className="autocomplete__item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(entry.generic)
                setQuery('')
              }}
            >
              <span>
                {entry.generic}
                {entry.brands.length > 0 && (
                  <span className="autocomplete__hint"> · {entry.brands.slice(0, 2).join(', ')}</span>
                )}
              </span>
              <span className="autocomplete__hint">{entry.hint ?? entry.drugClass}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function Landing({ onRun }: { onRun: (config: RunConfig) => void }) {
  const [fixture, setFixture] = useState<Fixture | null>(FIXTURES[0])
  const [uploaded, setUploaded] = useState<{ name: string; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [medications, setMedications] = useState<string[]>(FIXTURES[0].suggestedMedications)
  const [trials, setTrials] = useState<PastTrial[]>(FIXTURES[0].suggestedTrials)
  const fileInput = useRef<HTMLInputElement>(null)

  const selectFixture = (f: Fixture) => {
    setFixture(f)
    setUploaded(null)
    setMedications(f.suggestedMedications)
    setTrials(f.suggestedTrials)
  }

  const readFile = async (file: File) => {
    const text = await file.text()
    setUploaded({ name: file.name, text })
    setFixture(null)
  }

  const downloadFixture = (f: Fixture) => {
    const blob = new Blob([fixtureToFileText(f)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = f.fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  const ready = Boolean(fixture || uploaded)

  const run = () => {
    if (!ready) return
    onRun({
      fixtureId: fixture?.id ?? null,
      uploadedText: uploaded?.text ?? null,
      fileName: uploaded?.name ?? fixture?.fileName ?? 'genome.txt',
      assayType: fixture?.assayType ?? 'consumer-array',
      medications,
      trials,
    })
  }

  return (
    <>
      <div className="shell shell--narrow hero">
        <p className="eyebrow">Pharmacogenomic decision support</p>
        <h1>Your antidepressant may have failed at the dose, not the drug.</h1>
        <p className="lede">
          Around a third of people get better on the first antidepressant they try. For some of the
          rest, the medicine was reasonable and the amount reaching them was not — cleared too fast
          to work, or too slowly to tolerate. That is measurable. This tells you which one happened
          to you, and what it means for what comes next.
        </p>
      </div>

      <div className="shell shell--narrow">
        {/* -- 1 ------------------------------------------------------ */}
        <div className="step">
          <div className="step__number">01</div>
          <div>
            <h3 className="step__title">Your genome file</h3>
            <p className="step__hint">
              A 23andMe raw export or a VCF. Nothing leaves your browser — the analysis runs on this
              device.
            </p>

            <div
              className={[
                'dropzone',
                dragging ? 'dropzone--active' : '',
                uploaded ? 'dropzone--loaded' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                const file = e.dataTransfer.files[0]
                if (file) void readFile(file)
              }}
            >
              {uploaded ? (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <strong>{uploaded.name}</strong>
                    <div className="faint">Loaded and ready</div>
                  </div>
                  <button className="btn--plain" onClick={() => setUploaded(null)}>
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <p className="muted" style={{ margin: '0 auto 0.6rem', maxWidth: '28ch' }}>
                    Drop your file here
                  </p>
                  <button className="btn btn--ghost" onClick={() => fileInput.current?.click()}>
                    Choose a file
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".txt,.vcf,.csv,.tsv"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void readFile(file)
                    }}
                  />
                </>
              )}
            </div>

            <p className="faint" style={{ margin: '1.25rem 0 0.5rem' }}>
              Or use a prepared case with known results:
            </p>
            <div className="fixture-grid">
              {FIXTURES.map((f) => (
                <button
                  key={f.id}
                  className={`fixture ${fixture?.id === f.id ? 'fixture--selected' : ''}`}
                  onClick={() => selectFixture(f)}
                >
                  <div className="fixture__title">{f.title}</div>
                  <div className="fixture__story">{f.story}</div>
                </button>
              ))}
            </div>
            {fixture && (
              <p className="faint" style={{ marginTop: '0.7rem' }}>
                <button className="btn--plain" onClick={() => downloadFixture(fixture)}>
                  Download this case as a genome file
                </button>{' '}
                to test the upload path for real.
              </p>
            )}
          </div>
        </div>

        {/* -- 2 ------------------------------------------------------ */}
        <div className="step">
          <div className="step__number">02</div>
          <div>
            <h3 className="step__title">What you take now</h3>
            <p className="step__hint">
              Everything, not just the psychiatric ones. Painkillers, heartburn tablets and herbal
              supplements are the ones most often left out, and they are frequently the ones that
              matter.
            </p>
            {medications.length > 0 && (
              <div className="chips">
                {medications.map((m) => (
                  <span className="chip" key={m}>
                    {m}
                    <button
                      className="chip__x"
                      onClick={() => setMedications(medications.filter((x) => x !== m))}
                      aria-label={`Remove ${m}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <DrugAutocomplete
              placeholder="Start typing a medicine or brand name"
              exclude={medications}
              onPick={(generic) => setMedications([...medications, generic])}
            />
          </div>
        </div>

        {/* -- 3 ------------------------------------------------------ */}
        <div className="step">
          <div className="step__number">03</div>
          <div>
            <h3 className="step__title">What you have already tried</h3>
            <p className="step__hint">
              Antidepressants you have been on before, and roughly how they went. This is what lets
              the report explain the past rather than only guess at the future.
            </p>
            {trials.length > 0 && (
              <div style={{ marginBottom: '0.9rem' }}>
                {trials.map((trial, index) => (
                  <div className="trial-row" key={`${trial.drug}-${index}`}>
                    <span className="chip chip--trial">
                      {trial.drug}
                      <button
                        className="chip__x"
                        onClick={() => setTrials(trials.filter((_, i) => i !== index))}
                        aria-label={`Remove ${trial.drug}`}
                      >
                        ×
                      </button>
                    </span>
                    <select
                      value={trial.outcome}
                      onChange={(e) => {
                        const next = [...trials]
                        next[index] = { ...trial, outcome: e.target.value as TrialOutcome }
                        setTrials(next)
                      }}
                    >
                      {(Object.keys(OUTCOME_LABEL) as TrialOutcome[]).map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {OUTCOME_LABEL[outcome]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            <DrugAutocomplete
              placeholder="Add an antidepressant you have tried"
              exclude={trials.map((t) => t.drug)}
              onPick={(generic) => setTrials([...trials, { drug: generic, outcome: 'no_effect' }])}
            />
          </div>
        </div>

        <div className="step" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <div className="step__number" />
          <div>
            <button className="btn btn--primary" onClick={run} disabled={!ready}>
              See what this means for you
            </button>
            <p className="faint" style={{ marginTop: '0.85rem' }}>
              Takes a few seconds. Nothing is uploaded or stored.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
