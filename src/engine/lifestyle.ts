/**
 * Extension 5 — lifestyle protocol fusion.
 *
 * Assembles the daily protocol for a specific drug and this specific patient's other
 * medications. Critical label items are pinned so the UI cannot collapse them.
 */

import { interactionRulesFor, rulesForDrug, type InteractionRule, type LifestyleRule } from '../data/lifestyle-rules'
import type { LifestyleProtocol, ProtocolItem, Severity } from './types'

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, caution: 1, info: 2 }

const CATEGORY_ORDER: Record<string, number> = {
  timing: 0,
  food: 1,
  hydration: 2,
  avoid: 3,
  watch: 4,
  metabolic: 5,
}

function toItem(rule: LifestyleRule | InteractionRule): ProtocolItem {
  return {
    id: rule.id,
    label: rule.label,
    icon: rule.icon,
    category: rule.category,
    severity: rule.severity,
    rule: rule.rule,
    why: rule.why,
    citationIds: rule.citationIds,
    pinned: rule.severity === 'critical',
  }
}

function sortItems(items: ProtocolItem[]): ProtocolItem[] {
  return [...items].sort((a, b) => {
    if (SEVERITY_ORDER[a.severity] !== SEVERITY_ORDER[b.severity]) {
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    }
    return (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9)
  })
}

/**
 * No source, no render — enforced here rather than trusted.
 *
 * A rule can end up uncited legitimately: its citation resolves to a label section that was
 * not captured for that particular drug, and `citeLabel` correctly returns nothing rather
 * than pointing at a neighbouring drug's label. When that happens the rule is dropped. A
 * lifestyle instruction with no source is exactly the kind of plausible-sounding wellness
 * advice this product exists to not produce.
 */
function requireSource(items: ProtocolItem[]): ProtocolItem[] {
  return items.filter((item) => item.citationIds.length > 0)
}

export function buildProtocol(drug: string, currentMedications: string[]): LifestyleProtocol {
  const items = sortItems(requireSource(rulesForDrug(drug).map(toItem)))
  const interactionItems = sortItems(
    requireSource(interactionRulesFor(drug, currentMedications).map(toItem)),
  )
  return { drug, items, interactionItems }
}
