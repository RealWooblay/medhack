# System architecture

## What we are offering

This product turns a person's DNA into practical, evidence-backed preparation for an antidepressant
appointment.

It answers four useful questions:

1. **Does my metabolism create a clear problem for any supported antidepressant?**
2. **Does the guideline suggest a dose or titration discussion?**
3. **What does the selected medicine require in daily life?**
4. **What information, conflict or question should be taken to the prescriber?**

It does not predict which antidepressant will relieve depression. It does not prescribe. The
clinician still chooses the medicine and dose.

```text
DNA + current medicines
        ↓
metabolizer results
        ↓
medicine-level guidance
        ↓
daily instructions for the selected medicine
        ↓
verified review points for the prescriber
```

## What the person receives today

- A small number of relevant gene results translated into normal English.
- Medicine-level results grouped as **discuss another medicine**, **review the dose**, or **usual
  starting dose**.
- The exact source rule and original guideline wording behind every medicine result.
- Food, timing, alcohol, driving and other available instructions for one selected source product.
- A complete evidence record showing the input, coverage, calculations, versions and sources.

The AI review is not available in the public example or Reporter-import journey. It requires a real,
completed private DNA run and a deployed model endpoint.

## Who does what

| Part | Plain-English job | What it is not allowed to do |
| --- | --- | --- |
| Patient | Supplies DNA, current medicines and confirmed daily-life information | Does not need to interpret a PharmCAT report |
| Private worker | Checks the file and runs the pinned PharmCAT pipeline | Does not guess missing DNA |
| PharmCAT | Converts supported DNA evidence into gene versions, metabolizer results and matching guideline rows | Does not understand the person's life or choose treatment |
| CPIC | Supplies the expert gene–medicine prescribing rules used by PharmCAT | Does not predict whether treatment will work |
| Versioned interaction data | Identifies recorded medicines that may change enzyme activity | An absent medicine is not declared interaction-free |
| Product-label data | Supplies medicine-specific food, timing and safety instructions | Does not provide a generic wellness plan |
| Our fixed clinical engine | Joins the sources, filters to antidepressants, applies supported current-medicine context and translates the result | Does not invent a gene, dose or source |
| Reasoning model | Looks for useful relationships between facts already established by the system | Does not create clinical facts or change a result |
| Verifier | Rejects model output containing unknown facts, drugs, sources or actions | Does not repair or silently replace a failed answer |
| Clinician | Decides whether and how to prescribe | The product never takes this authority |

## The user journey

### 1. DNA

The normal input is one person's GRCh38 VCF or VCF.GZ plus recognised current medicines and
supplements. The raw file uploads to short-lived private storage and is never sent to the reasoning
model. An unrecognised medicine name stops the run until it can be resolved rather than being
silently ignored.

The system checks the genome build, sample count, file structure and required coverage. Unsafe file
or sample problems stop the run. Missing PharmCAT positions are measured and shown; depending on
which positions are missing, a gene can instead return an incomplete or indeterminate result. A
generic consumer-DNA text file is not currently accepted because changing columns into VCF is not
enough; the system must also prove strand, build and per-gene coverage.

### 2. Gene results

A tested, version-pinned worker runs official PharmCAT. PharmCAT reads the genetic evidence and
returns metabolizer results and matching prescribing-guideline rows.

The UI translates results such as “CYP2C19 poor metabolizer” into a short explanation of whether
medicines using that enzyme may be cleared more slowly or quickly. The original gene versions,
caller, coverage and sources remain available under **Sources**.

### 3. Medicines

The fixed engine turns the gene results into medicine-level outputs. A single gene can affect many
medicines, so medicine coverage matters more than the number of gene cards.

Medicines are grouped into:

- **Discuss another medicine**
- **Dose may need changing**
- **Usual starting dose**
- **No supported gene guidance**

Rows come only from this person's matched PharmCAT annotations, current antidepressants or recorded
past trials. The engine supports recorded past trials, but the current validation UI does not collect
them. There is no generated filler list and no efficacy ranking.

### 4. Daily life

After a medicine is selected, the app shows the available rules for one exact source product. These
may cover food, time of day, alcohol, driving or a supported interaction warning.

The app asks only routine questions connected to those rules. Unanswered questions remain unknown.
A personalised routine match is not created until the source product is confirmed.

The current evidence release contains 14 pinned US Structured Product Label records. Australian
PI/CMI evidence and formulation matching are not implemented yet, so this is not an Australian
clinical release.

### 5. AI review

The current AI component is a **one-shot constrained reviewer**, not yet an autonomous agent.

```text
fixed facts from a completed run
        ↓
model selects a relationship and exact fact IDs
        ↓
server rejects anything outside the allowed contract
        ↓
browser verifies it again
        ↓
fixed UI wording is shown
```

The model currently receives:

- derived gene and medicine facts;
- recognised current-medicine names;
- a selected medicine, if its source product was confirmed;
- explicitly answered routine fields; and
- source IDs and titles.

It does not receive raw DNA, variants, direct identifiers or permission to use its memory as a
clinical source.

The model may only:

- flag missing information;
- flag supplied facts that may need reconciliation;
- identify facts that should become a prescriber question;
- connect a sourced daily requirement to an answered routine field; or
- propose a typed deterministic rerun.

The current UI turns those selected facts into fixed sentences. The model does not write a free-text
clinical answer. A proposed counterfactual is displayed, but is **not executed yet**. An empty but
valid model result is also currently labelled as rejected instead of “nothing extra found”; that UX
and contract behaviour needs correction.

The validation UI also does not currently collect past-treatment history, symptoms, side effects,
adherence, clinician plans or week-by-week outcomes. This leaves the model with little to synthesise
and is why the present AI contribution is modest.

### Why the AI tab often appears inactive

All of the following are required before the **Run review** button can work:

1. A real raw-DNA run completed through the private PharmCAT service.
2. A session-owned verified run ID.
3. A configured same-origin model gateway.
4. A live authenticated model endpoint.

Public examples and imported Reporter JSON deliberately cannot call AI. The reviewed local
validation environment has no configured model endpoint. Opening the tab also does not run the
model automatically; the user must select **Run review**.

### 6. Sources

Sources is the proof layer. It contains the file hash, run manifest, full source-gene scope, gene
calls, exact guideline rows, product-label identity, routine calculation, model audit and run export.
The simple screens are views over this evidence; the evidence has not been removed.

## Why there are only three antidepressant genes

The supported prescribing genes are **CYP2C19, CYP2D6 and CYP2B6**. The current [CPIC serotonin
reuptake inhibitor guideline](https://files.cpicpgx.org/data/guideline/publication/serotonin_reuptake_inhibitor_antidepressants/2023/37032427.pdf)
supports using these results to inform antidepressant prescribing. Evidence for SLC6A4 and HTR2A
does not support clinical prescribing use, so adding them as extra cards would make the product look
bigger while making it less rigorous.

The official imported example contains 23 genes across all PharmCAT drug areas, but three are in this
antidepressant scope and those three produce matched guidance for 14 antidepressants. The full
23-gene source list remains visible under **Sources**.

The real raw-VCF path currently withholds CYP2D6 because CYP2D6 needs structural and copy-number-aware
calling that an ordinary VCF cannot reliably provide. Only CYP2C19 and CYP2B6 are eligible in the
current raw pipeline, and either can still be incomplete or indeterminate when coverage is
insufficient. This materially reduces medicine coverage. Adding a validated CYP2D6 caller is the
highest-priority clinical breadth improvement.

A normal result may also correctly say that no gene-based starting change is needed. The product
must not manufacture warnings to appear more powerful.

## What the AI should become

The valuable future agent is not a generic depression chatbot. It is a governed journey coordinator
with patient state and a small set of safe tools.

It should:

1. Ask the next useful missing question instead of presenting a long form.
2. Combine genes, current medicines, past trials, routine and the clinician's plan.
3. Request and execute deterministic counterfactuals after user approval.
4. Track symptoms, side effects, adherence and plan changes across the first 6–12 weeks.
5. Surface clinician or urgent-human alerts produced by fixed deterministic safety rules.
6. Produce a short, evidence-linked update for the next appointment.

The model can decide **which established facts need attention** and **which safe tool to call**. It
still cannot invent a dose, make a diagnosis or decide which medicine will work.

This governed evidence graph, longitudinal patient state, deterministic tool set and evaluation
suite—not the name of the foundation model—should be the AI moat.

## MedGemma or OpenAI

The architecture should be provider-neutral. The current code has a hard-wired MedGemma 27B Vertex
adapter, but no live endpoint is configured in the reviewed environment, the repository does not
provision one, and it contains no comparison showing that MedGemma is best for this task.

The present task is structured reasoning over supplied facts, not recalling medical knowledge. For
the next validation build, the recommended starting provider is [**OpenAI GPT-5.6
Sol**](https://developers.openai.com/api/docs/guides/latest-model.md) behind the same fact allow-list
and deterministic verifier. OpenAI's [Structured
Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) can enforce the typed
response shape at generation time; the product verifier must still check clinical grounding and
allowed actions. After establishing the quality baseline, GPT-5.6 Terra can be tested for a cheaper,
faster operating point.

[MedGemma 27B](https://developers.google.com/health-ai-developer-foundations/medgemma) remains a
serious comparison candidate when private GCP deployment, open weights or measured domain performance
is more important. Google explicitly describes MedGemma as a developer model that requires
use-case-specific validation; medical training does not make it automatically safe or accurate for
this product.

The final provider must be chosen using the same gold evaluation cases:

- correct fact linking;
- useful missing-question and conflict detection;
- valid counterfactual/tool requests;
- prohibited treatment-advice rate;
- invented fact, drug or source rate;
- schema/refusal/failure rate;
- clinician rating of usefulness;
- latency, cost, residency and retention requirements.

No real patient-derived facts should be sent to an external model until the required health-data
agreement, retention setting, region, access controls and privacy review are in place. Raw DNA is
never part of the model payload under either provider.

The verifier proves that returned references exist and are allowed. It does not prove that every
relationship between otherwise valid facts is clinically useful. Clinician-labelled semantic
evaluation is therefore required whichever model is used.

## What is implemented and what is not

| Capability | Current state |
| --- | --- |
| Reporter import and published example | Works in the local UI |
| Private raw-VCF pipeline | Implemented in the repository; cloud services still need deployment |
| CYP2C19 and CYP2B6 calling | Implemented in the governed raw path |
| CYP2D6 structural/copy-number calling | Not implemented |
| Medicine-level PGx grouping | Implemented from exact matched annotations |
| Current-medicine context | Implemented with a versioned, non-exhaustive FDA interaction release |
| Daily-life instructions | Implemented for 14 pinned US label products |
| Australian PI/CMI release | Not implemented |
| Constrained model contract and verifier | Implemented |
| Live AI provider | Not configured in the reviewed environment; not provisioned by the repository |
| Executable model-requested reruns | Not implemented |
| Past-treatment and depression-journey UX | Not implemented in this validation UI |
| Persistent patient state and weekly support | Not implemented |
| Production identity, deletion and regulatory controls | Not complete |

## Privacy and repeatability

- Raw DNA uploads directly to private short-lived storage.
- The model receives only a verified run ID and bounded patient context; the server rebuilds all
  clinical facts itself.
- Missing genome positions are not treated as normal/reference calls.
- Completed outputs are versioned and hash-checked.
- Clinical source releases are pinned and reviewed rather than fetched live during a patient run.
- Invalid pipeline or model output fails visibly; there is no fake-success fallback.

## Extension order

1. Add validated CYP2D6 SV/CNV calling.
2. Make the reasoning-model adapter provider-neutral and run the OpenAI-versus-MedGemma evaluation.
3. Deploy one model for a real end-to-end synthetic validation run.
4. Add formulation-specific Australian PI/CMI evidence.
5. Add past trials, baseline symptoms, side effects, adherence and clinician-plan records.
6. Add executable deterministic counterfactual tools and persistent journey state.
7. Add provider-specific consumer-genome adapters only when build, strand and coverage are proven.
8. Complete authentication, deletion, audit, security, clinical, human-factors and regulatory work.

## Hard boundary

The product can explain how supported genetics and known current medicines affect exposure, dosing
guidance and daily requirements. It cannot predict antidepressant efficacy, diagnose depression,
prescribe treatment or replace a clinician.

The repository contains a real processing path and explicit failures, not a fake patient success
path. After the private services are deployed, it is suitable for technical validation and bounded
clinical/source review; it is not ready for unsupervised patient use.
