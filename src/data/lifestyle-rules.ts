/**
 * Drug-specific daily-use facts backed by pinned prescribing-information evidence.
 *
 * These are intentionally product-specific facts, not class-wide wellness advice. The
 * evidence id is also the rule id, so an unsupported rule has no citation and is dropped by
 * the protocol builder. A source refresh fails before writing data if any exact evidence
 * phrase disappears from its pinned SPL record.
 */

import { canonicalDrug } from './drug-lexicon'
import { citeLabelEvidence } from './openfda'
import type { ProtocolCategory, Severity } from '../engine/types'

export interface LifestyleRule {
  id: string
  drugs: string[]
  label: string
  icon: string
  category: ProtocolCategory
  severity: Severity
  rule: string
  why: string
  citationIds: string[]
}

type SourcedRule = Omit<LifestyleRule, 'citationIds'>

function sourced(rule: SourcedRule): LifestyleRule {
  return { ...rule, citationIds: citeLabelEvidence(rule.id) }
}

export const LIFESTYLE_RULES: LifestyleRule[] = [
  sourced({
    id: 'fluoxetine-morning', drugs: ['fluoxetine'], label: 'Morning', icon: '☀',
    category: 'timing', severity: 'info',
    rule: 'Morning.',
    why: 'The pinned fluoxetine label specifies morning dosing for major depressive disorder.',
  }),
  sourced({
    id: 'fluoxetine-driving', drugs: ['fluoxetine'], label: 'Driving', icon: '🚗',
    category: 'watch', severity: 'caution',
    rule: 'Wait until you know how it affects you before driving or using machinery.',
    why: 'Fluoxetine can impair judgement, thinking or motor skills.',
  }),
  sourced({
    id: 'paroxetine-morning', drugs: ['paroxetine'], label: 'Morning', icon: '☀',
    category: 'timing', severity: 'info',
    rule: 'Morning. With or without food.',
    why: 'That schedule is stated in the pinned paroxetine tablet label.',
  }),
  sourced({
    id: 'sertraline-food', drugs: ['sertraline'], label: 'Food', icon: '🍽',
    category: 'food', severity: 'info',
    rule: 'With or without food.',
    why: 'The pinned sertraline tablet label allows use with or without food.',
  }),
  sourced({
    id: 'sertraline-alcohol', drugs: ['sertraline'], label: 'Alcohol', icon: '🚫',
    category: 'avoid', severity: 'caution',
    rule: 'Avoid alcohol.',
    why: 'The pinned sertraline label advises against using alcohol with sertraline.',
  }),
  sourced({
    id: 'escitalopram-timing', drugs: ['escitalopram'], label: 'Time and food', icon: '☀',
    category: 'timing', severity: 'info',
    rule: 'Morning or evening. With or without food.',
    why: 'The pinned escitalopram oral-solution label allows either time and use with or without food.',
  }),
  sourced({
    id: 'escitalopram-driving', drugs: ['escitalopram'], label: 'Driving', icon: '🚗',
    category: 'watch', severity: 'caution',
    rule: 'Wait until you know how it affects you before driving or using machinery.',
    why: 'This is the impairment precaution in the pinned escitalopram label.',
  }),
  sourced({
    id: 'citalopram-daily', drugs: ['citalopram'], label: 'Time and food', icon: '☀',
    category: 'timing', severity: 'info',
    rule: 'Once daily. With or without food.',
    why: 'The pinned citalopram label does not choose morning or evening.',
  }),
  sourced({
    id: 'venlafaxine-food-time', drugs: ['venlafaxine'], label: 'Food', icon: '🍽',
    category: 'food', severity: 'caution',
    rule: 'Take with food.',
    why: 'This pinned record is for immediate-release venlafaxine tablets; formulations can differ.',
  }),
  sourced({
    id: 'venlafaxine-driving', drugs: ['venlafaxine'], label: 'Driving', icon: '🚗',
    category: 'watch', severity: 'caution',
    rule: 'Wait until you know how it affects you before driving or using machinery.',
    why: 'This is the impairment precaution in the pinned venlafaxine tablet label.',
  }),
  sourced({
    id: 'venlafaxine-alcohol', drugs: ['venlafaxine'], label: 'Alcohol', icon: '🚫',
    category: 'avoid', severity: 'caution',
    rule: 'Avoid alcohol.',
    why: 'The pinned venlafaxine tablet label advises avoiding alcohol.',
  }),
  sourced({
    id: 'desvenlafaxine-time', drugs: ['desvenlafaxine'], label: 'Time and food', icon: '☀',
    category: 'timing', severity: 'info',
    rule: 'Same time each day. With or without food.',
    why: 'This schedule is stated in the pinned Pristiq extended-release label.',
  }),
  sourced({
    id: 'desvenlafaxine-alcohol', drugs: ['desvenlafaxine'], label: 'Alcohol', icon: '🚫',
    category: 'avoid', severity: 'caution',
    rule: 'Avoid alcohol.',
    why: 'The pinned Pristiq extended-release label advises avoiding alcohol.',
  }),
  sourced({
    id: 'duloxetine-food', drugs: ['duloxetine'], label: 'Food', icon: '🍽',
    category: 'food', severity: 'info',
    rule: 'With or without food.',
    why: 'The pinned duloxetine delayed-release capsule label allows use with or without meals.',
  }),
  sourced({
    id: 'duloxetine-heavy-alcohol', drugs: ['duloxetine'], label: 'Heavy alcohol use', icon: '🚫',
    category: 'avoid', severity: 'critical',
    rule: 'Severe liver-injury warning with heavy alcohol use.',
    why: 'The alcohol answer records frequency, not amount; heavy use needs a separate clinical check.',
  }),
  sourced({
    id: 'vortioxetine-food', drugs: ['vortioxetine'], label: 'Food', icon: '🍽',
    category: 'food', severity: 'info',
    rule: 'With or without food.',
    why: 'The pinned Trintellix label allows use without regard to meals.',
  }),
  sourced({
    id: 'vilazodone-food', drugs: ['vilazodone'], label: 'Food', icon: '🍽',
    category: 'food', severity: 'caution',
    rule: 'Take with food.',
    why: 'Food is required by the pinned vilazodone tablet label.',
  }),
  sourced({
    id: 'bupropion-alcohol', drugs: ['bupropion'], label: 'Alcohol', icon: '🚫',
    category: 'avoid', severity: 'critical',
    rule: 'Minimise or avoid alcohol. Do not stop heavy alcohol use suddenly without clinical advice.',
    why: 'Alcohol changes can affect seizure risk in the pinned bupropion XL label.',
  }),
  sourced({
    id: 'bupropion-eating-disorder', drugs: ['bupropion'], label: 'Eating-disorder history', icon: '🚫',
    category: 'avoid', severity: 'critical',
    rule: 'Current or prior anorexia nervosa or bulimia is a contraindication.',
    why: 'This is stated in the pinned bupropion XL contraindications section.',
  }),
  sourced({
    id: 'mirtazapine-evening', drugs: ['mirtazapine'], label: 'Evening', icon: '🌙',
    category: 'timing', severity: 'info',
    rule: 'Evening, before sleep.',
    why: 'That timing is preferred in the pinned mirtazapine tablet label.',
  }),
  sourced({
    id: 'mirtazapine-somnolence', drugs: ['mirtazapine'], label: 'Sleepiness', icon: '🌙',
    category: 'watch', severity: 'caution',
    rule: 'Can cause sleepiness and impair thinking or motor skills.',
    why: 'This is the somnolence warning in the pinned mirtazapine tablet label.',
  }),
  sourced({
    id: 'mirtazapine-driving', drugs: ['mirtazapine'], label: 'Driving', icon: '🚗',
    category: 'watch', severity: 'caution',
    rule: 'Use caution with driving or machinery.',
    why: 'This is the alertness precaution in the pinned mirtazapine tablet label.',
  }),
  sourced({
    id: 'nortriptyline-driving', drugs: ['nortriptyline'], label: 'Driving', icon: '🚗',
    category: 'watch', severity: 'caution',
    rule: 'May impair driving or machinery use.',
    why: 'This is the hazardous-task warning in the pinned nortriptyline capsule label.',
  }),
  sourced({
    id: 'amitriptyline-driving', drugs: ['amitriptyline'], label: 'Driving', icon: '🚗',
    category: 'watch', severity: 'caution',
    rule: 'May impair driving or machinery use.',
    why: 'This is the hazardous-task warning in the pinned amitriptyline tablet label.',
  }),
]

export interface InteractionRule extends LifestyleRule {
  triggerDrug: string
  appliesTo: string[]
}

export const INTERACTION_RULES: InteractionRule[] = [
  {
    ...sourced({
      id: 'vortioxetine-ibuprofen-bleeding', drugs: ['vortioxetine'], label: 'Ibuprofen', icon: '🚫',
      category: 'avoid', severity: 'caution',
      rule: 'Ibuprofen can add to the bleeding risk.',
      why: 'The pinned Trintellix label identifies NSAIDs as medicines that may add to this risk.',
    }),
    triggerDrug: 'ibuprofen',
    appliesTo: ['vortioxetine'],
  },
]

export function rulesForDrug(drug: string): LifestyleRule[] {
  const normalised = (canonicalDrug(drug) ?? drug).toLowerCase()
  return LIFESTYLE_RULES.filter((rule) =>
    rule.drugs.some((candidate) => candidate.toLowerCase() === normalised),
  )
}

export function interactionRulesFor(drug: string, currentMedications: string[]): InteractionRule[] {
  const normalisedDrug = (canonicalDrug(drug) ?? drug).toLowerCase()
  const medicines = currentMedications.map((medicine) => (canonicalDrug(medicine) ?? medicine).toLowerCase())
  return INTERACTION_RULES.filter((rule) =>
    medicines.includes(rule.triggerDrug.toLowerCase()) &&
    rule.appliesTo.some((candidate) => candidate.toLowerCase() === normalisedDrug),
  )
}
