/**
 * Drug-specific daily-use facts.
 *
 * A rule is included only when the captured source supports the exact medicine and wording.
 * We deliberately do not turn one product label into a class-wide claim. Absence from this
 * file means “not compared in this evidence snapshot”, not “no risk” or “no restriction”.
 */

import { citeLabel } from './openfda'
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

export const LIFESTYLE_RULES: LifestyleRule[] = [
  {
    id: 'fluoxetine-morning',
    drugs: ['fluoxetine'],
    label: 'LABEL TIMING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'For major depressive disorder, the captured US fluoxetine label specifies morning dosing.',
    why: 'This is the timing stated in the captured dosage section; the prescriber sets the dose and formulation.',
    citationIds: citeLabel('fluoxetine', 'dosage_and_administration'),
  },
  {
    id: 'fluoxetine-driving',
    drugs: ['fluoxetine'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The fluoxetine label cautions that it can impair judgement, thinking or motor skills.',
    why: 'Follow the label and prescriber advice before driving or operating hazardous machinery.',
    citationIds: citeLabel('fluoxetine', 'warnings_and_cautions'),
  },
  {
    id: 'fluoxetine-taper',
    drugs: ['fluoxetine'],
    label: 'STOPPING',
    icon: '↘',
    category: 'watch',
    severity: 'caution',
    rule: 'The fluoxetine label recommends gradual dose reduction rather than abrupt cessation whenever possible.',
    why: 'Stopping or changing an antidepressant is a prescriber decision.',
    citationIds: citeLabel('fluoxetine', 'warnings_and_cautions'),
  },
  {
    id: 'paroxetine-morning',
    drugs: ['paroxetine'],
    label: 'LABEL TIMING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'The captured paroxetine tablet label specifies one daily dose in the morning, with or without food.',
    why: 'This is the schedule stated in the captured dosage section.',
    citationIds: citeLabel('paroxetine', 'dosage_and_administration'),
  },
  {
    id: 'paroxetine-taper',
    drugs: ['paroxetine'],
    label: 'STOPPING',
    icon: '↘',
    category: 'watch',
    severity: 'caution',
    rule: 'The paroxetine label recommends gradual dose reduction rather than abrupt cessation whenever possible.',
    why: 'Stopping or changing an antidepressant is a prescriber decision.',
    citationIds: citeLabel('paroxetine', 'warnings_and_cautions'),
  },
  {
    id: 'sertraline-food',
    drugs: ['sertraline'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'info',
    rule: 'The captured sertraline label says it may be taken with or without food.',
    why: 'The captured label reports a food effect, but does not require a meal.',
    citationIds: [
      ...citeLabel('sertraline', 'dosage_and_administration'),
      ...citeLabel('sertraline', 'food_effect'),
    ],
  },
  {
    id: 'sertraline-alcohol',
    drugs: ['sertraline'],
    label: 'ALCOHOL',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    rule: 'The captured sertraline label advises against concomitant alcohol use.',
    why: 'This is a direct product-label statement.',
    citationIds: citeLabel('sertraline', 'warnings_and_cautions'),
  },
  {
    id: 'sertraline-taper',
    drugs: ['sertraline'],
    label: 'STOPPING',
    icon: '↘',
    category: 'watch',
    severity: 'caution',
    rule: 'The sertraline label recommends gradual dose reduction rather than abrupt cessation whenever possible.',
    why: 'Stopping or changing an antidepressant is a prescriber decision.',
    citationIds: citeLabel('sertraline', 'warnings_and_cautions'),
  },
  {
    id: 'escitalopram-timing',
    drugs: ['escitalopram'],
    label: 'LABEL TIMING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'The captured escitalopram label allows once-daily dosing in the morning or evening, with or without food.',
    why: 'The person and prescriber can choose a consistent time within that label instruction.',
    citationIds: citeLabel('escitalopram', 'dosage_and_administration'),
  },
  {
    id: 'escitalopram-driving',
    drugs: ['escitalopram'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The escitalopram label cautions against hazardous machinery, including driving, until its effects are known.',
    why: 'This is a direct product-label precaution.',
    citationIds: citeLabel('escitalopram', 'warnings_and_cautions'),
  },
  {
    id: 'escitalopram-taper',
    drugs: ['escitalopram'],
    label: 'STOPPING',
    icon: '↘',
    category: 'watch',
    severity: 'caution',
    rule: 'The escitalopram label recommends gradual dose reduction rather than abrupt cessation whenever possible.',
    why: 'Stopping or changing an antidepressant is a prescriber decision.',
    citationIds: citeLabel('escitalopram', 'warnings_and_cautions'),
  },
  {
    id: 'citalopram-daily',
    drugs: ['citalopram'],
    label: 'LABEL TIMING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'The captured citalopram label specifies once-daily dosing with or without food.',
    why: 'The captured section does not state morning or evening, so this report does not choose one.',
    citationIds: citeLabel('citalopram', 'dosage_and_administration'),
  },
  {
    id: 'citalopram-driving',
    drugs: ['citalopram'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The citalopram label cautions about activities that require alertness.',
    why: 'This is a direct product-label precaution.',
    citationIds: citeLabel('citalopram', 'warnings_and_cautions'),
  },
  {
    id: 'citalopram-taper',
    drugs: ['citalopram'],
    label: 'STOPPING',
    icon: '↘',
    category: 'watch',
    severity: 'caution',
    rule: 'The citalopram label recommends gradual dose reduction rather than abrupt cessation whenever possible.',
    why: 'Stopping or changing an antidepressant is a prescriber decision.',
    citationIds: citeLabel('citalopram', 'warnings_and_cautions'),
  },
  {
    id: 'venlafaxine-food-time',
    drugs: ['venlafaxine'],
    label: 'FOOD AND TIME',
    icon: '🍽',
    category: 'timing',
    severity: 'info',
    rule: 'The captured venlafaxine label says to take it with food at approximately the same time each day.',
    why: 'This is the schedule stated in the captured dosage section.',
    citationIds: citeLabel('venlafaxine', 'dosage_and_administration'),
  },
  {
    id: 'venlafaxine-driving',
    drugs: ['venlafaxine'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The venlafaxine label cautions about hazardous machinery, including driving.',
    why: 'This is a direct product-label precaution.',
    citationIds: citeLabel('venlafaxine', 'warnings_and_cautions'),
  },
  {
    id: 'venlafaxine-alcohol',
    drugs: ['venlafaxine'],
    label: 'ALCOHOL',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    rule: 'The captured venlafaxine label advises avoiding alcohol.',
    why: 'This is a direct product-label instruction.',
    citationIds: citeLabel('venlafaxine', 'warnings_and_cautions'),
  },
  {
    id: 'desvenlafaxine-time',
    drugs: ['desvenlafaxine'],
    label: 'LABEL TIMING',
    icon: '☀',
    category: 'timing',
    severity: 'info',
    rule: 'The captured desvenlafaxine label specifies once daily at approximately the same time, with or without food.',
    why: 'This is the schedule stated in the captured dosage section.',
    citationIds: citeLabel('desvenlafaxine', 'dosage_and_administration'),
  },
  {
    id: 'desvenlafaxine-alcohol',
    drugs: ['desvenlafaxine'],
    label: 'ALCOHOL',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    rule: 'The captured desvenlafaxine label advises avoiding alcohol.',
    why: 'This is a direct product-label instruction.',
    citationIds: citeLabel('desvenlafaxine', 'warnings_and_cautions'),
  },
  {
    id: 'duloxetine-food',
    drugs: ['duloxetine'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'info',
    rule: 'The captured duloxetine label allows once-daily dosing with or without food.',
    why: 'The captured label does not require a meal.',
    citationIds: citeLabel('duloxetine', 'dosage_and_administration'),
  },
  {
    id: 'duloxetine-heavy-alcohol',
    drugs: ['duloxetine'],
    label: 'ALCOHOL REVIEW',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule: 'The duloxetine label warns that concomitant heavy alcohol intake may be associated with severe liver injury.',
    why: 'Recorded heavy alcohol use or liver disease needs prescriber review before treatment.',
    citationIds: citeLabel('duloxetine', 'warnings_and_cautions'),
  },
  {
    id: 'vortioxetine-food',
    drugs: ['vortioxetine'],
    label: 'FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'info',
    rule: 'The captured vortioxetine label allows dosing with or without food.',
    why: 'The captured label does not require a meal.',
    citationIds: citeLabel('vortioxetine', 'dosage_and_administration'),
  },
  {
    id: 'vilazodone-food',
    drugs: ['vilazodone'],
    label: 'TAKE WITH FOOD',
    icon: '🍽',
    category: 'food',
    severity: 'caution',
    rule: 'The captured vilazodone label requires dosing with food.',
    why: 'The label reports substantially lower exposure in the fasted state.',
    citationIds: [
      ...citeLabel('vilazodone', 'dosage_and_administration'),
      ...citeLabel('vilazodone', 'food_effect'),
    ],
  },
  {
    id: 'bupropion-alcohol',
    drugs: ['bupropion'],
    label: 'ALCOHOL REVIEW',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule: 'The captured bupropion label says alcohol consumption should be minimised or avoided.',
    why: 'It also lists abrupt discontinuation of alcohol or sedatives as a contraindication; a clinician should plan any change.',
    citationIds: citeLabel('bupropion', 'warnings_and_cautions'),
  },
  {
    id: 'bupropion-eating-disorder',
    drugs: ['bupropion'],
    label: 'CONTRAINDICATION',
    icon: '🚫',
    category: 'avoid',
    severity: 'critical',
    rule: 'The captured bupropion label lists current or prior anorexia nervosa or bulimia as a contraindication.',
    why: 'This recorded history requires prescriber review; the app does not make the prescribing decision.',
    citationIds: citeLabel('bupropion', 'warnings_and_cautions'),
  },
  {
    id: 'mirtazapine-evening',
    drugs: ['mirtazapine'],
    label: 'LABEL TIMING',
    icon: '🌙',
    category: 'timing',
    severity: 'info',
    rule: 'The captured mirtazapine label specifies once daily, preferably in the evening before sleep.',
    why: 'This is the schedule stated in the captured dosage section.',
    citationIds: citeLabel('mirtazapine', 'dosage_and_administration'),
  },
  {
    id: 'mirtazapine-somnolence',
    drugs: ['mirtazapine'],
    label: 'SOMNOLENCE',
    icon: '🌙',
    category: 'watch',
    severity: 'caution',
    rule: 'The captured mirtazapine label warns that somnolence is very common.',
    why: 'Current daytime sleepiness and safety-sensitive work should be discussed with the prescriber.',
    citationIds: citeLabel('mirtazapine', 'warnings_and_cautions'),
  },
  {
    id: 'mirtazapine-driving',
    drugs: ['mirtazapine'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The mirtazapine label cautions against driving or hazardous machinery until its effects are known.',
    why: 'This is a direct product-label precaution.',
    citationIds: citeLabel('mirtazapine', 'warnings_and_cautions'),
  },
  {
    id: 'nortriptyline-driving',
    drugs: ['nortriptyline'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The nortriptyline label warns that it may impair abilities needed for driving or operating machinery.',
    why: 'This is a direct product-label precaution.',
    citationIds: citeLabel('nortriptyline', 'warnings_and_cautions'),
  },
  {
    id: 'amitriptyline-driving',
    drugs: ['amitriptyline'],
    label: 'DRIVING',
    icon: '🚗',
    category: 'watch',
    severity: 'caution',
    rule: 'The amitriptyline label warns about possible impairment during driving or hazardous tasks.',
    why: 'This is a direct product-label precaution.',
    citationIds: citeLabel('amitriptyline', 'warnings_and_cautions'),
  },
]

export interface InteractionRule extends LifestyleRule {
  triggerDrug: string
  appliesTo: string[]
}

/**
 * Only pair-specific interactions supported by the captured target-drug label belong here.
 * General enzyme tables do not establish a patient-facing interaction instruction.
 */
export const INTERACTION_RULES: InteractionRule[] = [
  {
    id: 'vortioxetine-ibuprofen-bleeding',
    drugs: ['vortioxetine'],
    triggerDrug: 'ibuprofen',
    appliesTo: ['vortioxetine'],
    label: 'REVIEW TOGETHER',
    icon: '🚫',
    category: 'avoid',
    severity: 'caution',
    rule: 'You recorded ibuprofen. The vortioxetine label reports increased bleeding risk with NSAIDs.',
    why: 'Ask the prescriber or pharmacist to review the combination rather than changing either medicine yourself.',
    citationIds: citeLabel('vortioxetine', 'warnings_and_cautions'),
  },
]

export function rulesForDrug(drug: string): LifestyleRule[] {
  const normalised = drug.toLowerCase()
  return LIFESTYLE_RULES.filter((rule) =>
    rule.drugs.some((candidate) => candidate.toLowerCase() === normalised),
  )
}

export function interactionRulesFor(drug: string, currentMedications: string[]): InteractionRule[] {
  const normalisedDrug = drug.toLowerCase()
  const medicines = currentMedications.map((medicine) => medicine.toLowerCase())
  return INTERACTION_RULES.filter((rule) =>
    medicines.includes(rule.triggerDrug.toLowerCase()) &&
    rule.appliesTo.some((candidate) => candidate.toLowerCase() === normalisedDrug),
  )
}
