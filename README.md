# MERIDIAN

**Genome in → gene results → medicine guidance → daily instructions → constrained AI check → sources.**

PharmCAT is the bioinformatics engine underneath the product. It is not the product screen and
the normal user does not upload a PharmCAT report. The normal input is a single-person GRCh38
VCF or VCF.GZ. Importing an existing PharmCAT Reporter JSON remains available under **Other ways
to start** for expert inspection only.

## How it works

1. The browser uploads the genome directly to a private, run-specific Cloud Storage session.
   Raw DNA does not pass through Vercel or the medical model.
2. A private Cloud Run worker checks the file, runs the pinned official PharmCAT pipeline and
   seals the input hash, command, software versions, coverage and output hashes in a run manifest.
3. Deterministic code reads the exact PharmCAT gene calls and matched CPIC annotations. It does
   not ask a model to invent a gene, medicine or dose.
4. The app groups those source results into plain English: discuss another medicine, review the
   dose, or no gene-based starting change.
5. After a medicine is selected, the app shows only drug-specific daily facts supported by a
   pinned prescribing-information record. A routine match is disabled until the exact product and
   form are confirmed, and it uses only answers the person actually supplied.
6. MedGemma may review a completed, session-owned run for conflicts, evidence gaps, lifestyle
   constraints and useful clinician questions. It returns fact IDs and typed actions, not medical
   prose. Invalid or invented references are rejected.

Genetics can change exposure and dosing. It does not reliably predict which antidepressant will
improve depression. The system does not diagnose, prescribe, declare a medicine safe, or tell a
patient to start, stop or change treatment.

## What is real and repeatable

- Patient results are never hardcoded and no failure is replaced by a demo result.
- Raw VCF processing uses the official PharmCAT tool in a pinned wrapper image.
- Missing positions are not treated as reference calls.
- CYP2D6 is withheld unless a validated structural and copy-number-aware outside call is added.
- Medicine rows come from the uploaded run's PharmCAT annotations, not a fixed shortlist.
- Clinical rules are versioned source releases with exact source IDs, revisions and digests.
- An official PharmCAT example is available for UI inspection, but it is clearly separate from a
  private genome run and cannot use the medical model.
- A failed upload, PharmCAT run, source check or model response remains a visible failure.

## Data used

| Data | Purpose | Sent to MedGemma? |
| --- | --- | --- |
| Raw GRCh38 VCF/VCF.GZ | PharmCAT calling only | Never |
| PharmCAT Reporter output and coverage | Gene and medicine results | Derived facts only |
| Exact PharmCAT/CPIC annotation | Dose and medicine-choice guidance | Source-bound fact only |
| Current medicines | Deterministic enzyme and interaction context | Canonical names only |
| Selected medicine and answered routine fields | Drug-specific daily-life check | Yes |
| Direct identifiers | Not required | Never |

The current daily-life release uses pinned US Structured Product Label records. The Australian
medicine list in this repository is scope data only; Australian PI/CMI, ARTG and PBS evidence must
be reconciled before an Australian clinical release.

## Exact demo uploads

Use the two public PharmCAT example artefacts for different checks:

Both are byte-for-byte pinned copies of [official PharmCAT Example 1](https://pharmcat.clinpgx.org/examples/).

| File | Upload location | What it validates |
| --- | --- | --- |
| [`public/samples/pharmcat-example.vcf`](public/samples/pharmcat-example.vcf) | **DNA → Choose DNA file** | Official Example 1: one GRCh38 sample with all-reference PGx sites. Runs the real private PharmCAT path. CYP2D6 is correctly withheld because this upload has no validated structural/copy-number outside call. |
| [`public/samples/pharmcat-example.report.json`](public/samples/pharmcat-example.report.json) | **DNA → Other ways to start → Import PharmCAT report** | Official published result containing a separate outside CYP2D6 call. Tests deterministic Reporter JSON parsing and the validation UI, but does not rerun PharmCAT or prove upstream coverage. |

Both files are downloadable from the matching upload screen. After choosing a file, enter recognised
current medicines or select **I take none**. The built-in **Use published example** path is a third,
no-upload UI demo and is kept separate from a governed genome run.

Pinned file digests:

```text
VCF     f45cc947fa0a38f47307ae5f2cc6e71bf5afffa6f1310b043b962c472db76438
Report  affc3223bfaf9176b71e62b5d8926815079228b7f5abb7265bc41fb3e5adf898
```

## Run the app

```bash
npm ci
npm test
npm run build
npm run dev
```

The published example works in the local Vite app. A real raw-genome run also needs the private
Google Cloud services and same-origin Vercel routes described in [DEPLOYMENT.md](DEPLOYMENT.md).

Backend checks:

```bash
npm test --prefix services/pharmcat-control
(cd services/pharmcat-worker && go test ./...)
```

Refresh the FDA source release explicitly:

```bash
node scripts/sync-clinical-sources.mjs
```

That command fails if a pinned record or reviewed evidence phrase is no longer present. Updated
JSON must be reviewed and committed; runtime results never depend on a live FDA API response.

## Deployment status

| Part | Repository | Live service |
| --- | --- | --- |
| Simple six-step app | Implemented | Deploy to Vercel |
| Private upload/control API | Implemented | Deploy to Cloud Run + Vercel |
| Pinned PharmCAT worker | Implemented | Build and deploy as a Cloud Run Job |
| Deterministic clinical engine | Implemented | Runs with the app/API |
| Constrained MedGemma gateway | Implemented | IAM-protected Vertex endpoint still required |
| Australian evidence release | Not complete | Must not be presented as complete |

The model endpoint and Google Cloud workload are deliberately not created by running this repo:
they use billable infrastructure and require operator identity, access and region decisions.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system in plain language and
[DEPLOYMENT.md](DEPLOYMENT.md) for the Vercel and Google Cloud setup.
