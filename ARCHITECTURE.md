# System architecture

## The system in one line

```text
Genome → private PharmCAT run → fixed clinical engine → medicines → daily life → constrained AI check → sources
```

PharmCAT is the underlying gene-calling and guideline tool. The product adds the safe upload,
plain-English flow, current-medicine context, drug-specific daily-life check, constrained medical
model and complete run trace.

## The normal journey

### 1. Upload DNA

The normal input is one person's GRCh38 VCF or VCF.GZ. The raw file uploads directly to a private,
short-lived Cloud Storage session. It does not pass through Vercel and it is never sent to AI.

The system does not guess a genome build, strand or missing allele. A generic consumer DNA export
is rejected until a provider-specific converter and coverage policy have been validated. Converting
columns into VCF is easy; proving that the missing pharmacogenomic sites are safe to interpret is
the hard part.

### 2. Run PharmCAT

A private Cloud Run Job uses our small audited worker built on the pinned official PharmCAT image.
The worker:

- verifies one sample and GRCh38;
- checks compressed size, uncompressed size, record count and file structure;
- runs the official pipeline without treating missing positions as reference;
- records called and missing positions for each supported gene;
- removes CYP2D6 output unless a validated structural/copy-number-aware outside caller exists;
- seals input, command, image, version, coverage and output hashes in a final manifest; and
- returns no result if any required check fails.

The browser receives a restricted Reporter result and manifest. The original genome and unrestricted
report stay in private storage.

### 3. Build the result

Deterministic TypeScript reads the exact PharmCAT output. Medicine rows come only from:

- matched antidepressant annotations in that run;
- antidepressants the person says they currently take; and
- antidepressants in an explicitly supplied past-treatment record.

There is no fixed patient shortlist and no generated filler result. The app translates scientific
terms into short labels, but the original recommendation, genes, source URL and versions remain in
**Sources**.

### 4. Add current medicines

A dated FDA interaction release identifies known CYP2D6, CYP2C19 and CYP2B6 modifiers. Its own source
is non-exhaustive, so an absent drug means **not classified in this release**, never **no interaction**.

Only a named CYP2D6 research convention can produce a modelled activity estimate. That estimate is
kept beside the genetic call; it does not replace PharmCAT or create a dose. Ambiguous, opposing or
unsupported medicine combinations stay unresolved.

### 5. Check daily life

After a medicine is selected, the app loads its source-backed instructions: food, timing, alcohol,
driving or another supported warning. It asks only questions relevant to those instructions.
Unanswered questions remain unknown and cannot create a reassuring match. The UI identifies the
exact pinned label product and does not personalise a routine match until that product and form are
explicitly confirmed.

The current evidence release is 14 pinned US Structured Product Label records with exact reviewed
text anchors. It is not an Australian PI/CMI release and it does not yet capture formulation in the
user input. Those are release blockers, not details for AI to fill in.

## What the medical model does

MedGemma is a constrained cross-fact reviewer. It is not a chatbot and it is not the clinical
calculator.

```text
completed session-owned run
        +
confirmed patient context
        ↓
server rebuilds allowed facts
        ↓
MedGemma returns typed actions + known fact IDs
        ↓
schema, fact, drug and source verifier
        ↓
accepted fact-linked review OR visible rejection
```

The browser sends a run ID, selected medicine, recognised current medicines and explicitly answered
routine fields. The server reloads that run from the private service and independently rebuilds the
model context. The browser cannot supply gene facts, dose text, citations, prompts, model names or an
upstream URL.

Allowed model actions are:

- identify an evidence gap;
- identify a conflict between supplied facts;
- prepare a precise clinician question;
- connect a sourced daily-life requirement to a confirmed routine answer; or
- request a deterministic counterfactual rerun.

The model cannot call a variant, choose or rank treatment, predict efficacy, calculate a dose, write
patient medical advice, or change an existing result. Unknown IDs, extra fields, invalid JSON,
timeouts and provider errors are rejected. There is no repair prompt and no fallback answer.

Public examples and imported Reporter files cannot use AI because they do not have a session-owned,
server-verified run.

## Authority for every output

| Output | Authority |
| --- | --- |
| File acceptance | Worker validation rules |
| Gene/diplotype/phenotype | Pinned official PharmCAT run |
| Gene coverage | PharmCAT preprocessor and missing-position artefact |
| Medicine guidance | Exact matched PharmCAT/CPIC annotation |
| Current-medicine effect | Versioned FDA CYP interaction release |
| Daily instruction | Exact evidence in a pinned product label |
| Lifestyle match | Deterministic rule + an answered patient field |
| AI review | Verified links between the above fixed facts |
| Prescription | Clinician, never this system |

## Privacy and repeatability

- Raw DNA uploads directly to private storage.
- Storage paths are bound to a random browser session and run ID.
- Vercel calls the private control service through workload identity; no service-account key is
  stored in the app.
- Each object is generation-locked and each completed output is hash-checked.
- Source releases are committed and reviewed, so an API change cannot silently change a patient
  result.
- API responses are private and non-cacheable.
- A production patient release still needs real user authentication, retention/deletion policy,
  audit access, rate limits and security/privacy review.

## How to extend it safely

1. **Consumer files:** add one provider/version adapter at a time, with known build, strand, manifest
   and per-gene coverage tests. Never use a generic converter.
2. **CYP2D6:** add a separately validated SV/CNV caller, preserve its full run evidence, and supply
   the outside call to PharmCAT.
3. **Australian daily-life evidence:** ingest formulation-specific TGA PI/CMI records, store exact
   source/version anchors and make formulation a required input where rules differ.
4. **More medicines:** add vocabulary, exact source ingestion, deterministic tests and reviewed
   plain-English wording. A prompt cannot add clinical scope.
5. **More AI actions:** add one typed action, allow-list and adversarial evaluation at a time. A
   counterfactual must rerun deterministic code before anything is displayed.
6. **Depression journey:** add dated symptom, side-effect, adherence and clinician-plan records. Keep
   them separate from the genetic call and evaluate every summary against clinician review.

## Honest release boundary

The repository implements the real processing path; it does not contain a fake patient success path.
It is not yet ready for unsupervised patient use. The remaining clinical blockers are Australian and
formulation-specific daily-life evidence, validated CYP2D6 structural calling, user authentication,
privacy/security controls, clinical evaluation, human-factors testing and regulatory review.
