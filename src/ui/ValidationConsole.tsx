import { useMemo, useState } from 'react'
import {
  buildClinicalReviewContext,
  createClinicalReviewProvider,
  NotConnectedClinicalReviewProvider,
  type ClinicalReviewAction,
  type ClinicalReviewFact,
  type ClinicalReviewItem,
  type ClinicalReviewResult,
} from '../ai/clinical-review'
import { canonicalDrug } from '../data/drug-lexicon'
import { labelFor } from '../data/openfda'
import { dailyPlanConfigured, requestDailyPlan, type DailyPlan, type DailyPlanResult } from '../ai/daily-plan'
import {
  EVIDENCE_LABEL,
  PHASE_LABEL,
  protocolsForDrug,
  type EvidenceStrength,
  type SupportPhase,
  type SupportProtocol,
} from '../data/support-protocols'
import {
  OFFICIAL_PHARMCAT_EXAMPLES,
  type OfficialPharmCATExample,
} from '../data/pharmcat-examples'
import { matchLifestyle } from '../engine/lifestyle-fit'
import { runAnalysis } from '../engine/pipeline'
import { PharmCATReportJsonAdapter } from '../engine/pharmcat/adapter'
import {
  inspectGenomeInput,
  type InputInspection,
} from '../engine/pharmcat/input-inspection'
import { worstRecommendationAction } from '../engine/ranking'
import { runGenome } from '../pharmcat/client'
import type { PharmCATRunManifest, PharmCATRunProgress } from '../pharmcat/types'
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
} from '../engine/types'
import {
  buildSourceUsage,
  buildValidationChecks,
  sourceIdsForGene,
} from '../validation/view-model'

type TabId = 'file' | 'genes' | 'medicines' | 'daily' | 'ai' | 'evidence'
type InputMode = 'genome' | 'example' | 'report'
type RunStatus = 'idle' | 'reading' | 'uploading' | 'analysing' | 'running' | 'complete' | 'error'

interface SelectedFile {
  file: File
  /** Plain-text input used only for local format inspection or report parsing. */
  contents: string | null
}

interface RunReceipt extends InputInspection {
  source: 'pharmcat-run' | 'official-example' | 'uploaded-report'
  fileName: string
  sizeBytes: number
  contents: string
  assayType: AssayType
  runManifest?: PharmCATRunManifest
  exampleId?: string
  sourceUrl?: string
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
  checkIn: null,
  goals: [],
  lifestyle: {},
  needsImmediateSupport: null,
}

const ASSAY_LABEL: Record<AssayType, string> = {
  'consumer-array': 'Consumer DNA array',
  wgs: 'Whole-genome sequencing',
  'targeted-pgx': 'Targeted PGx panel',
  unknown: 'Not established',
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

function parseMedicines(value: string): { recognised: string[]; unrecognised: string[] } {
  const entered = unique(value.split(',').map((medicine) => medicine.trim()).filter(Boolean))
  const recognised: string[] = []
  const unrecognised: string[] = []
  for (const medicine of entered) {
    const generic = canonicalDrug(medicine)
    if (generic) recognised.push(generic.toLowerCase())
    else unrecognised.push(medicine)
  }
  return { recognised: unique(recognised), unrecognised }
}

export function currentMedicinesResolved(value: string, confirmedNone: boolean): boolean {
  const parsed = parseMedicines(value)
  if (parsed.unrecognised.length > 0) return false
  if (confirmedNone) return parsed.recognised.length === 0 && !value.trim()
  return parsed.recognised.length > 0
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

function sourcePublisher(citation: Citation): string {
  switch (citation.kind) {
    case 'cpic': return 'CPIC'
    case 'fda-label': return 'US prescribing information'
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
  if (shown.length <= 1) return shown[0] ?? 'no medicines recorded'
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
    lifestyle: confirmedLifestyleFromRoutine(routine),
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

  const foodRuleIds = new Set([
    'paroxetine-morning', 'sertraline-food', 'escitalopram-timing', 'citalopram-daily',
    'venlafaxine-food-time', 'desvenlafaxine-time', 'duloxetine-food', 'vortioxetine-food',
    'vilazodone-food',
  ])
  if (items.some((item) => item.category === 'food' || foodRuleIds.has(item.id))) questions.push(ROUTINE_QUESTIONS.mealRoutine)
  if (items.some((item) => item.category === 'timing')) questions.push(ROUTINE_QUESTIONS.dailySchedule)
  if ([...ids].some((id) => id.includes('alcohol'))) questions.push(ROUTINE_QUESTIONS.alcohol)
  if ([...ids].some((id) => id.includes('driving'))) questions.push(ROUTINE_QUESTIONS.drivingOrMachinery)
  if ([...ids].some((id) => id.includes('somnolence'))) questions.push(ROUTINE_QUESTIONS.sleep)
  if (ids.has('bupropion-eating-disorder')) questions.push(ROUTINE_QUESTIONS.eatingDisorderHistory)

  return questions
}

function isVcfGzipFile(file: File): boolean {
  return /\.vcf\.gz$/i.test(file.name)
}

function isVcfFile(file: File): boolean {
  return /\.vcf(?:\.gz)?$/i.test(file.name)
}

function FilePanel({
  mode,
  onMode,
  example,
  onExample,
  medicines,
  onMedicines,
  noCurrentMedicines,
  onNoCurrentMedicines,
  uploadedFile,
  inspection,
  status,
  error,
  onFile,
  onRun,
}: {
  mode: InputMode
  onMode: (mode: InputMode) => void
  example: OfficialPharmCATExample
  onExample: (example: OfficialPharmCATExample) => void
  medicines: string
  onMedicines: (value: string) => void
  noCurrentMedicines: boolean
  onNoCurrentMedicines: (confirmed: boolean) => void
  uploadedFile: SelectedFile | null
  inspection: InputInspection | null
  status: RunStatus
  error: string | null
  onFile: (file: File) => void
  onRun: () => void
}) {
  const medicineCheck = parseMedicines(medicines)
  const gzipVcf = Boolean(uploadedFile && isVcfGzipFile(uploadedFile.file))
  const validVcf = Boolean(uploadedFile && isVcfFile(uploadedFile.file))
  const inputReady = mode === 'example'
    || (mode === 'report' && Boolean(uploadedFile && inspection?.canRunAnalysis))
    || (mode === 'genome' && validVcf)
  const busy = ['reading', 'uploading', 'analysing', 'running'].includes(status)
  const ready = inputReady && currentMedicinesResolved(medicines, noCurrentMedicines)
  const buttonLabel = status === 'uploading'
    ? 'Uploading…'
    : status === 'analysing' || status === 'running'
      ? 'Analysing…'
      : mode === 'genome'
        ? 'Analyse DNA'
        : mode === 'example'
          ? 'Use example'
          : 'Read report'

  return (
    <section className="screen screen--narrow" aria-labelledby="file-title">
      <div className="screen-heading">
        <h1 id="file-title">{mode === 'genome' ? 'Upload your DNA' : mode === 'example' ? 'Use a published example' : 'Import an existing report'}</h1>
        <p>{mode === 'genome' ? 'We analyse the file and turn the genetic results into antidepressant guidance.' : mode === 'example' ? 'Run the complete app with a report published by PharmCAT.' : 'For experts who already have PharmCAT Reporter JSON.'}</p>
      </div>

      <div className="input-card">
        {mode !== 'genome' && (
          <button type="button" className="text-button" onClick={() => onMode('genome')}>← Upload DNA instead</button>
        )}

        {mode === 'genome' && (
          <>
            <label className="upload-box">
              <input
                type="file"
                accept=".vcf,.vcf.gz,application/gzip"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) onFile(file)
                }}
              />
              <span className="upload-symbol">↑</span>
              <strong>{status === 'reading' ? 'Checking file…' : uploadedFile ? 'Choose a different file' : 'Choose DNA file'}</strong>
              <small>Single-person GRCh38 VCF or VCF.GZ</small>
            </label>

            {uploadedFile && (
              <div className={`file-ready ${validVcf ? '' : 'file-ready--blocked'}`}>
                <div>
                  <strong>{validVcf ? 'File selected' : 'Cannot use this file'}</strong>
                  <span>{uploadedFile.file.name}{gzipVcf ? ' · compressed VCF' : validVcf ? ' · VCF' : ''}</span>
                </div>
                <small>{formatBytes(uploadedFile.file.size)}</small>
              </div>
            )}

            {uploadedFile && !validVcf && (
              <div className="plain-warning"><strong>VCF required</strong><span>Consumer DNA files need a provider-specific, validated conversion before they can be analysed.</span></div>
            )}

            {validVcf && <p className="source-note">The file's genome build and sample count are checked automatically.</p>}
          </>
        )}

        {mode === 'example' && (
          <>
            <label className="field">
              <span>Published report</span>
              <select value={example.id} onChange={(event) => onExample(OFFICIAL_PHARMCAT_EXAMPLES.find((item) => item.id === event.target.value) ?? OFFICIAL_PHARMCAT_EXAMPLES[0])}>
                {OFFICIAL_PHARMCAT_EXAMPLES.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            <p className="source-note">{example.description} <a href={example.sourcePageUrl} target="_blank" rel="noreferrer">View source</a></p>
          </>
        )}

        {mode === 'report' && (
          <>
            <label className="upload-box upload-box--compact">
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) onFile(file)
                }}
              />
              <span className="upload-symbol">↑</span>
              <strong>{status === 'reading' ? 'Checking report…' : 'Choose report'}</strong>
              <small>PharmCAT Reporter JSON</small>
            </label>
            {uploadedFile && inspection && (
              <div className={`file-ready ${inspection.canRunAnalysis ? '' : 'file-ready--blocked'}`}>
                <div><strong>{inspection.canRunAnalysis ? 'Report ready' : 'Cannot use this report'}</strong><span>{uploadedFile.file.name}</span></div>
                <small>{formatBytes(uploadedFile.file.size)}</small>
              </div>
            )}
            {inspection?.warnings[0] && !inspection.canRunAnalysis && (
              <div className="error-message" role="alert"><strong>Report problem</strong><span>{inspection.warnings[0]}</span></div>
            )}
          </>
        )}

        <label className="field medicines-field">
          <span>Current medicines and supplements</span>
          <input disabled={noCurrentMedicines} value={medicines} onChange={(event) => onMedicines(event.target.value)} placeholder="For example: fluoxetine, ibuprofen" />
          <small>Add prescriptions, over-the-counter medicines and supplements.</small>
        </label>

        <label className="medicine-none">
          <input type="checkbox" checked={noCurrentMedicines} onChange={(event) => onNoCurrentMedicines(event.target.checked)} />
          <span>I take none</span>
        </label>

        {medicineCheck.unrecognised.length > 0 && (
          <div className="error-message" role="alert"><strong>Medicine not recognised</strong><span>{medicineCheck.unrecognised.join(', ')}</span></div>
        )}

        {status === 'uploading' && <div className="run-progress"><span /><strong>Uploading DNA securely…</strong></div>}
        {status === 'analysing' && <div className="run-progress"><span /><strong>Analysing genes and medicine guidance…</strong></div>}
        {error && <div className="error-message" role="alert"><strong>Analysis stopped</strong><span>{error}</span></div>}

        <div className="action-row">
          <button type="button" className="primary-button" disabled={!ready || busy} onClick={onRun}>{buttonLabel}</button>
        </div>

        {/* Always offer the modes you are not currently in. This used to render only in
            genome mode, so once the default moved off genome there was no route back. */}
        <details className="advanced-input">
          <summary>Other ways to start</summary>
          <div>
            {mode !== 'genome' && (
              <button type="button" className="secondary-button" onClick={() => onMode('genome')}>Upload your DNA</button>
            )}
            {mode !== 'example' && (
              <button type="button" className="secondary-button" onClick={() => onMode('example')}>Use published example</button>
            )}
            {mode !== 'report' && (
              <button type="button" className="secondary-button" onClick={() => onMode('report')}>Import PharmCAT report</button>
            )}
          </div>
        </details>
      </div>
    </section>
  )
}

function GenesPanel({ result, runManifest, onNext }: { result: AnalysisResult; runManifest?: PharmCATRunManifest; onNext: () => void }) {
  return (
    <section className="screen" aria-labelledby="genes-title">
      <div className="screen-heading">
        <h1 id="genes-title">How your body processes medicines</h1>
        <p>These gene results can affect dose or safety. They cannot tell us which antidepressant will work.</p>
      </div>

      {result.pharmcat.provenance === 'pharmcat-json' && !runManifest && (
        <div className="shared-limit"><strong>Coverage is not in this file</strong><span>Open Sources to see what could and could not be verified.</span></div>
      )}
      {runManifest && runManifest.outputs.missingPositionCount > 0 && (
        <div className="shared-limit"><strong>DNA coverage gap</strong><span>{runManifest.outputs.missingPositionCount} required position{runManifest.outputs.missingPositionCount === 1 ? ' was' : 's were'} missing. Affected results stay incomplete.</span></div>
      )}
      {runManifest?.exclusions.map((exclusion) => (
        <div className="shared-limit" key={exclusion.gene}><strong>{exclusion.gene} was not reported</strong><span>{exclusion.reason}</span></div>
      ))}

      <div className="gene-list">
        {result.genes.map((gene) => {
          const raw = result.pharmcat.genes.find((item) => item.gene === gene.gene)
          const modifierNames = unique(gene.modifiers.map((modifier) => modifier.drug)).map(capitalise)
          const reportedPhenotype = gene.geneticPhenotype

          return (
            <article className="gene-row" key={gene.gene}>
              <div className="gene-result">
                <strong>{speedTitle(reportedPhenotype)}</strong>
                <span>{gene.gene}</span>
              </div>
              <div className="gene-meaning">
                {gene.status === 'uncertain_extent' ? (
                  <>
                    <strong>Current medicine may change enzyme activity</strong>
                    <p>The report says {phenotypeWords(reportedPhenotype)}. {listWords(modifierNames)} may slow this enzyme. A research convention estimates {gene.modeledFunctionalPhenotype ? phenotypeWords(gene.modeledFunctionalPhenotype) : 'an uncertain change'}, but that estimate did not replace the report or medicine guidance.</p>
                  </>
                ) : gene.converted ? (
                  <>
                    <strong>Current medicine changes the value used for guidance</strong>
                    <p>Genes suggest {phenotypeWords(gene.geneticPhenotype)} activity. {listWords(modifierNames)} may make this enzyme work {phenotypeWords(gene.functionalPhenotype)} while taken.</p>
                  </>
                ) : gene.status === 'unvalidated_method' ? (
                  <>
                    <strong>A current-medicine effect is unresolved</strong>
                    <p>The gene result is {phenotypeWords(gene.functionalPhenotype)}. This app cannot safely calculate how much the recorded medicine changes it.</p>
                  </>
                ) : reportedPhenotype === 'Indeterminate' ? (
                  <p>This report does not contain enough data to calculate {gene.gene}.</p>
                ) : (
                  <p>Medicines handled by {gene.gene} may be processed {phenotypeWords(reportedPhenotype)}.</p>
                )}
              </div>
              <details className="science-details">
                <summary>See gene details</summary>
                <dl className="technical-list">
                  <div><dt>Reported phenotype</dt><dd>{reportedPhenotype}</dd></div>
                  <div><dt>Two gene versions</dt><dd>{gene.diplotype}</dd></div>
                  <div><dt>Reported activity score</dt><dd>{gene.geneticActivityScore ?? 'Not defined'}</dd></div>
                  {gene.modeledFunctionalPhenotype && <div><dt>Research-convention estimate</dt><dd>{gene.modeledFunctionalPhenotype} · score {gene.modeledFunctionalActivityScore}</dd></div>}
                  <div><dt>Caller</dt><dd>{raw?.callSource ?? 'Not supplied'}</dd></div>
                  <div><dt>Definition versions</dt><dd>Alleles: {raw?.alleleDefinitionVersion ?? 'not supplied'} · phenotype: {raw?.phenotypeVersion ?? 'not supplied'}</dd></div>
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
  if (!drug.geneFindings.length) return 'No matched PharmCAT antidepressant guidance.'
  return unique(
    drug.geneFindings.flatMap((finding) => finding.geneResults)
      .map((result) => result.phenotype === 'Indeterminate'
        ? `${result.gene}: not enough data`
        : `${result.gene}: ${phenotypeWords(result.phenotype)}`),
  ).join(' · ')
}

export function exactDoseSentence(drug: DrugAssessment): string | null {
  const worstAction = worstRecommendationAction(drug.geneFindings.map((finding) => finding.action))
  if (!worstAction || worstAction === 'avoid' || worstAction === 'alternative') return null

  for (const finding of drug.geneFindings.filter((item) => item.action === worstAction)) {
    const sentence = finding.guidelineText.match(/(?:^|\.\s+)([^.]*\b\d{1,3}%[^.]*\.)/i)?.[1]?.trim()
    if (sentence) return sentence
  }
  return null
}

function MedicineRow({ drug, result, onExplore }: { drug: DrugAssessment; result: AnalysisResult; onExplore: (drug: string) => void }) {
  const protocol = result.protocolsByDrug[drug.drug]
  const hasDailyEvidence = Boolean(protocol && (protocol.items.length || protocol.interactionItems.length))
  const doseSentence = exactDoseSentence(drug)
  return (
    <article className="medicine-row">
      <div className="medicine-copy">
        <h3>{capitalise(drug.drug)}</h3>
        <strong className="medicine-guidance">{doseSentence ?? (drug.headline === 'avoid' ? 'Guideline says to avoid' : capitalise(drug.headline))}</strong>
        <p>{medicineSummary(drug)}</p>
        {drug.interactionFlags.length > 0 && <span className="inline-alert">A current medicine adds an interaction question.</span>}
      </div>
      <button type="button" className="row-button" disabled={!hasDailyEvidence} onClick={() => onExplore(drug.drug)}>
        {hasDailyEvidence ? 'Check daily life' : 'No daily information'}
      </button>
      {drug.geneFindings.length > 0 && (
        <details className="rule-details">
          <summary>See source rule</summary>
          {drug.geneFindings.map((finding) => (
            <div className="guideline-block" key={`${finding.gene}-${finding.phenotypeUsed}`}>
              <strong>{finding.geneResults.map((item) => `${item.gene}: ${item.phenotype}`).join(' · ')}</strong>
              <small>Population: {finding.population ?? 'not supplied'}</small>
              <p>{finding.guidelineText}</p>
              <SourceLinks ids={finding.citationIds} result={result} idsOnly />
              {finding.sourceUrl && <> · <a href={finding.sourceUrl} target="_blank" rel="noreferrer">ClinPGx annotation</a></>}
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

function MedicineGroup({ title, drugs, result, onExplore }: {
  title: string
  drugs: DrugAssessment[]
  result: AnalysisResult
  onExplore: (drug: string) => void
}) {
  if (!drugs.length) return null
  return (
    <section className="medicine-group">
      <div className="group-heading"><h2>{title}</h2></div>
      <div className="medicine-list">{drugs.map((drug) => <MedicineRow key={drug.drug} drug={drug} result={result} onExplore={onExplore} />)}</div>
    </section>
  )
}

function MedicinesPanel({ result, onExplore }: { result: AnalysisResult; onExplore: (drug: string) => void }) {
  const alternatives = result.shortlist.filter((drug) => drug.pgxCategory === 'alternative_discussion')
  const doseReview = result.shortlist.filter((drug) => drug.pgxCategory === 'dose_or_titration_review')
  const usual = result.shortlist.filter((drug) => drug.pgxCategory === 'usual_guidance')
  const noRule = result.shortlist.filter((drug) => drug.pgxCategory === 'no_gene_based_guidance')
  const cyp2d6 = result.pharmcat.genes.find((gene) => gene.gene === 'CYP2D6')

  return (
    <section className="screen" aria-labelledby="medicines-title">
      <div className="screen-heading">
        <h1 id="medicines-title">What your genes change</h1>
        <p>Source-backed guidance for dose and medicine choice. This does not predict whether a medicine will work.</p>
      </div>

      {cyp2d6?.structuralVariationUnresolved && (
        <div className="shared-limit"><strong>CYP2D6 is incomplete</strong><span>Structural and copy-number variation could not be confirmed, so affected medicine results stay limited.</span></div>
      )}

      <MedicineGroup title="Discuss a different medicine" drugs={alternatives} result={result} onExplore={onExplore} />
      <MedicineGroup title="Dose may need changing" drugs={doseReview} result={result} onExplore={onExplore} />
      <MedicineGroup title="No gene-based dose change" drugs={usual} result={result} onExplore={onExplore} />

      {noRule.length > 0 && (
        <details className="no-rule-group">
          <summary>No supported gene guidance for {noRule.length} medicine{noRule.length === 1 ? '' : 's'}</summary>
          <p>This does not mean these medicines are safe or suitable.</p>
          <div className="medicine-list">{noRule.map((drug) => <MedicineRow key={drug.drug} drug={drug} result={result} onExplore={onExplore} />)}</div>
        </details>
      )}
    </section>
  )
}

function routineFitStatus(question: RoutineQuestion, routine: RoutineAnswers, facts: DailyFitFact[]): { label: 'Matches' | 'May conflict' | 'Important' | 'Choose an answer' | 'Not checked'; detail: string } {
  const answer = routine[question.key]
  if (!answer) return { label: 'Choose an answer', detail: '' }

  const fact = facts.find((item) => item.dimension === question.dimension)
  if (fact) {
    if (fact.verdict === 'supports_routine') return { label: 'Matches', detail: 'Your answer matches this medicine instruction.' }
    if (fact.verdict === 'clinician_review') return { label: 'Important', detail: 'Tell your doctor about this before starting.' }
    return { label: 'May conflict', detail: 'This instruction may be difficult with your routine.' }
  }

  return { label: 'Not checked', detail: 'The available medicine information cannot check this answer.' }
}

function lifestyleLabel(label: string): string {
  const cleaned = label
    .replace(/^LABEL\s+/i, '')
    .replace(/\s+REVIEW$/i, '')
    .toLowerCase()
  if (cleaned === 'contraindication') return 'Important safety'
  if (cleaned === 'review together') return 'Medicine combination'
  return capitalise(cleaned)
}

function directRule(rule: string): string {
  return rule.replace(/^The captured /, 'The ')
}

function EvidenceBadge({ strength }: { strength: EvidenceStrength }) {
  return (
    <span className={`evidence evidence--${strength}`} title={EVIDENCE_LABEL[strength]}>
      {EVIDENCE_LABEL[strength]}
    </span>
  )
}

function SupportCard({ protocol }: { protocol: SupportProtocol }) {
  return (
    <article className="support-card">
      <header>
        <h3>{protocol.bodyEffect}</h3>
        <EvidenceBadge strength={protocol.evidenceStrength} />
      </header>

      <p className="support-card__why">{protocol.mechanism}</p>

      <div className="support-card__actions">
        <div className="support-lane">
          <span className="support-lane__label">Do this</span>
          <ul>{protocol.doThis.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>

        {protocol.eatThis.length > 0 && (
          <div className="support-lane support-lane--eat">
            <span className="support-lane__label">Eat this</span>
            <ul>{protocol.eatThis.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}

        {protocol.avoidThis.length > 0 && (
          <div className="support-lane support-lane--avoid">
            <span className="support-lane__label">Avoid</span>
            <ul>{protocol.avoidThis.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
      </div>

      {protocol.timeline && (
        <p className="support-card__timeline"><strong>What to expect.</strong> {protocol.timeline}</p>
      )}

      <details className="support-card__source">
        <summary>Where this comes from</summary>
        <p>{protocol.source}</p>
      </details>
    </article>
  )
}


const WHERE_OPTIONS: Array<{ value: SupportPhase; label: string; dayHint: string }> = [
  { value: 'first_weeks', label: 'Just started, or the first few weeks', dayHint: 'e.g. day 9' },
  { value: 'ongoing', label: 'Been on it a while', dayHint: 'e.g. month 4' },
  { value: 'switching', label: 'Changing or coming off it', dayHint: 'e.g. tapering, week 2' },
]

function TodayPlan({ drug }: { drug: string }) {
  const [phase, setPhase] = useState<SupportPhase>('first_weeks')
  const [dayLabel, setDayLabel] = useState('')
  const [result, setResult] = useState<DailyPlanResult | null>(null)
  const [loading, setLoading] = useState(false)

  const configured = dailyPlanConfigured()
  const hint = WHERE_OPTIONS.find((option) => option.value === phase)?.dayHint ?? ''

  async function build() {
    setLoading(true)
    setResult(null)
    setResult(await requestDailyPlan({ drug, phase, dayLabel: dayLabel.trim() }))
    setLoading(false)
  }

  const plan: DailyPlan | null = result?.status === 'ok' ? result.plan : null

  return (
    <section className="today" aria-labelledby="today-title">
      <h2 id="today-title">Today</h2>
      <p className="today__lede">
        A plan for where you actually are, built from what {capitalise(drug)} is doing to your
        body right now.
      </p>

      <div className="today__controls">
        <label className="compact-field">
          <span>Where are you with it?</span>
          <select value={phase} onChange={(event) => setPhase(event.target.value as SupportPhase)}>
            {WHERE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="compact-field">
          <span>How far in? <em>optional</em></span>
          <input
            type="text"
            value={dayLabel}
            placeholder={hint}
            onChange={(event) => setDayLabel(event.target.value)}
          />
        </label>
        <button type="button" className="primary-button" disabled={loading || !configured} onClick={() => void build()}>
          {loading ? 'Building…' : plan ? 'Rebuild today' : "Build today's plan"}
        </button>
      </div>

      {!configured && (
        <p className="today__note">The plan service is not configured for this build.</p>
      )}

      {result?.status === 'error' && <p className="today__note">{result.message}</p>}

      {result?.status === 'rejected' && (
        <p className="today__note">
          {result.note} <span className="today__flags">({result.problems.join(', ')})</span>
        </p>
      )}

      {plan && (
        <div className="today__plan">
          <h3>{plan.today.headline}</h3>

          <div className="today__grid">
            <div className="today__block">
              <span className="today__label">This morning</span>
              <p>{plan.today.morning}</p>
            </div>

            <div className="today__block today__block--eat">
              <span className="today__label">Eat today</span>
              <ul>{plan.today.eat.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>

            <div className="today__block">
              <span className="today__label">Notice</span>
              <p>{plan.today.watchFor}</p>
            </div>

            {plan.today.skip && (
              <div className="today__block today__block--skip">
                <span className="today__label">Skip today</span>
                <p>{plan.today.skip}</p>
              </div>
            )}
          </div>

          <div className="today__block">
            <span className="today__label">This week</span>
            <p>{plan.thisWeek}</p>
          </div>

          <div className="today__block today__block--hard">
            <span className="today__label">If today is hard</span>
            <p>{plan.ifItIsHard}</p>
          </div>

          {result?.status === 'ok' && (
            <p className="today__provenance">
              Written by {result.model} from {result.protocolsUsed} support protocols for{' '}
              {drug}. It cannot give a dose or tell you to change your medicine — output
              containing either is withheld.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function DailyLifePanel({
  result,
  selectedDrug,
  onSelectedDrug,
  productConfirmed,
  onProductConfirmed,
  routine,
  onRoutine,
  onNext,
}: {
  result: AnalysisResult
  selectedDrug: string
  onSelectedDrug: (drug: string) => void
  productConfirmed: boolean
  onProductConfirmed: (confirmed: boolean) => void
  routine: RoutineAnswers
  onRoutine: (routine: RoutineAnswers) => void
  onNext: () => void
}) {
  const protocol = selectedDrug ? result.protocolsByDrug[selectedDrug] : null
  const product = selectedDrug ? labelFor(selectedDrug) : undefined
  const questions = protocol ? relevantRoutineQuestions(protocol) : []
  const confirmedLifestyle = confirmedLifestyleFromRoutine(routine)
  const match = protocol && productConfirmed
    ? matchLifestyle(protocol, careFromRoutine(routine), confirmedLifestyle)
    : null
  const protocolItems = protocol ? [...protocol.items, ...protocol.interactionItems] : []

  const support = selectedDrug ? protocolsForDrug(selectedDrug) : []
  const phases: SupportPhase[] = ['first_weeks', 'ongoing', 'switching']

  return (
    <section className="screen" aria-labelledby="daily-title">
      <div className="screen-heading">
        <h1 id="daily-title">{selectedDrug ? `Living with ${capitalise(selectedDrug)}` : 'Living with your medicine'}</h1>
        <p>What this medicine does to your body, and what actually helps. Ordered by where you are in the course.</p>
      </div>

      <label className="field medicine-picker medicine-picker--simple">
        <span>Choose a medicine</span>
        <select value={selectedDrug} onChange={(event) => onSelectedDrug(event.target.value)}>
          <option value="">Select</option>
          {result.shortlist.map((drug) => <option key={drug.drug} value={drug.drug}>{capitalise(drug.drug)}</option>)}
        </select>
      </label>

      {!selectedDrug && <div className="empty-state"><span>Choose a medicine to see what to expect and what helps.</span></div>}

      {selectedDrug && support.length === 0 && (
        <div className="empty-state">
          <span>No mechanism-based support content is available for {capitalise(selectedDrug)} yet.</span>
        </div>
      )}

      {selectedDrug && support.length > 0 && <TodayPlan drug={selectedDrug} />}

      {phases.map((phase) => {
        const inPhase = support.filter((item) => item.phase === phase)
        if (!inPhase.length) return null
        return (
          <section className="support-phase" key={phase} aria-label={PHASE_LABEL[phase]}>
            <h2 className="support-phase__title">{PHASE_LABEL[phase]}</h2>
            <div className="support-phase__cards">
              {inPhase.map((item) => <SupportCard protocol={item} key={item.id} />)}
            </div>
          </section>
        )
      })}

      {protocol && (
        <details className="label-facts">
          <summary>What the product label says ({protocolItems.length})</summary>
          <div>
            {product && (
              <p className="label-facts__product">
                {product.productName ?? capitalise(selectedDrug)} · {product.dosageForm.toLowerCase()} · US label, SPL {product.setId}
              </p>
            )}
            <div className="instruction-list">
              {protocolItems.map((item) => (
                <article className={item.severity === 'critical' ? 'instruction instruction--important' : 'instruction'} key={item.id}>
                  <span className="instruction-icon" aria-hidden="true">{item.icon}</span>
                  <div>
                    <span>{lifestyleLabel(item.label)}</span>
                    <strong>{directRule(item.rule)}</strong>
                  </div>
                </article>
              ))}
            </div>
            <label className="product-confirm">
              <input
                type="checkbox"
                checked={productConfirmed}
                onChange={(event) => onProductConfirmed(event.target.checked)}
              />
              <span>This is the exact product and form I take</span>
            </label>
          </div>
        </details>
      )}

      {protocol && productConfirmed && questions.length > 0 && (
        <section className="daily-section" aria-labelledby="routine-title">
          <h2 id="routine-title">Does this fit your day?</h2>
          <div className="routine-grid">
            {questions.map((question) => {
              const status = routineFitStatus(question, routine, match?.facts ?? [])
              return (
                <label className="compact-field" key={question.key}>
                  <span>{question.label}</span>
                  <select
                    value={routine[question.key]}
                    onChange={(event) => onRoutine({ ...routine, [question.key]: event.target.value })}
                  >
                    <option value="">Choose an answer</option>
                    {question.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <small className={`fit fit--${status.label.toLowerCase().replace(/\s+/g, '-')}`}>{status.label}: {status.detail}</small>
                </label>
              )
            })}
          </div>
        </section>
      )}

      {selectedDrug && (
        <div className="page-action">
          <button type="button" className="primary-button" onClick={onNext}>Continue to AI review</button>
        </div>
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

function factLead(text: string): string {
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? text.trim()
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177).trimEnd()}…` : firstSentence
}

function canonicalReviewText(item: ClinicalReviewItem, factsById: Map<string, ClinicalReviewFact>): string {
  const facts = item.factIds
    .map((id) => factsById.get(id))
    .filter((fact): fact is ClinicalReviewFact => Boolean(fact))
    .slice(0, 2)
    .map((fact) => factLead(fact.text))
  const subject = facts.join(' · ') || 'The linked facts need review.'
  switch (item.action) {
    case 'evidence_gap': return `More evidence is needed: ${subject}`
    case 'input_conflict': return `Reconcile these facts: ${subject}`
    case 'clinician_question': return `Ask the prescriber about: ${subject}`
    case 'lifestyle_constraint': return `Plan around: ${subject}`
    case 'request_counterfactual': return counterfactualText(item)
  }
}

function AiReviewPanel({
  result,
  selectedDrug,
  routine,
  review,
  attestedRunId,
  onReview,
}: {
  result: AnalysisResult
  selectedDrug: string
  routine: RoutineAnswers
  review: ClinicalReviewResult | null
  attestedRunId: string | null
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
  const modelConfigured = providerState.provider.mode === 'ai'
  const hasAttestedRun = Boolean(attestedRunId)
  const connected = modelConfigured && hasAttestedRun
  const answers = Object.keys(confirmedLifestyle).length

  const runReview = async () => {
    setRunning(true)
    onReview(null)
    const nextReview = await providerState.provider.review(result, {
      attestedRunId,
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
        <h1 id="ai-title">Clinical AI review</h1>
        <p>MedGemma proposes source-linked gaps, conflicts and prescriber questions. Invalid proposals are rejected.</p>
      </div>

      <div className={`model-status ${connected ? 'model-status--connected' : ''}`}>
        <span className="status-dot" aria-hidden="true" />
        <div>
          <strong>{!hasAttestedRun ? 'AI review unavailable' : connected ? 'MedGemma ready' : 'MedGemma not connected'}</strong>
          <span>{!hasAttestedRun ? 'AI review requires a completed DNA analysis.' : connected ? 'The model can review this completed result.' : 'The medical model is not available in this deployment.'}</span>
        </div>
      </div>

      <div className="review-inputs">
        <span>{result.genes.length} gene results · {result.input.currentMedications.length ? `${result.input.currentMedications.length} current medicine${result.input.currentMedications.length === 1 ? '' : 's'}` : 'No current medicines or supplements'} · {selectedDrug ? capitalise(selectedDrug) : 'no medicine selected'} · {answers} routine answer{answers === 1 ? '' : 's'}</span>
      </div>

      {connected && !review && (
        <div className="ai-ready">
          <span>Only derived facts and source IDs are sent. Raw DNA stays out of the model.</span>
          <button type="button" className="primary-button" disabled={running} onClick={() => void runReview()}>{running ? 'Reviewing…' : 'Run review'}</button>
        </div>
      )}

      {!connected && hasAttestedRun && (
        <div className="connection-help">
          <strong>Review unavailable</strong>
          <span>{providerState.configurationError ?? 'No private model connection is configured here.'}</span>
        </div>
      )}

      {review && review.status === 'complete' && (
        <section className="review-output" aria-label="Fact-linked AI review">
          <div className="review-output__heading">
            <div><h2>Fact-linked review</h2></div>
            <button type="button" className="secondary-button" onClick={() => void runReview()}>Run again</button>
          </div>
          <div className="review-items">
            {review.items.map((item, index) => (
              <article className="review-item" key={`${item.action}-${index}`}>
                <span>{REVIEW_ACTION_LABEL[item.action]}</span>
                <strong>{canonicalReviewText(item, factsById)}</strong>
                <details>
                  <summary>Evidence · {item.factIds.length} fact{item.factIds.length === 1 ? '' : 's'}</summary>
                  <ul>{item.factIds.map((id) => <li key={id}><code>{id}</code><span>{factsById.get(id)?.text ?? 'Fact not found in the current review context.'}</span></li>)}</ul>
                  {item.sourceIds.length > 0 && <p>Sources: {item.sourceIds.join(', ')}</p>}
                </details>
              </article>
            ))}
          </div>
          <div className="review-audit"><strong>{review.provider}</strong><span>{review.items.length} passed grounding checks · {review.rejections.length} failed</span></div>
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

function EvidencePanel({ result, receipt, selectedDrug, productConfirmed, routine, review }: {
  result: AnalysisResult
  receipt: RunReceipt
  selectedDrug: string
  productConfirmed: boolean
  routine: RoutineAnswers
  review: ClinicalReviewResult | null
}) {
  const checks = buildValidationChecks(result)
  const sources = buildSourceUsage(result)
  const selectedProtocol = selectedDrug ? result.protocolsByDrug[selectedDrug] : null
  const selectedProduct = selectedDrug ? labelFor(selectedDrug) : undefined
  const confirmedLifestyle = confirmedLifestyleFromRoutine(routine)
  const displayedLifestyleMatch = selectedProtocol && productConfirmed
    ? matchLifestyle(selectedProtocol, careFromRoutine(routine), confirmedLifestyle)
    : null
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
        source: receipt.source,
        sourceUrl: receipt.sourceUrl ?? null,
        sha256: receipt.sha256,
        detectedFormat: receipt.kind,
        assayType: receipt.assayType,
        runManifest: receipt.runManifest ?? null,
        currentMedications: result.input.currentMedications,
        currentMedicationsStatus: result.input.currentMedications.length ? 'provided' : 'confirmed_none',
      },
      selectedDrug: selectedDrug || null,
      dailyLife: {
        productConfirmed,
        product: selectedProduct ? {
          generic: selectedProduct.generic,
          productName: selectedProduct.productName,
          dosageForm: selectedProduct.dosageForm,
          route: selectedProduct.route,
          manufacturer: selectedProduct.manufacturer,
          applicationNumber: selectedProduct.applicationNumber,
          productNdc: selectedProduct.productNdc,
          setId: selectedProduct.setId,
          versionId: selectedProduct.versionId,
          effectiveTime: selectedProduct.effectiveTime,
          sourceDigestSha256: selectedProduct.sourceDigestSha256,
        } : null,
        confirmedAnswers: confirmedLifestyle,
        match: displayedLifestyleMatch,
      },
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
    link.download = `pgx-run-${receipt.sha256.slice(0, 8)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="screen" aria-labelledby="evidence-title">
      <div className="screen-heading">
        <h1 id="evidence-title">Sources and run details</h1>
        <p>Every input, calculation and source used for these results.</p>
      </div>

      <div className="evidence-groups">
        <details className="evidence-group">
          <summary><span>1</span><strong>Input file</strong><small>Format, hash and transformations</small></summary>
          <dl className="evidence-list">
            <div><dt>Data origin</dt><dd>{receipt.source === 'pharmcat-run' ? 'Generated by this analysis' : receipt.source === 'official-example' && receipt.sourceUrl ? <a href={receipt.sourceUrl} target="_blank" rel="noreferrer">Published PharmCAT example</a> : 'Imported report; origin not verified'}</dd></div>
            <div><dt>File</dt><dd>{receipt.fileName} · {formatBytes(receipt.sizeBytes)}</dd></div>
            <div><dt>SHA-256</dt><dd><code>{receipt.sha256}</code></dd></div>
            <div><dt>Input format</dt><dd>{receipt.runManifest?.input.format ?? receipt.formatLabel}</dd></div>
            <div><dt>Genome build</dt><dd>{receipt.runManifest?.input.genomeBuild ?? receipt.genomeBuild ?? 'Not proven'}</dd></div>
            <div><dt>Assay</dt><dd>{ASSAY_LABEL[receipt.assayType]}</dd></div>
            {receipt.runManifest && <div><dt>Run</dt><dd><code>{receipt.runManifest.runId}</code> · PharmCAT {receipt.runManifest.caller.pharmcatVersion} · <code>{receipt.runManifest.caller.imageDigest}</code></dd></div>}
            {receipt.runManifest && <div><dt>Coverage</dt><dd>{receipt.runManifest.input.recordCount} VCF records · {receipt.runManifest.outputs.missingPositionCount} required positions missing</dd></div>}
            <div><dt>Blocking code</dt><dd>{receipt.blockingCode ?? 'None'}</dd></div>
            <div><dt>Transformations</dt><dd>{receipt.transformations.length ? receipt.transformations.join(' · ') : 'None'}</dd></div>
            <div><dt>Warnings</dt><dd>{receipt.warnings.length ? receipt.warnings.join(' · ') : 'None recorded'}</dd></div>
          </dl>
        </details>

        <details className="evidence-group">
          <summary><span>2</span><strong>Gene calls</strong><small>Caller, versions, coverage and calculation</small></summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Gene</th><th>Two gene versions</th><th>Reported result</th><th>Modeled estimate</th><th>Caller and versions</th><th>Coverage</th><th>Source</th></tr></thead>
              <tbody>{result.genes.map((gene) => {
                const raw = result.pharmcat.genes.find((item) => item.gene === gene.gene)
                return (
                  <tr key={gene.gene}>
                    <td>{gene.gene}</td><td>{gene.diplotype}</td><td>{gene.geneticPhenotype}</td><td>{gene.modeledFunctionalPhenotype ? `${gene.modeledFunctionalPhenotype}; score ${gene.modeledFunctionalActivityScore}` : 'Not modeled'}</td>
                    <td>{raw?.callSource ?? 'unknown'}; allele definitions {raw?.alleleDefinitionVersion ?? 'unknown'}; phenotype rules {raw?.phenotypeVersion ?? 'unknown'}</td>
                    <td>{raw?.coverageScope}; called {raw?.positionsCalled ?? 'unknown'}; missing {raw?.positionsMissing ?? 'unknown'}; CYP2D6 structure {raw?.structuralVariationUnresolved ? 'unresolved' : 'no unresolved flag'}</td>
                    <td><SourceLinks ids={sourceIdsForGene(gene)} result={result} idsOnly /></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
          <h3>Calculation trace</h3>
          <ol className="pipeline-list">{result.trace.map((step) => <li key={step.step}><strong>{step.step}</strong><span>{step.detail}</span><small>{step.ms} ms</small></li>)}</ol>
        </details>

        <details className="evidence-group">
          <summary><span>3</span><strong>Medicine rules</strong><small>Exact CPIC rows and sources</small></summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Medicine</th><th>Gene result used</th><th>Action</th><th>Captured text</th><th>Source</th></tr></thead>
              <tbody>{result.shortlist.flatMap((drug) => drug.geneFindings.length
                ? drug.geneFindings.map((finding) => (
                    <tr key={`${drug.drug}-${finding.gene}`}><td>{drug.drug}</td><td>{finding.geneResults.map((item) => `${item.gene}: ${item.phenotype}`).join(' · ')} · population: {finding.population ?? 'not supplied'}</td><td>{finding.action}</td><td>{finding.guidelineText}</td><td><SourceLinks ids={finding.citationIds} result={result} idsOnly />{finding.sourceUrl && <> · <a href={finding.sourceUrl} target="_blank" rel="noreferrer">annotation</a></>}</td></tr>
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
          <summary><span>4</span><strong>Daily-life rules</strong><small>Pinned US prescribing-information records</small></summary>
          <p>These records are pinned to a specific US product and version. Australian PI/CMI is not loaded.</p>
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
            <div><dt>Items that passed grounding checks</dt><dd>{review?.items.length ?? 0}</dd></div>
            <div><dt>Items that failed grounding checks</dt><dd>{review?.rejections.length ?? 0}</dd></div>
            <div><dt>Raw genome sent to AI</dt><dd>No</dd></div>
            <div><dt>Core clinical result</dt><dd>Deterministic; AI cannot mutate it</dd></div>
          </dl>
          {review && review.items.length > 0 && (
            <>
              <h3>Model proposals that passed grounding checks</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Action</th><th>Displayed wording</th><th>Fact IDs</th><th>Source IDs</th></tr></thead>
                  <tbody>{review.items.map((item, index) => <tr key={`${item.action}-${index}`}><td>{item.action}</td><td>Deterministic wording assembled from the linked facts</td><td>{item.factIds.join(', ')}</td><td>{item.sourceIds.join(', ') || 'None'}</td></tr>)}</tbody>
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
          <h3>Software lineage checks</h3>
          <p>These checks verify processing and traceability, not clinical accuracy.</p>
          <ul className="check-list">{checks.map((check) => <li key={check.id} className={check.passed ? 'check-pass' : 'check-fail'}><strong>{check.passed ? 'PASS' : 'FAIL'} · {check.label}</strong><span>{check.detail}</span></li>)}</ul>
        </details>

        <details className="evidence-group">
          <summary><span>6</span><strong>Run export</strong><small>Exact inputs and engine output</small></summary>
          <h3>Run input</h3>
          <pre>{JSON.stringify({
            fileName: receipt.fileName,
            source: receipt.source,
            sourceUrl: receipt.sourceUrl ?? null,
            sha256: receipt.sha256,
            detectedFormat: receipt.kind,
            assayType: receipt.assayType,
            runManifest: receipt.runManifest ?? null,
            currentMedications: result.input.currentMedications,
            currentMedicationsStatus: result.input.currentMedications.length ? 'provided' : 'confirmed_none',
            selectedDrug: selectedDrug || null,
            lifestyleProductConfirmed: productConfirmed,
            confirmedRoutineAnswers: confirmedLifestyle,
          }, null, 2)}</pre>
          <h3>{receipt.source === 'pharmcat-run' ? 'Generated report preview' : 'Original file preview'}</h3>
          <pre>{rawFilePreview}</pre>
          <h3>Engine result preview</h3>
          <pre>{rawResultPreview}</pre>
        </details>
      </div>

      <div className="page-action"><button type="button" className="secondary-button" onClick={downloadBundle}>Download run record</button></div>
    </section>
  )
}

export function ValidationConsole() {
  const [tab, setTab] = useState<TabId>('file')
  // Defaults to the mode that works without a backend. Genome upload needs the private
  // worker; opening on it meant the first thing a new visitor saw was a failing run.
  const [mode, setMode] = useState<InputMode>('example')
  const [exampleId, setExampleId] = useState(OFFICIAL_PHARMCAT_EXAMPLES[0].id)
  const [medicines, setMedicines] = useState('')
  const [noCurrentMedicines, setNoCurrentMedicines] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<SelectedFile | null>(null)
  const [inspection, setInspection] = useState<InputInspection | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [selectedDrug, setSelectedDrug] = useState('')
  const [lifestyleProductConfirmed, setLifestyleProductConfirmed] = useState(false)
  const [routine, setRoutine] = useState<RoutineAnswers>({ ...EMPTY_ROUTINE })
  const [clinicalReview, setClinicalReview] = useState<ClinicalReviewResult | null>(null)
  const [status, setStatus] = useState<RunStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const example = useMemo(
    () => OFFICIAL_PHARMCAT_EXAMPLES.find((item) => item.id === exampleId) ?? OFFICIAL_PHARMCAT_EXAMPLES[0],
    [exampleId],
  )

  const resetResult = () => {
    setResult(null)
    setReceipt(null)
    setSelectedDrug('')
    setLifestyleProductConfirmed(false)
    setRoutine({ ...EMPTY_ROUTINE })
    setClinicalReview(null)
    setError(null)
    setStatus('idle')
    setTab('file')
  }

  const chooseMode = (nextMode: InputMode) => {
    setMode(nextMode)
    setUploadedFile(null)
    setInspection(null)
    setNoCurrentMedicines(false)
    resetResult()
    if (nextMode === 'example') {
      setMedicines(example.suggestedMedications.join(', '))
    } else {
      setMedicines('')
    }
  }

  const chooseExample = (nextExample: OfficialPharmCATExample) => {
    setExampleId(nextExample.id)
    setMedicines(nextExample.suggestedMedications.join(', '))
    setNoCurrentMedicines(false)
    resetResult()
  }

  const changeMedicines = (value: string) => {
    setMedicines(value)
    if (value.trim()) setNoCurrentMedicines(false)
    if (result || receipt) resetResult()
  }

  const confirmNoCurrentMedicines = (confirmed: boolean) => {
    setNoCurrentMedicines(confirmed)
    if (confirmed) setMedicines('')
    if (result || receipt) resetResult()
  }

  const readFile = async (file: File) => {
    resetResult()
    setStatus('reading')
    try {
      if (mode === 'genome') {
        setUploadedFile({ file, contents: null })
        setInspection(null)
        setStatus('idle')
        return
      }
      const contents = await file.text()
      const checked = await inspectGenomeInput(file.name, contents)
      setUploadedFile({ file, contents })
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
      const selectedAssay: AssayType = 'unknown'
      let source: RunReceipt['source']
      let runManifest: PharmCATRunManifest | undefined

      if (mode === 'example') {
        const response = await fetch(example.reportUrl, { cache: 'no-store' })
        if (!response.ok) throw new Error(`PharmCAT's example server returned HTTP ${response.status}. No substitute data was used.`)
        contents = await response.text()
        fileName = new URL(example.reportUrl).pathname.split('/').at(-1) ?? 'pharmcat-example.report.json'
        sizeBytes = new Blob([contents]).size
        source = 'official-example'
        checked = await inspectGenomeInput(fileName, contents)
      } else if (mode === 'report') {
        if (!uploadedFile || !inspection) throw new Error('Choose a file first.')
        if (uploadedFile.contents === null) throw new Error('The report could not be read.')
        fileName = uploadedFile.file.name
        contents = uploadedFile.contents
        sizeBytes = uploadedFile.file.size
        source = 'uploaded-report'
        checked = inspection
      } else {
        if (!uploadedFile || !isVcfFile(uploadedFile.file)) throw new Error('Choose a single-person VCF or VCF.GZ file first.')
        const completed = await runGenome(uploadedFile.file, {
          inputFormat: isVcfGzipFile(uploadedFile.file) ? 'vcf-gzip' : 'vcf',
          genomeBuild: 'GRCh38',
          onStatus: (event: PharmCATRunProgress) => {
            setStatus(event.phase === 'uploading' ? 'uploading' : event.phase === 'analysing' ? 'analysing' : 'running')
          },
        })
        fileName = uploadedFile.file.name
        contents = JSON.stringify(completed.report)
        sizeBytes = uploadedFile.file.size
        source = 'pharmcat-run'
        runManifest = completed.manifest
        checked = await inspectGenomeInput(`${fileName}.pharmcat.report.json`, contents)
      }

      if (checked.status === 'blocked') {
        throw new Error(`We could not safely read this file${checked.blockingCode ? ` (${checked.blockingCode})` : ''}. We did not guess the missing data.`)
      }
      if (!checked.canRunAnalysis || checked.kind !== 'pharmcat-report-json') {
        throw new Error('This file needs a successful official PharmCAT run before it can produce gene or medicine results.')
      }

      const adapter = new PharmCATReportJsonAdapter()

      const medicineCheck = parseMedicines(medicines)
      if (medicineCheck.unrecognised.length > 0) {
        throw new Error(`Medicine not recognised: ${medicineCheck.unrecognised.join(', ')}. Fix or remove it before checking the result.`)
      }
      if (!currentMedicinesResolved(medicines, noCurrentMedicines)) {
        throw new Error('Add current medicines and supplements, or confirm that you take none.')
      }
      const currentMedications = medicineCheck.recognised
      const analysis = await runAnalysis({
        adapter,
        genome: {
          fileName,
          contents: checked.normalizedContents,
          assayType: selectedAssay,
          ...(runManifest ? { verifiedRunManifest: runManifest } : {}),
        },
        input: {
          genomeFileName: fileName,
          assayType: selectedAssay,
          currentMedications,
          pastTrials: [],
          careContext: BASE_CARE_CONTEXT,
          confirmedLifestyle: {},
        },
      })

      setReceipt({
        ...checked,
        ...(runManifest ? {
          sha256: runManifest.input.sha256,
          warnings: [],
          transformations: [],
          genomeBuild: runManifest.input.genomeBuild,
        } : {}),
        source,
        fileName,
        sizeBytes,
        contents,
        assayType: selectedAssay,
        runManifest,
        exampleId: mode === 'example' ? example.id : undefined,
        sourceUrl: mode === 'example' ? example.reportUrl : undefined,
      })
      setResult(analysis)
      setSelectedDrug('')
      setLifestyleProductConfirmed(false)
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
    setLifestyleProductConfirmed(false)
    setRoutine({ ...EMPTY_ROUTINE })
    setClinicalReview(null)
    setTab('daily')
  }

  const tabs: Array<{ id: TabId; label: string; disabled: boolean }> = [
    { id: 'file', label: 'DNA', disabled: false },
    { id: 'genes', label: 'Gene results', disabled: !result },
    { id: 'medicines', label: 'Medicines', disabled: !result },
    { id: 'daily', label: 'Daily life', disabled: !result },
    { id: 'ai', label: 'AI review', disabled: !result },
    { id: 'evidence', label: 'Sources', disabled: !result },
  ]

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><strong>Antidepressant PGx</strong></div>
      </header>


      <nav className="tab-bar" role="tablist" aria-label="Product steps">
        {tabs.map((item) => (
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
            <strong>{item.label}</strong>
          </button>
        ))}
      </nav>

      <div id={`${tab}-panel`} role="tabpanel">
        {tab === 'file' && (
          <FilePanel
            mode={mode}
            onMode={chooseMode}
            example={example}
            onExample={chooseExample}
            medicines={medicines}
            onMedicines={changeMedicines}
            noCurrentMedicines={noCurrentMedicines}
            onNoCurrentMedicines={confirmNoCurrentMedicines}
            uploadedFile={uploadedFile}
            inspection={inspection}
            status={status}
            error={error}
            onFile={(file) => void readFile(file)}
            onRun={() => void run()}
          />
        )}
        {tab === 'genes' && result && receipt && <GenesPanel result={result} runManifest={receipt.runManifest} onNext={() => setTab('medicines')} />}
        {tab === 'medicines' && result && <MedicinesPanel result={result} onExplore={openDailyLife} />}
        {tab === 'daily' && result && (
          <DailyLifePanel
            result={result}
            selectedDrug={selectedDrug}
            onSelectedDrug={(drug) => { setSelectedDrug(drug); setLifestyleProductConfirmed(false); setRoutine({ ...EMPTY_ROUTINE }); setClinicalReview(null) }}
            productConfirmed={lifestyleProductConfirmed}
            onProductConfirmed={(confirmed) => { setLifestyleProductConfirmed(confirmed); setRoutine({ ...EMPTY_ROUTINE }); setClinicalReview(null) }}
            routine={routine}
            onRoutine={(nextRoutine) => { setRoutine(nextRoutine); setClinicalReview(null) }}
            onNext={() => setTab('ai')}
          />
        )}
        {tab === 'ai' && result && receipt && <AiReviewPanel result={result} selectedDrug={lifestyleProductConfirmed ? selectedDrug : ''} routine={routine} review={clinicalReview} attestedRunId={receipt.source === 'pharmcat-run' ? receipt.runManifest?.runId ?? null : null} onReview={setClinicalReview} />}
        {tab === 'evidence' && result && receipt && <EvidencePanel result={result} receipt={receipt} selectedDrug={selectedDrug} productConfirmed={lifestyleProductConfirmed} routine={routine} review={clinicalReview} />}
      </div>
    </main>
  )
}
