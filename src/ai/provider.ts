import { composeNarrative, type NarrativeFacts } from '../engine/orchestrator'
import type { Draft } from '../engine/types'

/**
 * The model may write only a Draft. It never receives authority to mutate the clinical
 * result, and its Draft still passes through the same validator as the offline composer.
 */
export interface NarrativeProvider {
  readonly name: string
  readonly mode: 'template' | 'ai'
  compose(facts: NarrativeFacts): Promise<Draft>
}

export class OfflineNarrativeProvider implements NarrativeProvider {
  readonly name = 'Offline evidence composer'
  readonly mode = 'template' as const

  async compose(facts: NarrativeFacts): Promise<Draft> {
    return composeNarrative(facts)
  }
}
