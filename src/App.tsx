import { ValidationConsole } from './ui/ValidationConsole'

/**
 * Validation build.
 *
 * The patient journey and report navigation are intentionally not mounted here. This single
 * surface exists to inspect input values, deterministic transformations, outputs and source
 * lineage before any production experience is validated.
 */
export function App() {
  return <ValidationConsole />
}
