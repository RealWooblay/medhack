/**
 * Core type contract.
 *
 * The architectural rule this file encodes: a clinical claim is a `Claim`, and a
 * `Claim` cannot exist without at least one `citationId`. Nothing in the UI renders
 * clinical text that is not a `Claim`. The LLM produces `Draft` prose; the validator
 * turns `Draft` into `ValidatedProse` or rejects it. There is no path from model
 * output to the screen that skips the validator.
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

export type AssayType = 'consumer-array' | 'wgs' | 'targeted-pgx'

/** Per-gene call as PharmCAT's phenotyper reports it. */
export interface GeneCall {
  gene: string
  diplotype: string
  phenotype: Phenotype
  /** CYP2D6 uses an activity score; CYP2C19/CYP2B6 do not. */
  activityScore: number | null
  /** Positions PharmCAT expected and found. */
  positionsCalled: number
  /** Positions PharmCAT expected and did NOT find in the VCF. */
  positionsMissing: number
  /** Human-readable identifiers of the missing positions, for the confidence panel. */
  missingPositionLabels: string[]
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

/** Authoritative recommendation text, straight from PharmCAT. Never paraphrased by a model. */
export interface PharmCATDrugRecommendation {
  drug: string
  gene: string
  phenotype: Phenotype
  /** Normalised action our ranking layer reasons over. */
  action: RecommendationAction
  /** Guideline text, close to verbatim. This string is rendered as-is. */
  text: string
  /** CPIC's classification of strength of recommendation. */
  strength?: string
  source: 'CPIC' | 'DPWG' | 'FDA'
  citationIds: string[]
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
  provenance: 'fixture' | 'pharmcat-docker'
  pharmcatVersion: string
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

export interface PatientInput {
  genomeFileName: string
  assayType: AssayType
  currentMedications: string[]
  pastTrials: PastTrial[]
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
 * `unvalidated_method` is the honest one. CPIC states verbatim that consensus approaches
 * for adjusting CYP2D6, CYP2C19 or CYP2B6 predicted phenotypes in the presence of
 * inhibitors or inducers have not been established. That consensus DOES exist for CYP2D6
 * via the activity-score multiplier, which CPIC operationalises in its own guidelines — but
 * for CYP2C19 and CYP2B6 there is no validated method. So when a strong CYP2C19 inhibitor
 * is on board, this engine flags the interaction loudly and declines to invent a converted
 * phenotype, rather than quietly stepping the tier down and presenting a made-up number as
 * though a guideline stood behind it.
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
  /** True only when a validated method actually changed the phenotype tier. */
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
  /** 0..1, used for sorting and for down-weighting drugs that depend on a shaky call. */
  score: number
  /** Short line rendered on the gene card. */
  headline: string
  /** The specific reasons, each cited. */
  reasons: Claim[]
}

/* ------------------------------------------------------------------ */
/* Extension 2 — inverted query, ranked shortlist                      */
/* ------------------------------------------------------------------ */

export type Verdict = 'preferred' | 'caution' | 'avoid' | 'insufficient_evidence'

export interface GeneFinding {
  gene: string
  phenotypeUsed: Phenotype
  /** True when the phenotype used was the phenoconverted one, not the genetic one. */
  usedFunctionalPhenotype: boolean
  action: RecommendationAction
  guidelineText: string
  strength?: string
  citationIds: string[]
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
  /** Verdict under the patient's CURRENT functional phenotypes — the state that governs
   *  tolerability in the first weeks, which is when people stop taking things. */
  verdict: Verdict
  /** e.g. "standard dosing", "reduce starting dose", "avoid" */
  headline: string
  /** e.g. "not CYP2D6-dependent" — the one-line reason shown on the row. */
  reason: string
  geneFindings: GeneFinding[]
  interactionFlags: InteractionFlag[]
  /** Caveats arising from low-confidence gene calls. */
  confidenceCaveats: Claim[]
  /**
   * Where a compromised enzyme simply does not clear this drug. This is what lets a drug
   * rise precisely because it sidesteps the patient's problem.
   */
  enzymeIndependence: Claim[]
  /** Links this row to a past trial, when the patient has already tried it. */
  pastTrial: TrialReconstruction | null
  /**
   * Why this drug is or is not worth a second look. A drug that failed for a reason the
   * report can identify and fix is a genuinely different proposition from one that failed
   * for no reason anybody can name, and flattening both into "already tried" throws away
   * the most actionable thing pharmacogenomics has to offer.
   */
  retryRationale: Claim | null
  /** True when this is something the patient is already taking. */
  isCurrentMedication: boolean
  /**
   * Verdict once the interacting medication has washed out and the functional phenotype
   * reverts to the genetic one. Null when nothing is phenoconverted, because then there is
   * no second state to report.
   */
  postWashoutVerdict: Verdict | null
  postWashoutHeadline: string | null
  washoutNote: Claim | null
  /** Higher is better. Deterministic; see ranking.ts for the components. */
  score: number
  scoreBreakdown: ScoreComponent[]
  citationIds: string[]
}

export interface ScoreComponent {
  label: string
  delta: number
  detail: string
}

/* ------------------------------------------------------------------ */
/* Extension 4 — treatment history reconstruction                      */
/* ------------------------------------------------------------------ */

export type TrialExplanation = 'consistent' | 'possible' | 'not_explained_by_genetics'

export interface TrialReconstruction {
  drug: string
  outcome: TrialOutcome
  /** How well the metabolic picture accounts for what happened. */
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

/* ------------------------------------------------------------------ */
/* The claim boundary — drafts, validation, rejections                 */
/* ------------------------------------------------------------------ */

export type NarrativeSection =
  | 'phenoconversion_explainer'
  | 'why_trials_failed'
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
}

/* ------------------------------------------------------------------ */
/* Assembled result                                                    */
/* ------------------------------------------------------------------ */

export interface AnalysisResult {
  input: PatientInput
  pharmcat: PharmCATReport
  genes: GenePhenotypeResult[]
  excludedGenes: ExcludedGeneCall[]
  shortlist: DrugAssessment[]
  history: TrialReconstruction[]
  /** Protocol for the top-ranked drug. */
  protocol: LifestyleProtocol | null
  /** Protocols keyed by drug, so the UI can switch when a different row is opened. */
  protocolsByDrug: Record<string, LifestyleProtocol>
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
