# Antidepressant PGx validator

> **PharmCAT result in → gene results → medicine guidance → daily-life facts → bounded AI review → evidence**

This is a validation app for antidepressant pharmacogenomics. It helps a patient understand
what their result says and prepare questions for a prescriber. It does not prescribe, diagnose
depression, predict which antidepressant will work, or declare a medicine safe.

## Run it

```bash
npm ci
npm run dev
npm test
npm run build
```

The **Official example** button downloads a real example Reporter JSON from PharmCAT. If that
download fails, the app stops and shows the error. It does not replace it with a local success
case.

You can also upload a PharmCAT Reporter JSON. A VCF or consumer DNA file can be recognised and
inspected, but it cannot produce gene or medicine results in the browser. It must first pass
through the full official PharmCAT pipeline. No reduced marker caller remains in the clinical
flow.

## The app

1. **File** — load the official example or a PharmCAT Reporter JSON.
2. **Genes** — translate supported PharmCAT calls into plain English.
3. **Medicines** — show the exact imported CPIC recommendation for each supported medicine.
4. **Daily life** — compare one medicine's sourced food, timing and warning facts with the
   person's routine.
5. **AI review** — ask MedGemma to connect run-derived facts and identify conflicts, gaps and
   prescriber questions.
6. **Evidence** — inspect the input, versions, exact rules, sources, limitations and AI audit.

The first five views stay short. Technical details remain available under **Details** and
**Evidence**.

## What creates each result

| Result | Source of truth |
| --- | --- |
| File type | Deterministic content checks |
| Gene call and phenotype | Imported PharmCAT Reporter JSON |
| Gene-based medicine guidance | Exact CPIC annotation imported by PharmCAT |
| Current-medicine enzyme effect | Versioned deterministic interaction data |
| Food, timing and warnings | Draft cached summaries of selected US medicine-label facts |
| AI review | MedGemma over run-derived facts, then schema and fact-ID validation |
| Prescription | Patient and clinician; never this system |

Missing or uncertain evidence stays missing or uncertain. The app does not guess a genome
build, missing allele, CYP2D6 structure, recommendation, source or model response.

## The AI boundary

For the official example, the browser can send a small derived-fact object to the same-origin
`POST /api/clinical-review` gateway. Raw genome data and direct identifiers are excluded. The
gateway uses Vercel OIDC and Google Workload Identity Federation to call a private Vertex AI
MedGemma endpoint without a stored service-account key.

The model can connect gene, medicine, interaction and routine facts created by the current
run; point out missing information; and request a prescriber question or deterministic
rerun. It cannot write the medical explanation shown to the user. It returns only a typed
action and exact fact/source IDs; deterministic code renders those facts. It cannot create or
alter a gene call, dose, CPIC action, label fact or source. Authentication failure, timeout,
upstream failure or invalid JSON is shown as failure; there is no repair or fallback
narrative.

The gateway code is implemented, but a model is not deployed by this repository. An operator
must deploy `google/medgemma-27b-text-it` in Vertex AI Model Garden and configure the listed
environment variables before the AI review can run. Until then the app says that AI is not
configured.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Vercel and Google Cloud setup.

## Evidence status

- The official example is fetched from PharmCAT and is labelled with its reported PharmCAT
  and data versions.
- Uploaded Reporter JSON can drive the deterministic validation flow when its structure is
  recognised. The browser does not prove who produced it or whether it belongs to a governed
  run. Reporter JSON alone also does not prove assay coverage, so coverage remains unknown
  without the separate missing-position artefact. AI review is disabled for an uploaded
  report until a server-authoritative run manifest exists.
- CYP2D6 remains unresolved unless the provenance and structural/copy-number-aware outside
  call are independently validated. `callSource=OUTSIDE` is provenance, not proof.
- Daily-life facts are draft cached summaries of selected US label content. They are useful
  for testing the matching flow, but must be checked against exact, versioned source text and
  formulation before clinical release.
- The Australian antidepressant list is draft scope only. It does not drive results until
  its ARTG, PBS and Australian PI/CMI evidence is reconciled and versioned.
- Raw-genome processing still needs the private Cloud Storage + Cloud Run PharmCAT service
  described in [DEPLOYMENT.md](DEPLOYMENT.md).

This is a system-validation build, not a clinical product. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the complete boundary in plain language.
