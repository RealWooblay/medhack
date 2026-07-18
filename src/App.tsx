import { useCallback, useEffect, useState } from 'react'
import { runAnalysis } from './engine/pipeline'
import { TagSnpAdapter } from './engine/pharmcat/adapter'
import { FixturePharmCATAdapter, fixtureById } from './engine/pharmcat/fixtures'
import { CitationProvider } from './ui/Citation'
import { ClinicianView } from './ui/ClinicianView'
import { GeneCards } from './ui/GeneCards'
import { Landing, type RunConfig } from './ui/Landing'
import { PatientView } from './ui/PatientView'
import { Running } from './ui/Running'
import { Shortlist } from './ui/Shortlist'
import { ExcludedGenes, TrustPanel } from './ui/TrustPanel'
import type { AnalysisResult } from './engine/types'

type Phase =
  | { kind: 'input' }
  | { kind: 'running'; result: AnalysisResult }
  | { kind: 'report'; result: AnalysisResult }

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'input' })
  const [view, setView] = useState<'patient' | 'clinician'>('patient')
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (config: RunConfig) => {
    setError(null)
    try {
      const fixture = config.fixtureId ? fixtureById(config.fixtureId) : undefined
      const adapter = fixture ? new FixturePharmCATAdapter(fixture) : new TagSnpAdapter()

      const result = await runAnalysis({
        adapter,
        genome: {
          fileName: config.fileName,
          contents: config.uploadedText ?? undefined,
          assayType: config.assayType,
        },
        input: {
          genomeFileName: config.fileName,
          assayType: config.assayType,
          currentMedications: config.medications,
          pastTrials: config.trials,
        },
      })
      setPhase({ kind: 'running', result })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong reading that file.')
    }
  }, [])

  // Each phase is a new page as far as the reader is concerned, so it starts at the top.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [phase.kind])

  const result = phase.kind === 'input' ? null : phase.result

  return (
    <CitationProvider citations={result?.citations ?? {}}>
      <div className="app">
        <header className="masthead">
          <div className="shell masthead__inner">
            <div className="wordmark">
              <span className="wordmark__dot" />
              Meridian
            </div>
            {phase.kind === 'report' && (
              <button className="btn--plain" onClick={() => setPhase({ kind: 'input' })}>
                Start again
              </button>
            )}
          </div>
        </header>

        <main>
          {phase.kind === 'input' && (
            <>
              {error && (
                <div className="shell shell--narrow" style={{ paddingTop: '1.5rem' }}>
                  <div className="card" style={{ borderColor: 'var(--red)', background: 'var(--red-soft)' }}>
                    {error}
                  </div>
                </div>
              )}
              <Landing onRun={run} />
            </>
          )}

          {phase.kind === 'running' && (
            <Running
              trace={phase.result.trace}
              onDone={() => setPhase({ kind: 'report', result: phase.result })}
            />
          )}

          {phase.kind === 'report' && (
            <>
              <GeneCards genes={phase.result.genes} />

              <section style={{ paddingTop: 0, borderTop: 'none' }}>
                <div className="shell">
                  <ExcludedGenes genes={phase.result.excludedGenes} />
                </div>
              </section>

              <Shortlist shortlist={phase.result.shortlist} />

              <section>
                <div className="shell">
                  <div className="tabs" role="tablist">
                    <button
                      role="tab"
                      aria-selected={view === 'patient'}
                      className={`tab ${view === 'patient' ? 'tab--active' : ''}`}
                      onClick={() => setView('patient')}
                    >
                      For you
                    </button>
                    <button
                      role="tab"
                      aria-selected={view === 'clinician'}
                      className={`tab ${view === 'clinician' ? 'tab--active' : ''}`}
                      onClick={() => setView('clinician')}
                    >
                      For your prescriber
                    </button>
                  </div>

                  {view === 'patient' ? (
                    <PatientView result={phase.result} />
                  ) : (
                    <ClinicianView result={phase.result} />
                  )}
                </div>
              </section>

              <TrustPanel result={phase.result} />
            </>
          )}
        </main>

        <div className="disclaimer">
          <div className="shell">
            <strong>Decision support only. Not a diagnosis.</strong> Genetics informs dosing and
            safety — not which antidepressant will be effective. Always consult your prescriber.
          </div>
        </div>
      </div>
    </CitationProvider>
  )
}
