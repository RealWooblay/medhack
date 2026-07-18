import { useMemo, useState } from 'react'
import {
  buildClinicalReviewContext,
  createClinicalReviewProvider,
  NotConnectedClinicalReviewProvider,
  type ClinicalReviewAction,
  type ClinicalReviewItem,
  type ClinicalReviewResult,
} from '../ai/clinical-review'
import { AUSTRALIAN_SCOPE_DRAFT } from '../data/australian-scope'
import { matchLifestyle } from '../engine/lifestyle-fit'
import { runAnalysis } from '../engine/pipeline'
import {
  PharmCATReportJsonAdapter,
  TagSnpAdapter,
} from '../engine/pharmcat/adapter'
import { FIXTURES, fixtureToFileText, type Fixture } from '../engine/pharmcat/fixtures'
import {
  inspectGenomeInput,
  type InputInspection,
} from '../engine/pharmcat/input-inspection'
import type {
  AnalysisResult,
  AssayType,
  CareContext,
  Citation,
  DailyFitFact,
  DrugAssessment,
  GenePhenotypeResult,
  LifestyleContext,
  LifestyleProtocol,
  RecommendationAction,
} from '../engine/types'
import {
  buildSourceUsage,
  buildValidationChecks,
  sourceIdsForGene,
} from '../validation/view-model'

type TabId = 'file' | 'genes' | 'medicines' | 'daily' | 'ai' | 'evidence'
type InputMode = 'example' | 'upload'
type RunStatus = 'idle' | 'reading' | 'running' | 'complete' | 'error'

interface RunReceipt extends InputInspection {
  source: 'fictional-example' | 'uploaded-file'
  fileName: string
  sizeBytes: number
  contents: string
  assayType: AssayType
  fixtureId?: string
}

interface RoutineAnswers {
  sleep: '' | LifestyleContext['sleep']
  mealRoutine: '' | LifestyleContext['mealRoutine']
  dailySchedule: '' | LifestyleContext['dailySchedule']
  alcohol: '' | LifestyleContext['alcohol']
  drivingOrMachinery: '' | 'yes' | 'no'
  missedDoses: '' | LifestyleContext['missedDoses']
  eatingDisorderHistory: '' | 'yes' | 'no'
}

type RoutineKey = keyof RoutineAnswers

interface RoutineQuestion {
  key: RoutineKey
  dimension: DailyFitFact['dimension']
  label: string
  options: Array<{ value: string; label: string }>
}

const EMPTY_ROUTINE: RoutineAnswers = {
  sleep: '',
  mealRoutine: '',
  dailySchedule: '',
  alcohol: '',
  drivingOrMachinery: '',
  missedDoses: '',
  eatingDisorderHistory: '',
}

const BASE_CARE_CONTEXT: CareContext = {
  checkIn: {
    responses: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    functionalImpact: 'not_difficult',
  },
  goals: [],
  lifestyle: {
    sleep: 'settled',
    mealRoutine: 'regular',
    dailySchedule: 'regular',
    alcohol: 'none',
    drivingOrMachinery: false,
    missedDoses: 'rarely',
    eatingDisorderHistory: false,
  },
  needsImmediateSupport: false,
}

const ASSAY_LABEL: Record<AssayType, string> = {
  'consumer-array': 'Consumer DNA array',
  wgs: 'Whole-genome sequencing',
  'targeted-pgx': 'Targeted PGx panel',
}

const ROUTINE_QUESTIONS: Record<RoutineKey, RoutineQuestion> = {
  mealRoutine: {
    key: 'mealRoutine',
    dimension: 'meals',
    label: 'Meals',
    options: [
      { value: 'regular', label: 'Usually regular' },
      { value: 'irregular', label: 'Often irregular' },
      { value: 'variable', label: 'Changes day to day' },
    ],
  },
  dailySchedule: {
    key: 'dailySchedule',
    dimension: 'schedule',
    label: 'Usual dose time',
    options: [
      { value: 'regular', label: 'A regular time is practical' },
      { value: 'shift_work', label: 'I work changing shifts' },
      { value: 'variable', label: 'My schedule varies' },
    ],
  },
  alcohol: {
    key: 'alcohol',
    dimension: 'alcohol',
    label: 'Alcohol',
    options: [
      { value: 'none', label: 'None' },
      { value: 'occasional', label: 'Sometimes' },
      { value: 'regular', label: 'Regularly' },
    ],
  },
  drivingOrMachinery: {
    key: 'drivingOrMachinery',
    dimension: 'driving',
    label: 'Driving or machinery',
    options: [
      { value: 'no', label: 'Not usually' },
      { value: 'yes', label: 'Yes' },
    ],
  },
  missedDoses: {
    key: 'missedDoses',
    dimension: 'adherence',
    label: 'Missed doses',
    options: [
      { value: 'rarely', label: 'Rarely' },
      { value: 'sometimes', label: 'Sometimes' },
      { value: 'often', label: 'Often' },
    ],
  },
  sleep: {
    key: 'sleep',
    dimension: 'sleep',
    label: 'Sleep now',
    options: [
      { value: 'settled', label: 'Mostly settled' },
      { value: 'trouble_sleeping', label: 'Trouble sleeping' },
      { value: 'sleeping_too_much', label: 'Sleeping too much' },
      { value: 'variable', label: 'Very variable' },
    ],
  },
  eatingDisorderHistory: {
    key: 'eatingDisorderHistory',
    dimension: 'medical_history',
    label: 'Current or past anorexia or bulimia',
    options: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
  },
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function parseMedicines(value: string): string[] {
  return unique(
    value
      .split(',')
      .map((medicine) => medicine.trim().toLowerCase())
      .filter(Boolean),
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function phenotypeWords(phenotype: GenePhenotypeResult['functionalPhenotype']): string {
  switch (phenotype) {
    case 'Ultrarapid Metabolizer': return 'much faster than usual'
    case 'Rapid Metabolizer': return 'faster than usual'
    case 'Normal Metabolizer': return 'in the usual range'
    case 'Likely Intermediate Metabolizer':
    case 'Intermediate Metabolizer': return 'slower than usual'
    case 'Likely Poor Metabolizer':
    case 'Poor Metabolizer': return 'much slower than usual'
    case 'Indeterminate': return 'not enough data'
  }
}

function speedTitle(phenotype: GenePhenotypeResult['functionalPhenotype']): string {
  const words = phenotypeWords(phenotype)
  return words === 'in the usual range' ? 'Usual range' : capitalise(words)
}

function actionLabel(action: RecommendationAction): string {
  switch (action) {
    case 'avoid':
    case 'alternative': return 'Discuss another medicine'
    case 'decrease_start': return 'Discuss a lower starting dose and slower dose changes'
    case 'decrease': return 'Discuss a dose reduction'
    case 'increase': return 'Review the dose if response is inadequate'
    case 'caution': return 'Extra prescriber review'
    case 'standard_start_reduced_maintenance': return 'Usual start; review later dose changes'
    case 'standard_start_conditional_increase': return 'Usual start; review if response is inadequate'
    case 'standard': return 'Usual gene-based starting guidance'
    case 'no_recommendation': return 'No gene rule available'
  }
}

function originLabel(result: AnalysisResult): string {
  switch (result.pharmcat.provenance) {
    case 'pharmcat-json': return 'Imported PharmCAT report'
    case 'pharmcat-docker': return 'PharmCAT pipeline'
    case 'fixture': return 'Fictional fixture'
    case 'reduced-tagsnp': return 'Six-marker teaching caller — not PharmCAT'
  }
}

function sourcePublisher(citation: Citation): string {
  switch (citation.kind) {
    case 'cpic': return 'CPIC'
    case 'fda-label': return 'US FDA / cached openFDA record'
    case 'fda-table': return 'US FDA'
    case 'pharmgkb': return 'PharmGKB / PharmVar'
    case 'dpwg': return 'DPWG'
    default: return 'Published evidence'
  }
}

function listWords(values: string[], maximum = 4): string {
  const shown = values.slice(0, maximum).map(capitalise)
  const remaining = values.length - shown.length
  if (remaining > 0) return `${shown.join(', ')} and ${remaining} more`
  if (shown.length <= 1) return shown[0] ?? 'no medicines in this build'
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

function SourceLinks({ ids, result, idsOnly = false }: { ids: string[]; result: AnalysisResult; idsOnly?: boolean }) {
  const citations = unique(ids).map((id) => result.citations[id]).filter(Boolean)
  if (!citations.length) return <span className="muted">No source recorded</span>
  return (
    <span className="source-links">
      {citations.map((citation) => (
        <a key={citation.id} href={citation.url} target="_blank" rel="noreferrer">
          {idsOnly ? citation.id : citation.label}
        </a>
      ))}
    </span>
  )
}

function careFromRoutine(routine: RoutineAnswers): CareContext {
  return {
    ...BASE_CARE_CONTEXT,
    lifestyle: {
      sleep: routine.sleep || 'settled',
      mealRoutine: routine.mealRoutine || 'regular',
      dailySchedule: routine.dailySchedule || 'regular',
      alcohol: routine.alcohol || 'none',
      drivingOrMachinery: routine.drivingOrMachinery === 'yes',
      missedDoses: routine.missedDoses || 'rarely',
      eatingDisorderHistory: routine.eatingDisorderHistory === 'yes',
    },
  }
}

function confirmedLifestyleFromRoutine(routine: RoutineAnswers): Partial<LifestyleContext> {
  const confirmed: Partial<LifestyleContext> = {}
  if (routine.sleep) confirmed.sleep = routine.sleep
  if (routine.mealRoutine) confirmed.mealRoutine = routine.mealRoutine
  if (routine.dailySchedule) confirmed.dailySchedule = routine.dailySchedule
  if (routine.alcohol) confirmed.alcohol = routine.alcohol
  if (routine.drivingOrMachinery) confirmed.drivingOrMachinery = routine.drivingOrMachinery === 'yes'
  if (routine.missedDoses) confirmed.missedDoses = routine.missedDoses
  if (routine.eatingDisorderHistory) confirmed.eatingDisorderHistory = routine.eatingDisorderHistory === 'yes'
  return confirmed
}

function relevantRoutineQuestions(protocol: LifestyleProtocol): RoutineQuestion[] {
  const items = [...protocol.items, ...protocol.interactionItems]
  const ids = new Set(items.map((item) => item.id))
  const questions: RoutineQuestion[] = []

  if (items.some((item) => item.category === 'food')) questions.push(ROUTINE_QUESTIONS.mealRoutine)
  if (items.some((item) => item.category === 'timing')) questions.push(ROUTINE_QUESTIONS.dailySchedule)
  if ([...ids].some((id) => id.includes('alcohol'))) questions.push(ROUTINE_QUESTIONS.alcohol)
  if ([...ids].some((id) => id.includes('driving'))) questions.push(ROUTINE_QUESTIONS.drivingOrMachinery)
  if ([...ids].some((id) => id.includes('somnolence'))) questions.push(ROUTINE_QUESTIONS.sleep)
  if (ids.has('bupropion-eating-disorder')) questions.push(ROUTINE_QUESTIONS.eatingDisorderHistory)

  questions.push(ROUTINE_QUESTIONS.missedDoses)
  return questions
}

function fixturePurpose(fixture: Fixture): string {
  switch (fixture.id) {
    case 'demo-phenoconversion': return 'Shows how a current medicine can change functional metabolism.'
    case 'demo-ultrarapid': return 'Shows a faster-than-usual CYP2C19 result.'
    case 'demo-poor-metaboliser': return 'Shows a much-slower CYP2D6 result.'
    default: return 'Shows the full validation flow with fictional data.'
  }
}

function FilePanel({
  mode,
  onMode,
  fixture,
  onFixture,
  medicines,
  onMedicines,
  assayType,
  onAssayType,
  uploadedFile,
  inspection,
  status,
  error,
  onFile,
  onRun,
}: {
  mode: InputMode
  onMode: (mode: InputMode) => void
  fixture: Fixture
  onFixture: (fixture: Fixture) => void
  medicines: string
  onMedicines: (value: string) => void
  assayType: '' | AssayType
  onAssayType: (value: '' | AssayType) => void
  uploadedFile: { name: string; size: number; contents: string } | null
  inspection: InputInspection | null
  status: RunStatus
  error: string | null
  onFile: (file: File) => void
  onRun: () => void
}) {
  const ready = mode === 'example' || Boolean(uploadedFile && inspection && inspection.status !== 'blocked' && assayType)

  return (
    <section className="screen" aria-labelledby="file-title">
      <div className="screen-heading">
        <h1 id="file-title">Add DNA results</h1>
        <p>Try the example or upload a supported result. Raw DNA stays on this device and never goes to the medical AI.</p>
      </div>

      <div className="choice-grid" role="group" aria-label="Choose input type">
        <button type="button" className={`choice ${mode === 'example' ? 'choice--selected' : ''}`} aria-pressed={mode === 'example'} onClick={() => onMode('example')}>
          <span className="choice-letter">A</span>
          <span><strong>Try the example</strong><small>Fictional data showing the complete flow</small></span>
        </button>
        <button type="button" className={`choice ${mode === 'upload' ? 'choice--selected' : ''}`} aria-pressed={mode === 'upload'} onClick={() => onMode('upload')}>
          <span className="choice-letter">B</span>
          <span><strong>Upload a file</strong><small>VCF, consumer DNA text or PharmCAT result</small></span>
        </button>
      </div>

      <div className="input-card">
        {mode === 'example' ? (
          <>
            <label className="field">
              <span>Fictional example</span>
              <select value={fixture.id} onChange={(event) => onFixture(FIXTURES.find((item) => item.id === event.target.value) ?? FIXTURES[0])}>
                {FIXTURES.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            <div className="compact-note"><strong>Fictional · 6 markers</strong><span>{fixturePurpose(fixture)}</span></div>
          </>
        ) : (
          <>
            <label className="upload-box">
              <input
                type="file"
                accept=".json,.vcf,.txt,.csv,.tsv"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) onFile(file)
                }}
              />
              <span className="upload-symbol">↑</span>
              <strong>{status === 'reading' ? 'Reading file…' : 'Choose a DNA or PharmCAT file'}</strong>
              <small>JSON, VCF, TXT, CSV or TSV</small>
            </label>

            {uploadedFile && inspection && (
              <div className={`file-ready ${inspection.status === 'blocked' ? 'file-ready--blocked' : ''}`}>
                <div><strong>{inspection.status === 'blocked' ? 'Stopped' : `Ready: ${uploadedFile.name}`}</strong><span>{inspection.formatLabel} · {inspection.recognizedVariantCount} relevant marker(s) found</span></div>
                <small>{formatBytes(uploadedFile.size)}</small>
              </div>
            )}

            {inspection?.warnings[0] && (
              <div className="plain-warning"><strong>{inspection.status === 'blocked' ? 'This file cannot be calculated safely.' : 'This input has limits.'}</strong><span>{inspection.warnings[0]}</span></div>
            )}

            <label className="field">
              <span>What kind of test is this? <em>Choose from the test report</em></span>
              <select value={assayType} onChange={(event) => onAssayType(event.target.value as '' | AssayType)}>
                <option value="">Choose one</option>
                <option value="consumer-array">Consumer DNA array</option>
                <option value="targeted-pgx">Targeted PGx panel</option>
                <option value="wgs">Whole-genome sequencing</option>
              </select>
            </label>
          </>
        )}

        <label className="field">
          <span>Medicines taken now <em>Optional · separate with commas</em></span>
          <input value={medicines} onChange={(event) => onMedicines(event.target.value)} placeholder="For example: fluoxetine, bupropion" />
          <small>Some medicines can temporarily change how a metabolism gene functions.</small>
        </label>

        {error && <div className="error-message" role="alert"><strong>Stopped</strong><span>{error}</span></div>}

        <div className="action-row">
          <button type="button" className="primary-button" disabled={!ready || status === 'running' || status === 'reading'} onClick={onRun}>
            {status === 'running' ? 'Reading…' : 'Read gene results'}
          </button>
          <span>This does not choose a medicine.</span>
        </div>
      </div>
    </section>
  )
}

function GenesPanel({ result, onNext }: { result: AnalysisResult; onNext: () => void }) {
  const limitedMethod = result.pharmcat.provenance === 'reduced-tagsnp' || result.pharmcat.provenance === 'fixture'

  return (
    <section className="screen" aria-labelledby="genes-title">
      <div className="screen-heading">
        <h1 id="genes-title">How your body may process medicines</h1>
        <p>These results describe medicine metabolism. They do not describe depression or predict recovery.</p>
      </div>

      {limitedMethod && (
        <div className="shared-limit">
          <strong>Demo-data limit</strong>
          <span>This preview checks 6 markers, not the full genes. All {result.genes.length} results below share this one limit.</span>
        </div>
      )}

      {result.pharmcat.provenance === 'pharmcat-json' && (
        <div className="shared-limit"><strong>Imported result</strong><span>Coverage stays unknown unless the matching PharmCAT missing-position record is supplied.</span></div>
      )}

      <div className="gene-list">
        {result.genes.map((gene) => {
          const raw = result.pharmcat.genes.find((item) => item.gene === gene.gene)
          const relevantDrugs = result.shortlist
            .filter((drug) => drug.geneFindings.some((finding) => finding.gene === gene.gene))
            .map((drug) => drug.drug)
          const modifierNames = unique(gene.modifiers.map((modifier) => modifier.drug)).map(capitalise)

          return (
            <article className="gene-row" key={gene.gene}>
              <div className="gene-result">
                <strong>{speedTitle(gene.functionalPhenotype)}</strong>
                <span>{gene.gene}</span>
              </div>
              <div className="gene-meaning">
                {gene.converted ? (
                  <>
                    <strong>Current medicine changes this result</strong>
                    <p>Genes suggest {phenotypeWords(gene.geneticPhenotype)} activity. {listWords(modifierNames)} may make this enzyme work {phenotypeWords(gene.functionalPhenotype)} while taken.</p>
                  </>
                ) : gene.status === 'unvalidated_method' ? (
                  <>
                    <strong>A current-medicine effect is unresolved</strong>
                    <p>The gene result is {phenotypeWords(gene.functionalPhenotype)}. This app cannot safely calculate how much the recorded medicine changes it.</p>
                  </>
                ) : (
                  <p>This enzyme works {phenotypeWords(gene.functionalPhenotype)} for medicines it processes.</p>
                )}
                <small>Used in guidance here for {listWords(relevantDrugs)}.</small>
              </div>
              <details className="science-details">
                <summary>Science details</summary>
                <dl className="technical-list">
                  <div><dt>Processing phenotype</dt><dd>{gene.functionalPhenotype}</dd></div>
                  <div><dt>Two gene versions</dt><dd>{gene.diplotype}</dd></div>
                  <div><dt>Activity score</dt><dd>{gene.functionalActivityScore ?? 'Not defined'}</dd></div>
                  <div><dt>Coverage</dt><dd>{raw?.coverageScope ?? 'Not supplied'}; {raw?.positionsCalled ?? 'unknown'} called, {raw?.positionsMissing ?? 'unknown'} missing</dd></div>
                  <div><dt>Source</dt><dd><SourceLinks ids={sourceIdsForGene(gene)} result={result} /></dd></div>
                </dl>
              </details>
            </article>
          )
        })}
      </div>

      <div className="page-action"><button type="button" className="primary-button" onClick={onNext}>See medicine guidance</button></div>
    </section>
  )
}

function medicineSummary(drug: DrugAssessment): string {
  const finding = drug.geneFindings[0]
  if (!finding) return 'This is not a finding that the medicine is safe or suitable.'
  if (drug.pgxCategory === 'usual_guidance') {
    return finding.action === 'standard'
      ? 'This result does not change the captured gene-based starting guidance.'
      : `${actionLabel(finding.action)}. The rule uses ${finding.gene}, which is ${phenotypeWords(finding.phenotypeUsed)}.`
  }
  return `${actionLabel(finding.action)}. The rule uses ${finding.gene}, which is ${phenotypeWords(finding.phenotypeUsed)}.`
}

function MedicineRow({ drug, result, onExplore }: { drug: DrugAssessment; result: AnalysisResult; onExplore: (drug: string) => void }) {
  return (
    <article className="medicine-row">
      <div className="medicine-copy">
        <h3>{capitalise(drug.drug)}</h3>
        <p>{medicineSummary(drug)}</p>
        {drug.interactionFlags.length > 0 && <span className="inline-alert">A current medicine adds an interaction question.</span>}
      </div>
      <button type="button" className="row-button" onClick={() => onExplore(drug.drug)}>Explore daily life</button>
      {drug.geneFindings.length > 0 && (
        <details className="rule-details">
          <summary>Why this appears</summary>
          {drug.geneFindings.map((finding) => (
            <div className="guideline-block" key={`${finding.gene}-${finding.phenotypeUsed}`}>
              <strong>{finding.gene} · {finding.phenotypeUsed}</strong>
              <p>{finding.guidelineText}</p>
              <SourceLinks ids={finding.citationIds} result={result} idsOnly />
            </div>
          ))}
          {drug.interactionFlags.map((flag) => (
            <div className="guideline-block" key={`${flag.withDrug}-${flag.text}`}>
              <strong>Interaction with {capitalise(flag.withDrug)}</strong>
              <p>{flag.text}</p>
              <SourceLinks ids={flag.citationIds} result={result} idsOnly />
            </div>
          ))}
        </details>
      )}
    </article>
  )
}

function MedicineGroup({ title, description, drugs, result, onExplore }: {
  title: string
  description: string
  drugs: DrugAssessment[]
  result: AnalysisResult
  onExplore: (drug: string) => void
}) {
  if (!drugs.length) return null
  return (
    <section className="medicine-group">
      <div className="group-heading"><h2>{title}</h2><span>{description}</span></div>
      <div className="medicine-list">{drugs.map((drug) => <MedicineRow key={drug.drug} drug={drug} result={result} onExplore={onExplore} />)}</div>
    </section>
  )
}

function MedicinesPanel({ result, onExplore }: { result: AnalysisResult; onExplore: (drug: string) => void }) {
  const alternatives = result.shortlist.filter((drug) => drug.pgxCategory === 'alternative_discussion')
  const doseReview = result.shortlist.filter((drug) => drug.pgxCategory === 'dose_or_titration_review')
  const usual = result.shortlist.filter((drug) => drug.pgxCategory === 'usual_guidance')
  const noRule = result.shortlist.filter((drug) => drug.pgxCategory === 'no_gene_based_guidance')

  return (
    <section className="screen" aria-labelledby="medicines-title">
      <div className="screen-heading">
        <h1 id="medicines-title">What to discuss with the prescriber</h1>
        <p>These rules can change dose guidance. They cannot predict which antidepressant will work.</p>
      </div>

      <MedicineGroup title="Ask about another option" description="The captured gene rule raises an alternative-medicine question." drugs={alternatives} result={result} onExplore={onExplore} />
      <MedicineGroup title="Dose needs discussion" description="Starting dose or later dose changes need review." drugs={doseReview} result={result} onExplore={onExplore} />
      <MedicineGroup title="Usual start; later plan may change" description="Some rules still change later dose or follow-up planning." drugs={usual} result={result} onExplore={onExplore} />

      {noRule.length > 0 && (
        <details className="no-rule-group">
          <summary>No gene rule available for {noRule.length} medicine{noRule.length === 1 ? '' : 's'}</summary>
          <p>No rule is not evidence that a medicine is safe or suitable.</p>
          <div className="medicine-list">{noRule.map((drug) => <MedicineRow key={drug.drug} drug={drug} result={result} onExplore={onExplore} />)}</div>
        </details>
      )}

      <div className="single-source"><strong>Rule source</strong><span>Captured CPIC prescribing guidelines · exact text and versions are in Evidence.</span></div>
    </section>
  )
}

function routineFitStatus(question: RoutineQuestion, routine: RoutineAnswers, facts: DailyFitFact[]): { label: 'Fits' | 'Needs a plan' | 'Answer needed'; detail: string } {
  const answer = routine[question.key]
  if (!answer) return { label: 'Answer needed', detail: `Answer ${question.label.toLowerCase()} to run this match.` }

  const fact = facts.find((item) => item.dimension === question.dimension)
  if (fact) {
    return fact.verdict === 'supports_routine'
      ? { label: 'Fits', detail: fact.title }
      : { label: 'Needs a plan', detail: fact.title }
  }

  if (question.key === 'missedDoses' && answer !== 'rarely') {
    return { label: 'Needs a plan', detail: 'Ask for a practical missed-dose and reminder plan.' }
  }
  if (question.key === 'sleep' && answer !== 'settled') {
    return { label: 'Needs a plan', detail: 'The current evidence cannot compare medicines by sleep effect.' }
  }

  return { label: 'Fits', detail: 'No conflict with the captured instruction was found.' }
}

function DailyLifePanel({
  result,
  selectedDrug,
  onSelectedDrug,
  routine,
  onRoutine,
  onNext,
}: {
  result: AnalysisResult
  selectedDrug: string
  onSelectedDrug: (drug: string) => void
  routine: RoutineAnswers
  onRoutine: (routine: RoutineAnswers) => void
  onNext: () => void
}) {
  const protocol = selectedDrug ? result.protocolsByDrug[selectedDrug] : null
  const questions = protocol ? relevantRoutineQuestions(protocol) : []
  const match = protocol ? matchLifestyle(protocol, careFromRoutine(routine)) : null
  const protocolItems = protocol ? [...protocol.items, ...protocol.interactionItems] : []
  const sourceIds = unique(protocolItems.flatMap((item) => item.citationIds))

  return (
    <section className="screen" aria-labelledby="daily-title">
      <div className="screen-heading">
        <h1 id="daily-title">{selectedDrug ? `Living with ${capitalise(selectedDrug)}` : 'Daily life with a medicine'}</h1>
        <p>Drug-specific label facts matched to your routine. Nothing generic.</p>
      </div>

      <label className="field medicine-picker">
        <span>Medicine being discussed <em>This is not a recommendation</em></span>
        <select value={selectedDrug} onChange={(event) => onSelectedDrug(event.target.value)}>
          <option value="">Choose a medicine</option>
          {result.shortlist.map((drug) => <option key={drug.drug} value={drug.drug}>{capitalise(drug.drug)}</option>)}
        </select>
      </label>

      {!protocol && <div className="empty-state"><strong>Choose a medicine</strong><span>Its own instructions and only the routine questions they require will appear here.</span></div>}

      {protocol && (
        <>
          <div className="daily-columns">
            <section className="panel-card">
              <div className="panel-heading"><h2>Daily instructions</h2><span>Captured for this medicine</span></div>
              {protocolItems.length ? (
                <div className="instruction-list">
                  {protocolItems.map((item) => (
                    <article key={item.id}>
                      <span>{item.label}</span>
                      <strong>{item.rule}</strong>
                      <details><summary>Why</summary><p>{item.why}</p></details>
                    </article>
                  ))}
                </div>
              ) : <p className="empty-copy">No drug-specific daily rule is captured. This does not mean there are no instructions or risks.</p>}
            </section>

            <section className="panel-card">
              <div className="panel-heading"><h2>Your routine</h2><span>Only fields used by this check</span></div>
              <div className="routine-grid">
                {questions.map((question) => (
                  <label className="compact-field" key={question.key}>
                    <span>{question.label}</span>
                    <select value={routine[question.key]} onChange={(event) => onRoutine({ ...routine, [question.key]: event.target.value })}>
                      <option value="">Choose</option>
                      {question.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </section>
          </div>

          <section className="fit-panel">
            <div className="panel-heading"><h2>Fit with your routine</h2><span>Compatibility with captured instructions, not a safety score</span></div>
            <div className="fit-list">
              {questions.map((question) => {
                const status = routineFitStatus(question, routine, match?.facts ?? [])
                return (
                  <div className="fit-row" key={question.key}>
                    <strong>{question.label}</strong>
                    <span className={`fit-status fit-status--${status.label.toLowerCase().replaceAll(' ', '-')}`}>{status.label}</span>
                    <small>{status.detail}</small>
                  </div>
                )
              })}
            </div>
          </section>

          <div className="single-source"><strong>Source: US FDA label snapshot</strong><span><SourceLinks ids={sourceIds} result={result} /> · Australian product information is not loaded yet.</span></div>
          <div className="page-action"><button type="button" className="primary-button" onClick={onNext}>Open medical AI review</button></div>
        </>
      )}
    </section>
  )
}

const REVIEW_ACTION_LABEL: Record<ClinicalReviewAction, string> = {
  evidence_gap: 'Missing information',
  input_conflict: 'Facts to reconcile',
  clinician_question: 'Question for the prescriber',
  lifestyle_constraint: 'Daily-life constraint',
  request_counterfactual: 'Scenario to re-run',
}

function counterfactualText(item: ClinicalReviewItem): string {
  const request = item.rerunRequest
  if (!request) return 'Re-run the full deterministic system before answering this scenario.'
  switch (request.operation) {
    case 'add_current_medication': return `Re-run with ${capitalise(request.drug)} added as a current medicine.`
    case 'remove_current_medication': return `Re-run without ${capitalise(request.drug)} in the current-medicine list.`
    case 'select_lifestyle_drug': return `Re-run the daily-life match for ${capitalise(request.drug)}.`
    case 'set_lifestyle_context': return `Re-run after confirming ${request.dimension.replaceAll(/([A-Z])/g, ' $1').toLowerCase()} as ${String(request.value).replaceAll('_', ' ')}.`
  }
}

function canonicalReviewText(item: ClinicalReviewItem): string {
  switch (item.action) {
    case 'evidence_gap': return 'What additional verified information is needed before these facts are interpreted?'
    case 'input_conflict': return 'Which input or source needs clarification before these facts are used together?'
    case 'clinician_question': return `How should the verified facts below be considered${item.drugNames.length ? ` for ${listWords(item.drugNames)}` : ''}?`
    case 'lifestyle_constraint': return 'How can the sourced daily instruction and the confirmed routine be planned together?'
    case 'request_counterfactual': return counterfactualText(item)
  }
}

function AiReviewPanel({
  result,
  selectedDrug,
  routine,
  review,
  onReview,
}: {
  result: AnalysisResult
  selectedDrug: string
  routine: RoutineAnswers
  review: ClinicalReviewResult | null
  onReview: (review: ClinicalReviewResult | null) => void
}) {
  const [running, setRunning] = useState(false)
  const providerState = useMemo(() => {
    try {
      return { provider: createClinicalReviewProvider(), configurationError: null as string | null }
    } catch (caught) {
      return {
        provider: new NotConnectedClinicalReviewProvider(),
        configurationError: caught instanceof Error ? caught.message : 'The model endpoint configuration is invalid.',
      }
    }
  }, [])
  const confirmedLifestyle = useMemo(() => confirmedLifestyleFromRoutine(routine), [routine])
  const context = useMemo(
    () => buildClinicalReviewContext(result, { selectedDrug, confirmedLifestyle, includeSymptomContext: false }),
    [confirmedLifestyle, result, selectedDrug],
  )
  const factsById = useMemo(() => new Map(context.facts.map((fact) => [fact.id, fact])), [context])
  const connected = providerState.provider.mode === 'ai'
  const answers = Object.keys(confirmedLifestyle).length

  const runReview = async () => {
    setRunning(true)
    onReview(null)
    const nextReview = await providerState.provider.review(result, {
      selectedDrug,
      confirmedLifestyle,
      includeSymptomContext: false,
    })
    onReview(nextReview)
    setRunning(false)
  }

  return (
    <section className="screen" aria-labelledby="ai-title">
      <div className="screen-heading">
        <h1 id="ai-title">Medical AI review</h1>
        <p>The model coordinates verified gene, medicine, interaction and routine facts. It is not a chatbot and it cannot create a clinical rule.</p>
      </div>

      <div className={`model-status ${connected ? 'model-status--connected' : ''}`}>
        <span className="status-dot" aria-hidden="true" />
        <div><strong>{connected ? 'MedGemma endpoint connected' : 'Medical AI is not connected'}</strong><span>{connected ? 'Ready for a governed, structured review.' : 'No AI result has been created. Gene, medicine and daily-life checks still work without it.'}</span></div>
      </div>

      <div className="review-inputs">
        <strong>Review input</strong>
        <span>{result.genes.length} gene results</span>
        <span>{result.input.currentMedications.length} current medicine{result.input.currentMedications.length === 1 ? '' : 's'}</span>
        <span>{selectedDrug ? capitalise(selectedDrug) : 'No medicine selected'}</span>
        <span>{answers} confirmed routine answer{answers === 1 ? '' : 's'}</span>
      </div>

      {!review && (
        <>
          <div className="ai-jobs">
            <article><strong>Find what is missing</strong><span>Select the next relevant question from the verified context.</span></article>
            <article><strong>Coordinate constraints</strong><span>Connect gene, current-medicine, label and confirmed routine facts.</span></article>
            <article><strong>Re-run “what if?”</strong><span>Request a typed scenario; deterministic code must calculate it again.</span></article>
            <article><strong>Prepare follow-up</strong><span>Later, organise recorded symptoms, side effects, adherence and clinician decisions.</span></article>
          </div>

          <section className="ai-contract">
            <div><strong>Model may return</strong><span>Approved actions, fact IDs, source IDs, missing-data flags and typed scenario requests.</span></div>
            <div><strong>Model cannot return</strong><span>A gene call, dose, drug ranking, diagnosis, treatment instruction or invented fact.</span></div>
          </section>
        </>
      )}

      {connected && !review && (
        <div className="ai-ready">
          <strong>Structured review connection found</strong>
          <span>Only derived and confirmed facts are sent. Raw DNA, filenames, diplotypes, direct identifiers and unconfirmed routine defaults are excluded.</span>
          <button type="button" className="primary-button" disabled={running} onClick={() => void runReview()}>{running ? 'Reviewing…' : 'Run medical AI review'}</button>
        </div>
      )}

      {!connected && (
        <div className="connection-help">
          <strong>{providerState.configurationError ? 'Endpoint configuration stopped safely' : 'To validate the live model'}</strong>
          <span>{providerState.configurationError ?? <>Connect a governed same-origin endpoint with <code>VITE_MEDGEMMA_ENDPOINT</code>. No browser API key is supported.</>}</span>
        </div>
      )}

      {review && review.status === 'complete' && (
        <section className="review-output" aria-label="Validated AI review">
          <div className="review-output__heading">
            <div><h2>Validated review</h2><p>MedGemma selected relationships; the app renders fixed wording and the cited facts.</p></div>
            <button type="button" className="secondary-button" onClick={() => void runReview()}>Run again</button>
          </div>
          <div className="review-items">
            {review.items.map((item, index) => (
              <article className="review-item" key={`${item.action}-${index}`}>
                <span>{REVIEW_ACTION_LABEL[item.action]}</span>
                <strong>{canonicalReviewText(item)}</strong>
                <details>
                  <summary>Proof · {item.factIds.length} fact{item.factIds.length === 1 ? '' : 's'}</summary>
                  <ul>{item.factIds.map((id) => <li key={id}><code>{id}</code><span>{factsById.get(id)?.text ?? 'Fact not found in the current review context.'}</span></li>)}</ul>
                  {item.sourceIds.length > 0 && <p>Sources: {item.sourceIds.join(', ')}</p>}
                </details>
              </article>
            ))}
          </div>
          <div className="review-audit"><strong>{review.provider}</strong><span>{review.items.length} accepted · {review.rejections.length} rejected · raw model wording retained only for audit</span></div>
          {review.rejections.length > 0 && (
            <details className="rejection-log"><summary>See rejected model output</summary><ul>{review.rejections.map((item, index) => <li key={`${item.kind}-${index}`}><strong>{item.kind}</strong><span>{item.reason}</span></li>)}</ul></details>
          )}
        </section>
      )}

      {review && review.status !== 'complete' && (
        <div className="review-stopped" role="alert">
          <strong>{review.status === 'rejected' ? 'Model output rejected' : review.status === 'error' ? 'Model review failed' : 'Model not connected'}</strong>
          <span>{review.message}</span>
          {connected && <button type="button" className="secondary-button" onClick={() => void runReview()}>Try again</button>}
        </div>
      )}
    </section>
  )
}

function EvidencePanel({ result, receipt, selectedDrug, routine, review }: {
  result: AnalysisResult
  receipt: RunReceipt
  selectedDrug: string
  routine: RoutineAnswers
  review: ClinicalReviewResult | null
}) {
  const checks = buildValidationChecks(result)
  const sources = buildSourceUsage(result)
  const selectedProtocol = selectedDrug ? result.protocolsByDrug[selectedDrug] : null
  const endpointConnected = Boolean(import.meta.env.VITE_MEDGEMMA_ENDPOINT?.trim())
  const rawFilePreview = receipt.contents.length > 12_000
    ? `${receipt.contents.slice(0, 12_000)}\n\n[Preview stopped at 12,000 characters]`
    : receipt.contents
  const rawResult = JSON.stringify(result, null, 2)
  const rawResultPreview = rawResult.length > 30_000
    ? `${rawResult.slice(0, 30_000)}\n\n[Preview stopped at 30,000 characters]`
    : rawResult

  const downloadBundle = () => {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      input: {
        fileName: receipt.fileName,
        sha256: receipt.sha256,
        detectedFormat: receipt.kind,
        assayType: receipt.assayType,
        currentMedications: result.input.currentMedications,
      },
      selectedDrug: selectedDrug || null,
      confirmedRoutineAnswers: routine,
      ai: {
        endpointConfigured: endpointConnected,
        review,
        rawGenomeSent: false,
      },
      result,
    }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `pgx-validation-${receipt.sha256.slice(0, 8)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="screen" aria-labelledby="evidence-title">
      <div className="screen-heading">
        <h1 id="evidence-title">Proof</h1>
        <p>Every visible conclusion links to the input, rule and model statement that produced it.</p>
      </div>

      <div className="evidence-summary">
        <div><span>File</span><strong>{receipt.fileName}</strong></div>
        <div><span>Gene method</span><strong>{originLabel(result)}</strong></div>
        <div><span>Medicine rules</span><strong>Versioned local CPIC lookup</strong></div>
        <div><span>Medical AI</span><strong>{review ? `${review.status} · ${review.items.length} accepted` : endpointConnected ? 'Connected · not run' : 'Not connected'}</strong></div>
      </div>

      <div className="evidence-groups">
        <details className="evidence-group">
          <summary><span>1</span><strong>Input file</strong><small>Format, hash and transformations</small></summary>
          <dl className="evidence-list">
            <div><dt>Data origin</dt><dd>{receipt.source === 'fictional-example' ? 'Fictional example' : 'Uploaded file'}</dd></div>
            <div><dt>File</dt><dd>{receipt.fileName} · {formatBytes(receipt.sizeBytes)}</dd></div>
            <div><dt>SHA-256</dt><dd><code>{receipt.sha256}</code></dd></div>
            <div><dt>Detected format</dt><dd>{receipt.formatLabel}</dd></div>
            <div><dt>Genome build</dt><dd>{receipt.genomeBuild ?? 'Not proven'}</dd></div>
            <div><dt>Test type</dt><dd>{ASSAY_LABEL[receipt.assayType]} · selected or fixture-declared, not independently verified</dd></div>
            <div><dt>Supported sites seen</dt><dd>{receipt.recognizedVariantCount}</dd></div>
            <div><dt>Blocking code</dt><dd>{receipt.blockingCode ?? 'None'}</dd></div>
            <div><dt>Transformations</dt><dd>{receipt.transformations.length ? receipt.transformations.join(' · ') : 'None'}</dd></div>
            <div><dt>Warnings</dt><dd>{receipt.warnings.length ? receipt.warnings.join(' · ') : 'None recorded'}</dd></div>
          </dl>
        </details>

        <details className="evidence-group">
          <summary><span>2</span><strong>Gene calls</strong><small>Caller, versions, coverage and calculation</small></summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Gene</th><th>Two gene versions</th><th>Genetic result</th><th>Functional result</th><th>Coverage</th><th>Source</th></tr></thead>
              <tbody>{result.genes.map((gene) => {
                const raw = result.pharmcat.genes.find((item) => item.gene === gene.gene)
                return (
                  <tr key={gene.gene}>
                    <td>{gene.gene}</td><td>{gene.diplotype}</td><td>{gene.geneticPhenotype}</td><td>{gene.functionalPhenotype}</td>
                    <td>{raw?.coverageScope}; called {raw?.positionsCalled}; missing {raw?.positionsMissing}; CYP2D6 structure {raw?.structuralVariationUnresolved ? 'unresolved' : 'no unresolved flag'}</td>
                    <td><SourceLinks ids={sourceIdsForGene(gene)} result={result} idsOnly /></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
          <h3>Calculation trace</h3>
          <ol className="pipeline-list">{result.trace.map((step) => <li key={step.step}><strong>{step.step}</strong><span>{step.detail}</span><small>{step.kind} · {step.ms} ms</small></li>)}</ol>
        </details>

        <details className="evidence-group">
          <summary><span>3</span><strong>Medicine rules</strong><small>Exact CPIC rows and sources</small></summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Medicine</th><th>Gene result used</th><th>Action</th><th>Captured text</th><th>Source</th></tr></thead>
              <tbody>{result.shortlist.flatMap((drug) => drug.geneFindings.length
                ? drug.geneFindings.map((finding) => (
                    <tr key={`${drug.drug}-${finding.gene}`}><td>{drug.drug}</td><td>{finding.gene} · {finding.phenotypeUsed}</td><td>{finding.action}</td><td>{finding.guidelineText}</td><td><SourceLinks ids={finding.citationIds} result={result} idsOnly /></td></tr>
                  ))
                : [<tr key={drug.drug}><td>{drug.drug}</td><td>Not used</td><td>no_recommendation</td><td>No captured gene–drug row. This is not a safety finding.</td><td><SourceLinks ids={drug.citationIds} result={result} idsOnly /></td></tr>]
              )}</tbody>
            </table>
          </div>
          <h3>Source register</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>Publisher</th><th>Document</th><th>Date</th><th>Used by</th><th>Link</th></tr></thead>
              <tbody>{sources.map(({ citation, outputIds }) => (
                <tr key={citation.id}><td><code>{citation.id}</code></td><td>{sourcePublisher(citation)}</td><td>{citation.title}</td><td>{citation.year ?? 'Not recorded'}</td><td>{outputIds.join(', ')}</td><td><a href={citation.url} target="_blank" rel="noreferrer">Open</a></td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>

        <details className="evidence-group">
          <summary><span>4</span><strong>Daily-life rules</strong><small>Exact label facts and jurisdiction</small></summary>
          <p><strong>Jurisdiction:</strong> US FDA label snapshot. Australian PI/CMI is not loaded.</p>
          {!selectedProtocol && <p>No medicine selected.</p>}
          {selectedProtocol && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Medicine</th><th>Rule</th><th>Why</th><th>Source</th></tr></thead>
                <tbody>{[...selectedProtocol.items, ...selectedProtocol.interactionItems].map((item) => (
                  <tr key={item.id}><td>{selectedProtocol.drug}</td><td>{item.rule}</td><td>{item.why}</td><td><SourceLinks ids={item.citationIds} result={result} idsOnly /></td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </details>

        <details className="evidence-group">
          <summary><span>5</span><strong>AI audit</strong><small>Connection, boundaries and software checks</small></summary>
          <dl className="evidence-list">
            <div><dt>Medical AI endpoint</dt><dd>{endpointConnected ? 'Configured' : 'Not configured'}</dd></div>
            <div><dt>AI review run</dt><dd>{review ? review.status : 'No'}</dd></div>
            <div><dt>Provider</dt><dd>{review?.provider ?? 'None'}</dd></div>
            <div><dt>Model</dt><dd>{review?.model ?? 'None'}</dd></div>
            <div><dt>Accepted structured items</dt><dd>{review?.items.length ?? 0}</dd></div>
            <div><dt>Rejected items or checks</dt><dd>{review?.rejections.length ?? 0}</dd></div>
            <div><dt>Raw genome sent to AI</dt><dd>No</dd></div>
            <div><dt>Core clinical result</dt><dd>Deterministic; AI cannot mutate it</dd></div>
            <div><dt>Current narrative method</dt><dd>{result.narrative.model}</dd></div>
          </dl>
          {review && review.items.length > 0 && (
            <>
              <h3>Accepted model proposals — audit text only</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Action</th><th>Raw model wording</th><th>Fact IDs</th><th>Source IDs</th></tr></thead>
                  <tbody>{review.items.map((item, index) => <tr key={`${item.action}-${index}`}><td>{item.action}</td><td>{item.summary}</td><td>{item.factIds.join(', ')}</td><td>{item.sourceIds.join(', ') || 'None'}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
          {review && review.rejections.length > 0 && (
            <>
              <h3>Rejected model output</h3>
              <ul className="check-list">{review.rejections.map((item, index) => <li className="check-fail" key={`${item.kind}-${index}`}><strong>{item.kind} · {item.offendingToken}</strong><span>{item.reason}</span></li>)}</ul>
            </>
          )}
          <h3>Software lineage checks — not clinical validation</h3>
          <ul className="check-list">{checks.map((check) => <li key={check.id} className={check.passed ? 'check-pass' : 'check-fail'}><strong>{check.passed ? 'PASS' : 'FAIL'} · {check.label}</strong><span>{check.detail}</span></li>)}</ul>
        </details>

        <details className="evidence-group">
          <summary><span>6</span><strong>Raw export</strong><small>Candidate Australian scope and exact local previews</small></summary>
          <div className="shared-limit"><strong>{AUSTRALIAN_SCOPE_DRAFT.status}</strong><span>Australian candidate list from {AUSTRALIAN_SCOPE_DRAFT.sourceCommit}; visible for review, not used in calculations.</span></div>
          <p><strong>Candidate PGx scope:</strong> {AUSTRALIAN_SCOPE_DRAFT.pgxCandidates.join(', ')}.</p>
          <p><strong>Current blockers:</strong> {AUSTRALIAN_SCOPE_DRAFT.blockers.join(' · ')}</p>
          <h3>Run input</h3>
          <pre>{JSON.stringify({
            fileName: receipt.fileName,
            sha256: receipt.sha256,
            detectedFormat: receipt.kind,
            assayType: receipt.assayType,
            currentMedications: result.input.currentMedications,
            selectedDrug: selectedDrug || null,
            confirmedRoutineAnswers: routine,
          }, null, 2)}</pre>
          <h3>Original file preview</h3>
          <pre>{rawFilePreview}</pre>
          <h3>Engine result preview</h3>
          <pre>{rawResultPreview}</pre>
        </details>
      </div>

      <div className="page-action"><button type="button" className="secondary-button" onClick={downloadBundle}>Download validation bundle</button></div>
    </section>
  )
}

export function ValidationConsole() {
  const [tab, setTab] = useState<TabId>('file')
  const [mode, setMode] = useState<InputMode>('example')
  const [fixtureId, setFixtureId] = useState(FIXTURES[0].id)
  const [medicines, setMedicines] = useState(FIXTURES[0].suggestedMedications.join(', '))
  const [assayType, setAssayType] = useState<'' | AssayType>('')
  const [uploadedFile, setUploadedFile] = useState<{ name: string; size: number; contents: string } | null>(null)
  const [inspection, setInspection] = useState<InputInspection | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [selectedDrug, setSelectedDrug] = useState('')
  const [routine, setRoutine] = useState<RoutineAnswers>({ ...EMPTY_ROUTINE })
  const [clinicalReview, setClinicalReview] = useState<ClinicalReviewResult | null>(null)
  const [status, setStatus] = useState<RunStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const fixture = useMemo(
    () => FIXTURES.find((item) => item.id === fixtureId) ?? FIXTURES[0],
    [fixtureId],
  )

  const resetResult = () => {
    setResult(null)
    setReceipt(null)
    setSelectedDrug('')
    setRoutine({ ...EMPTY_ROUTINE })
    setClinicalReview(null)
    setError(null)
    setStatus('idle')
    setTab('file')
  }

  const chooseMode = (nextMode: InputMode) => {
    setMode(nextMode)
    resetResult()
    if (nextMode === 'example') {
      setMedicines(fixture.suggestedMedications.join(', '))
      setAssayType('')
    } else {
      setMedicines('')
    }
  }

  const chooseFixture = (nextFixture: Fixture) => {
    setFixtureId(nextFixture.id)
    setMedicines(nextFixture.suggestedMedications.join(', '))
    resetResult()
  }

  const readFile = async (file: File) => {
    resetResult()
    setStatus('reading')
    try {
      const contents = await file.text()
      const checked = await inspectGenomeInput(file.name, contents)
      setUploadedFile({ name: file.name, size: file.size, contents })
      setInspection(checked)
      setStatus('idle')
    } catch (caught) {
      setUploadedFile(null)
      setInspection(null)
      setStatus('error')
      setError(caught instanceof Error ? caught.message : 'The file could not be read.')
    }
  }

  const run = async () => {
    setStatus('running')
    setError(null)
    try {
      let checked: InputInspection
      let fileName: string
      let contents: string
      let sizeBytes: number
      let selectedAssay: AssayType
      let source: RunReceipt['source']

      if (mode === 'example') {
        fileName = fixture.fileName
        contents = fixtureToFileText(fixture)
        sizeBytes = new Blob([contents]).size
        selectedAssay = fixture.assayType
        source = 'fictional-example'
        checked = await inspectGenomeInput(fileName, contents)
      } else {
        if (!uploadedFile || !inspection) throw new Error('Choose a file first.')
        if (!assayType) throw new Error('Choose the test type shown on the test report.')
        fileName = uploadedFile.name
        contents = uploadedFile.contents
        sizeBytes = uploadedFile.size
        selectedAssay = assayType
        source = 'uploaded-file'
        checked = inspection
      }

      if (checked.status === 'blocked') {
        throw new Error(`We could not safely read this file${checked.blockingCode ? ` (${checked.blockingCode})` : ''}. We did not guess the missing data.`)
      }

      const adapter = checked.kind === 'pharmcat-report-json'
        ? new PharmCATReportJsonAdapter()
        : checked.canRunPrototype
          ? new TagSnpAdapter()
          : null
      if (!adapter) throw new Error('This file can be inspected, but this browser build cannot calculate a result from it.')

      const currentMedications = parseMedicines(medicines)
      const analysis = await runAnalysis({
        adapter,
        genome: {
          fileName,
          contents: checked.normalizedContents,
          assayType: selectedAssay,
        },
        input: {
          genomeFileName: fileName,
          assayType: selectedAssay,
          currentMedications,
          pastTrials: [],
          careContext: BASE_CARE_CONTEXT,
        },
      })

      setReceipt({
        ...checked,
        source,
        fileName,
        sizeBytes,
        contents,
        assayType: selectedAssay,
        fixtureId: mode === 'example' ? fixture.id : undefined,
      })
      setResult(analysis)
      setSelectedDrug('')
      setRoutine({ ...EMPTY_ROUTINE })
      setClinicalReview(null)
      setStatus('complete')
      setTab('genes')
    } catch (caught) {
      setStatus('error')
      setError(caught instanceof Error ? caught.message : 'The check failed.')
    }
  }

  const openDailyLife = (drug: string) => {
    setSelectedDrug(drug)
    setRoutine({ ...EMPTY_ROUTINE })
    setClinicalReview(null)
    setTab('daily')
  }

  const tabs: Array<{ id: TabId; label: string; disabled: boolean }> = [
    { id: 'file', label: 'File', disabled: false },
    { id: 'genes', label: 'Genes', disabled: !result },
    { id: 'medicines', label: 'Medicines', disabled: !result },
    { id: 'daily', label: 'Daily life', disabled: !result },
    { id: 'ai', label: 'AI review', disabled: !result },
    { id: 'evidence', label: 'Evidence', disabled: !result },
  ]

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark" aria-hidden="true">M</span><strong>Antidepressant PGx</strong></div>
        <span className="build-boundary">Validation build · not for treatment decisions</span>
      </header>

      <nav className="tab-bar" role="tablist" aria-label="Validation steps">
        {tabs.map((item, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${item.id}-panel`}
            disabled={item.disabled}
            className={tab === item.id ? 'tab tab--active' : 'tab'}
            key={item.id}
            onClick={() => setTab(item.id)}
          >
            <span>{index + 1}</span><strong>{item.label}</strong>
          </button>
        ))}
      </nav>

      {result && receipt && (
        <div className="run-context">
          <strong>{receipt.source === 'fictional-example' ? 'Fictional example' : 'Uploaded file'}</strong>
          <span>{receipt.recognizedVariantCount} marker{receipt.recognizedVariantCount === 1 ? '' : 's'}</span>
          <span>Current medicines: {result.input.currentMedications.length ? result.input.currentMedications.map(capitalise).join(', ') : 'none recorded'}</span>
        </div>
      )}

      <div id={`${tab}-panel`} role="tabpanel">
        {tab === 'file' && (
          <FilePanel
            mode={mode}
            onMode={chooseMode}
            fixture={fixture}
            onFixture={chooseFixture}
            medicines={medicines}
            onMedicines={setMedicines}
            assayType={assayType}
            onAssayType={setAssayType}
            uploadedFile={uploadedFile}
            inspection={inspection}
            status={status}
            error={error}
            onFile={(file) => void readFile(file)}
            onRun={() => void run()}
          />
        )}
        {tab === 'genes' && result && <GenesPanel result={result} onNext={() => setTab('medicines')} />}
        {tab === 'medicines' && result && <MedicinesPanel result={result} onExplore={openDailyLife} />}
        {tab === 'daily' && result && (
          <DailyLifePanel
            result={result}
            selectedDrug={selectedDrug}
            onSelectedDrug={(drug) => { setSelectedDrug(drug); setRoutine({ ...EMPTY_ROUTINE }); setClinicalReview(null) }}
            routine={routine}
            onRoutine={(nextRoutine) => { setRoutine(nextRoutine); setClinicalReview(null) }}
            onNext={() => setTab('ai')}
          />
        )}
        {tab === 'ai' && result && <AiReviewPanel result={result} selectedDrug={selectedDrug} routine={routine} review={clinicalReview} onReview={setClinicalReview} />}
        {tab === 'evidence' && result && receipt && <EvidencePanel result={result} receipt={receipt} selectedDrug={selectedDrug} routine={routine} review={clinicalReview} />}
      </div>
    </main>
  )
}
