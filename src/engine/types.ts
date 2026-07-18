/**
 * Core type contract.
 *
 * The architectural rule this file encodes: a clinical claim carries citation metadata.
 * The LLM produces only `Draft` prose; the validator turns that draft into
 * `ValidatedProse` or rejects it. There is no path from model-produced prose to the screen
 * that skips the validator.
 */

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

export type CitationKind = 'cpic' | 'fda-label' | 'fda-table' | 'pharmgkb' | 'dpwg' | 'literature'

export interface Citation {
  id: string
  /** Short badge text rendered inline, e.g. "CPIC 2023" or "FDA label §5.6" */
  label: string
  kind: CitationKind
  title: string
  url: string
  /** Label section or guideline subsection, when applicable */
  section?: string
  /** Year of publication or label revision */
  year?: string
}

/**
 * The atomic unit of anything clinical. No source, no render.
 */
export interface Claim {
  text: string
  citationIds: string[]
}

/* ------------------------------------------------------------------ */
/* PharmCAT adapter contract                                           */
/* ------------------------------------------------------------------ */

/**
 * CPIC's standardised phenotype terms. CYP2C19 uses the full eight-term set including the
 * "likely" intermediates; CYP2D6 uses UM / NM / IM / PM plus Indeterminate.
 */
export type Phenotype =
  | 'Ultrarapid Metabolizer'
  | 'Rapid Metabolizer'
  | 'Normal Metabolizer'
  | 'Likely Intermediate Metabolizer'
  | 'Intermediate Metabolizer'
  | 'Likely Poor Metabolizer'
  | 'Poor Metabolizer'
  | 'Indeterminate'

export type AssayType = 'consumer-array' | 'wgs' | 'targeted-pgx' | 'unknown'

/** Per-gene call as PharmCAT's phenotyper reports it. */
export interface GeneCall {
  gene: string
  /** MATCHER, OUTSIDE, or another value reported by PharmCAT. */
  callSource: string
  /** Per-gene allele-definition release reported by PharmCAT. */
  alleleDefinitionVersion: string | null
  /** Per-gene phenotype translation release reported by PharmCAT. */
  phenotypeVersion: string | null
  diplotype: string
  phenotype: Phenotype
  /** CYP2D6 uses an activity score; CYP2C19/CYP2B6 do not. */
  activityScore: number | null
  /** Positions PharmCAT reported as present. Null when the supplied artefact cannot prove coverage. */
  positionsCalled: number | null
  /** Positions PharmCAT expected and did NOT find. Null unless the missing-position artefact was supplied. */
  positionsMissing: number | null
  /** Human-readable identifiers of the missing positions, for the confidence panel. */
  missingPositionLabels: string[]
  /** What this build genuinely knows about assay coverage for the call. */
  coverageScope: 'pharmcat-complete' | 'report-json-only'
  /**
   * True when the assay structurally cannot resolve copy number / hybrid alleles for
   * this gene. This is the CYP2D6-from-an-array problem, and it is the single most
   * important honesty signal in the product.
   */
  structuralVariationUnresolved: boolean
}

/** A gene reviewed and deliberately excluded from any recommendation. */
export interface ExcludedGeneCall {
  gene: string
  /** What the assay found, shown greyed out. */
  observed: string
  /** Why it is not used — sourced to CPIC. */
  rationale: Claim
}

/** Versioned guideline recommendation used by the local CPIC lookup. Never rewritten by a model. */
export interface PharmCATDrugRecommendation {
  drug: string
  /** All gene results used by PharmCAT for this exact annotation, including combined rules. */
  geneResults: Array<{ gene: string; phenotype: Phenotype }>
  /** Compact compatibility label. Combined annotations are joined with " + ". */
  gene: string
  /** First phenotype for legacy consumers; use geneResults for evidence display. */
  phenotype: Phenotype
  /** Normalised action used to group and label the captured guidance. */
  action: RecommendationAction
  /** Guideline text, close to verbatim. This string is rendered as-is. */
  text: string
  /** CPIC's classification of strength of recommendation. */
  strength?: string
  /** Population label attached to the exact PharmCAT annotation. */
  population: string | null
  dosingInformation: boolean | null
  alternateDrugAvailable: boolean | null
  otherPrescribingGuidance: boolean | null
  source: 'CPIC' | 'DPWG' | 'FDA'
  citationIds: string[]
  /** Exact PharmCAT/ClinPGx annotation URL when present in the imported report. */
  sourceUrl?: string
}

/**
 * Normalised guideline actions.
 *
 * The two `standard_start_*` values exist because collapsing them into `decrease` and
 * `increase` inverts what CPIC actually says. For CYP2C19 and CYP2B6 intermediate
 * metabolisers the guideline text begins "Initiate therapy with recommended starting dose"
 * and the narrative is explicit that existing data do not support adjusting starting doses
 * for intermediate metabolisers — only titration speed and the maintenance dose change.
 * Rendering that as "reduce the dose" would tell a patient a drug is harder to start than
 * it is, which is the kind of quiet distortion that pushes people away from a workable option.
 */
export type RecommendationAction =
  | 'standard'
  | 'standard_start_reduced_maintenance'
  | 'standard_start_conditional_increase'
  | 'increase'
  | 'decrease'
  | 'decrease_start'
  | 'avoid'
  | 'alternative'
  | 'caution'
  | 'no_recommendation'

export interface PharmCATReport {
  reportId: string
  /** Which adapter produced this — surfaced in the UI provenance strip. */
  provenance: 'pharmcat-json'
  /** PharmCAT software version reported by the imported Reporter JSON. */
  pharmcatVersion: string
  /** Separate PharmCAT knowledge/data version, when present in an imported report. */
  pharmcatDataVersion?: string | null
  /** Timestamp reported by PharmCAT, when present. */
  reportTimestamp?: string | null
  assayType: AssayType
  genes: GeneCall[]
  excludedGenes: ExcludedGeneCall[]
  recommendations: PharmCATDrugRecommendation[]
}

/* ------------------------------------------------------------------ */
/* Patient input                                                       */
/* ------------------------------------------------------------------ */

export type TrialOutcome = 'no_effect' | 'side_effects' | 'helped' | 'stopped_other'

export interface PastTrial {
  drug: string
  outcome: TrialOutcome
  /** Free text the patient wrote. Never fed to a recommendation — context only. */
  note?: string
}

/* ------------------------------------------------------------------ */
/* Depression journey context                                         */
/* ------------------------------------------------------------------ */

export type PhqFrequency = 0 | 1 | 2 | 3

export interface DepressionCheckIn {
  /** Exact PHQ-9 item responses, in published item order. */
  responses: PhqFrequency[]
  functionalImpact: 'not_difficult' | 'somewhat_difficult' | 'very_difficult' | 'extremely_difficult'
}

export type CareGoal =
  | 'feel_more_like_myself'
  | 'sleep_better'
  | 'restore_energy'
  | 'think_more_clearly'
  | 'return_to_work_or_study'
  | 'reconnect_with_people'
  | 'reduce_side_effects'

export interface LifestyleContext {
  sleep: 'settled' | 'trouble_sleeping' | 'sleeping_too_much' | 'variable'
  mealRoutine: 'regular' | 'irregular' | 'variable'
  dailySchedule: 'regular' | 'shift_work' | 'variable'
  alcohol: 'none' | 'occasional' | 'regular'
  drivingOrMachinery: boolean
  missedDoses: 'rarely' | 'sometimes' | 'often'
  eatingDisorderHistory: boolean
}

export interface CareContext {
  /** Null when this validation run did not collect a PHQ-9. */
  checkIn: DepressionCheckIn | null
  goals: CareGoal[]
  lifestyle: LifestyleContext
  /** The app does not infer risk. This records the direct answer and triggers a fixed safety route. */
  needsImmediateSupport: boolean
}

export interface PatientInput {
  genomeFileName: string
  assayType: AssayType
  currentMedications: string[]
  pastTrials: PastTrial[]
  /** Optional for backwards compatibility with imported engine callers. The UI always supplies it. */
  careContext?: CareContext
}

export type DepressionSeverity = 'minimal' | 'mild' | 'moderate' | 'moderately_severe' | 'severe'

export interface DepressionSummary {
  instrument: 'PHQ-9'
  score: number
  severity: DepressionSeverity
  functionalImpact: DepressionCheckIn['functionalImpact']
  safetyResponsePositive: boolean
  interpretation: Claim
  monitoringNote: Claim
}

/* ------------------------------------------------------------------ */
/* Extension 1 — phenoconversion                                       */
/* ------------------------------------------------------------------ */

export type ModifierEffect =
  | 'strong_inhibitor'
  | 'moderate_inhibitor'
  | 'weak_inhibitor'
  | 'strong_inducer'
  | 'moderate_inducer'

export interface PhenoconversionModifier {
  /** The concurrent medication causing the shift. */
  drug: string
  enzyme: string
  effect: ModifierEffect
  /** Multiplier applied to the genetic activity score. */
  multiplier: number
  citationIds: string[]
}

/**
 * What the engine was able to conclude about the interaction between this gene and the
 * patient's current medications.
 *
 * CPIC states that consensus approaches
 * for adjusting CYP2D6, CYP2C19 or CYP2B6 predicted phenotypes in the presence of
 * inhibitors or inducers have not been established. A CYP2D6 activity-score convention is
 * retained only as an explicitly uncertain modeled estimate. For CYP2C19 and CYP2B6 there
 * is no numeric estimate. Neither path replaces the imported PharmCAT result.
 */
export type PhenoconversionStatus =
  | 'no_modifiers'
  | 'converted'
  | 'no_change'
  | 'unvalidated_method'
  | 'uncertain_extent'

export interface GenePhenotypeResult {
  gene: string
  /** Star-allele diplotype as called, e.g. "*1/*2". */
  diplotype: string
  geneticPhenotype: Phenotype
  /** Equals geneticPhenotype unless a validated adjustment method applied. */
  functionalPhenotype: Phenotype
  geneticActivityScore: number | null
  functionalActivityScore: number | null
  /** Optional estimate from a named research convention; never dosing authority. */
  modeledFunctionalPhenotype: Phenotype | null
  modeledFunctionalActivityScore: number | null
  /** True only when a validated clinical rule changed the phenotype tier. False in this build. */
  converted: boolean
  status: PhenoconversionStatus
  modifiers: PhenoconversionModifier[]
  /** Deterministic, templated sentence explaining any change. Not model-written. */
  explanation: Claim | null
  /** Raised when an interaction exists that the engine will not silently resolve. */
  unresolvedWarning: Claim | null
  confidence: GeneConfidence
}

/* ------------------------------------------------------------------ */
/* Extension 3 — confidence / coverage                                 */
/* ------------------------------------------------------------------ */

export type ConfidenceLevel = 'high' | 'moderate' | 'low'

export interface GeneConfidence {
  gene: string
  level: ConfidenceLevel
  /** Short line rendered on the gene card. */
  headline: string
  /** The specific reasons, each cited. */
  reasons: Claim[]
}

/* ------------------------------------------------------------------ */
/* Medication-specific PGx findings                                   */
/* ------------------------------------------------------------------ */

/**
 * A neutral summary of the captured PGx action. This is not a treatment ranking and must
 * never be interpreted as evidence that a medicine is clinically preferred.
 */
export type PgxReviewCategory =
  | 'usual_guidance'
  | 'dose_or_titration_review'
  | 'alternative_discussion'
  | 'no_gene_based_guidance'

export interface GeneFinding {
  /** Exact gene/phenotype combination used by the imported PharmCAT annotation. */
  geneResults: Array<{ gene: string; phenotype: Phenotype }>
  /** Compact label retained for simple renderers; use geneResults for combined rules. */
  gene: string
  phenotypeUsed: Phenotype
  /** True when the phenotype used was the phenoconverted one, not the genetic one. */
  usedFunctionalPhenotype: boolean
  action: RecommendationAction
  guidelineText: string
  strength?: string
  population: string | null
  dosingInformation: boolean | null
  alternateDrugAvailable: boolean | null
  otherPrescribingGuidance: boolean | null
  citationIds: string[]
  sourceUrl?: string
}

export interface InteractionFlag {
  withDrug: string
  severity: 'info' | 'caution' | 'critical'
  text: string
  citationIds: string[]
}

export interface DrugAssessment {
  drug: string
  drugClass: string
  /** Neutral category from the captured PGx action; never an efficacy or treatment ranking. */
  pgxCategory: PgxReviewCategory
  /** e.g. "standard dosing", "reduce starting dose", "avoid" */
  headline: string
  /** One-line gene context shown on the row. */
  reason: string
  geneFindings: GeneFinding[]
  interactionFlags: InteractionFlag[]
  /** Caveats arising from low-confidence gene calls. */
  confidenceCaveats: Claim[]
  /**
   * Context showing that a finding for one enzyme does not govern this drug's captured
   * gene–drug recommendation. This never promotes the drug.
   */
  enzymeIndependence: Claim[]
  /** Links this row to a past trial, when the patient has already tried it. */
  pastTrial: TrialReconstruction | null
  /**
   * Treatment-history context. It does not change the PGx category or infer causation.
   */
  retryRationale: Claim | null
  /** True when this is something the patient is already taking. */
  isCurrentMedication: boolean
  citationIds: string[]
}

/* ------------------------------------------------------------------ */
/* Extension 4 — treatment history reconstruction                      */
/* ------------------------------------------------------------------ */

export type TrialExplanation = 'consistent' | 'possible' | 'not_explained_by_genetics'

export interface TrialReconstruction {
  drug: string
  outcome: TrialOutcome
  /** Whether PGx raises a bounded exposure question; never a causal attribution. */
  explanation: TrialExplanation
  /** The mechanism, deterministically templated from cited facts. */
  mechanism: Claim | null
  /** Facts that support the reconstruction. */
  supporting: Claim[]
  /** Plain-language one-liner for the patient timeline. */
  patientSummary: string
}

/* ------------------------------------------------------------------ */
/* Extension 5 — lifestyle protocol                                    */
/* ------------------------------------------------------------------ */

export type ProtocolCategory = 'timing' | 'food' | 'avoid' | 'watch' | 'metabolic' | 'hydration'
export type Severity = 'info' | 'caution' | 'critical'

export interface ProtocolItem {
  id: string
  label: string
  icon: string
  category: ProtocolCategory
  severity: Severity
  /** Patient-facing instruction. */
  rule: string
  /** One sentence of mechanism. */
  why: string
  citationIds: string[]
  /** Critical items cannot be collapsed in the UI. */
  pinned: boolean
}

export interface LifestyleProtocol {
  drug: string
  items: ProtocolItem[]
  /** Items triggered by the patient's other medications rather than the drug itself. */
  interactionItems: ProtocolItem[]
}

export type DailyFitVerdict = 'supports_routine' | 'needs_planning' | 'clinician_review' | 'unknown'

export interface DailyFitFact {
  dimension: 'sleep' | 'meals' | 'schedule' | 'alcohol' | 'driving' | 'adherence' | 'medical_history'
  verdict: Exclude<DailyFitVerdict, 'unknown'>
  title: string
  detail: string
  citationIds: string[]
}

export interface DrugLifestyleMatch {
  drug: string
  verdict: DailyFitVerdict
  headline: string
  facts: DailyFitFact[]
  /** Priorities without a sufficiently specific captured label fact stay unknown. */
  unknowns: string[]
}

/* ------------------------------------------------------------------ */
/* The claim boundary — drafts, validation, rejections                 */
/* ------------------------------------------------------------------ */

export type NarrativeSection =
  | 'journey_summary'
  | 'monitoring_plan'
  | 'phenoconversion_explainer'
  | 'treatment_history'
  | 'what_next'
  | 'protocol_intro'
  | 'clinician_rationale'

/** Candidate prose from the orchestrating model, before validation. */
export interface DraftClaim {
  section: NarrativeSection
  text: string
  citationIds: string[]
}

export interface Draft {
  /** How this prose was produced. */
  generator: 'recorded-model-run' | 'live-model' | 'deterministic-template'
  model: string
  claims: DraftClaim[]
}

export type RejectionKind =
  | 'number_not_in_source'
  | 'drug_not_in_source'
  | 'citation_not_in_source'
  | 'uncited_clinical_claim'

export interface Rejection {
  section: NarrativeSection
  /** The sentence that was dropped, verbatim, so the log is auditable. */
  text: string
  kind: RejectionKind
  /** The specific token that triggered the rejection. */
  offendingToken: string
  reason: string
}

export interface ValidatedProse {
  section: NarrativeSection
  claims: Claim[]
}

export interface ValidationReport {
  generator: Draft['generator']
  model: string
  accepted: ValidatedProse[]
  rejections: Rejection[]
  /** Size of the allow-list the draft was checked against, for the trust panel. */
  allowedNumbers: string[]
  allowedDrugs: string[]
  allowedCitationIds: string[]
  claimsChecked: number
  /** Candidate report prose rejected during this run, excluding deliberate validator probes. */
  renderedRejectionCount?: number
  /** Deliberately injected test statements rejected by the validator. */
  probeRejectionCount?: number
  renderedClaimsChecked?: number
  probeClaimsChecked?: number
}

/* ------------------------------------------------------------------ */
/* Assembled result                                                    */
/* ------------------------------------------------------------------ */

export interface AnalysisResult {
  input: PatientInput
  care: CareContext
  /** Null unless the user actually supplied a complete PHQ-9 in this run. */
  depression: DepressionSummary | null
  pharmcat: PharmCATReport
  genes: GenePhenotypeResult[]
  excludedGenes: ExcludedGeneCall[]
  shortlist: DrugAssessment[]
  history: TrialReconstruction[]
  /** Protocol selected for the current detail view; selection is not a recommendation. */
  protocol: LifestyleProtocol | null
  /** Protocols keyed by drug, so the UI can switch when a different row is opened. */
  protocolsByDrug: Record<string, LifestyleProtocol>
  lifestyleMatches: Record<string, DrugLifestyleMatch>
  narrative: ValidationReport
  citations: Record<string, Citation>
  /** Pipeline steps, surfaced so the user can see what ran deterministically. */
  trace: TraceStep[]
}

export interface TraceStep {
  step: string
  detail: string
  /** 'deterministic' steps cannot involve a model. */
  kind: 'deterministic' | 'model' | 'validator'
  ms: number
}
