# Meridian — PGx + lifestyle agent for antidepressant prescribing

A working prototype. Ingests a genome file, current medications and past antidepressant
trials, and returns two views of the same analysis: a plain-language one for the person
taking the medicine, and a dense cited one for their prescriber.

```bash
npm install
npm run dev      # http://localhost:5199
npm test         # 20 engine tests, including the claim-boundary cases
```

The demo patient is preselected. Press the button.

---

## The rule this is built around

> The model never generates a dose, a drug recommendation, or a clinical fact.
> Clinical facts come from deterministic lookups. The model orchestrates, cross-references,
> explains and translates.

This is enforced structurally rather than by prompt. The pipeline runs six deterministic
steps that fix every clinical fact, and only then hands those fixed facts to a narrative
layer. Everything that layer writes passes through a validator before it can render:

1. Every number in the prose must already appear in the structured clinical input.
2. Every drug name in the prose must already appear in the structured clinical input.
3. Every citation attached must be one the engine actually emitted.
4. A sentence making a clinical assertion with no citation at all is dropped.

Violations are dropped at sentence granularity and written to a rejection log that the UI
renders as a product surface — because "our LLM can't hallucinate a dose" is a claim, and a
safety claim should be inspectable rather than asserted.

The number check is unit-aware. A guideline saying "a 50% reduction" does not license the
model to write "50 mg"; a value carrying a clinical unit must match a value carrying the
same unit in the source. `src/engine/validator.ts` is about 250 lines and is the file to
read first.

---

## What is actually novel here

PharmCAT already turns a VCF into star alleles into CPIC recommendations, and it does that
better than we could. It is genotype-only, one drug at a time, clinician-jargon, and has no
concept of what else the patient is taking. The contribution is the reasoning layer above it.

**Phenoconversion.** Functional phenotype = genetic activity modified by concurrent
inhibitors. The demo patient is a genetically normal CYP2D6 metaboliser who is functionally
a poor metaboliser because they take fluoxetine. Both phenotypes are always shown together.

**Inverted query.** PharmCAT answers "is drug X safe for this genotype?". This answers "given
everything about this person, what should they be given?", ranked over the whole candidate
set, using the functional phenotype rather than the genetic one — because tolerability in
the first weeks decides whether someone stays on a drug, and in those weeks the interacting
medication is still on board.

**Confidence scoring.** CYP2C19 calls cleanly from array data. CYP2D6 does not — copy number,
duplications and CYP2D6-CYP2D7 hybrids are invisible to a SNP array, so a phenotype can be
confidently wrong. That becomes a per-gene trust score which the ranking engine consumes:
when a gene call is shaky, drugs that do not depend on that gene are actively preferred.

**Treatment-history reconstruction.** For each past trial, is what happened consistent with
this person's metabolism? The answer is allowed to be no, and in the demo it is no for one of
the two failures.

**Lifestyle protocol.** Label-sourced timing, food and interaction rules fused with the
patient's other medications. Critical items render red, pinned, and cannot be collapsed.

**Dual-view translation.** The patient and clinician narratives are written separately rather
than one being a rewrite of the other, so the patient-facing page never says "this patient".

### Two additions beyond the brief

**Inhibitor persistence.** Stopping fluoxetine does not restore CYP2D6 that week —
norfluoxetine has a long half-life, so the functional poor-metaboliser state persists into
the switch. Rows carry both a "starting today" and an "after washout" verdict. A cross-taper
planned as though the interaction ends with the last tablet will misjudge the dose.

**Pharmacological equivalence.** Offering citalopram to someone who just failed escitalopram
looks like a switch and is not one — escitalopram is the active enantiomer of citalopram.
Failed-trial equivalents are demoted and the reason is stated.

---

## Three things it deliberately refuses to do

**It does not predict efficacy.** Genetics answers what dose, which drug is enzyme-safe, will
this seriously harm them, and why past trials failed. It does not answer which antidepressant
will lift the depression, and the report says so in both views.

**It does not use SLC6A4 or HTR2A.** CPIC 2023 reviewed both and issued no recommendation.
If a genome contains them they render in a greyed "reviewed — not clinically actionable"
panel with the citation, and are used nowhere.

**It does not invent a phenoconversion method where none exists.** This one is a deliberate
departure from the original brief, which specified a tier step-down for all enzymes. CPIC
states verbatim that *"consensus approaches for adjusting CYP2D6, CYP2C19, or CYP2B6
predicted phenotypes in the presence of inhibitors or inducers have not been established."*
A validated method exists for CYP2D6 only — CPIC operationalises the activity-score
multiplier in its own guidelines. So the engine converts CYP2D6 and, for CYP2C19 and CYP2B6,
raises a prominent unresolved-interaction warning instead of quietly stepping the tier down.

This matters more than it looks. The demo patient takes fluoxetine, which the FDA classifies
as a strong inhibitor of **both** CYP2D6 and CYP2C19. Applying the brief's rule would have
produced a confident "CYP2C19: Poor Metabolizer" with no guideline behind it — the exact
failure mode this product exists to prevent, one layer below where anyone would look for it.

---

## Architecture

Vite + React + TypeScript. The engine runs in the browser: it is deterministic, needs no
secrets, and nothing about the patient leaves the device.

```
src/
  engine/
    validator.ts        the claim boundary — read this first
    phenoconversion.ts  extension 1
    ranking.ts          extension 2
    confidence.ts       extension 3
    history.ts          extension 4
    lifestyle.ts        extension 5
    orchestrator.ts     the only model-touched step, plus the adversarial probe
    pipeline.ts         wires it together and emits the trace the UI renders
    pharmcat/
      adapter.ts        PharmCATAdapter interface + reduced tag-SNP caller
      fixtures.ts       known-diplotype fixtures
  data/
    sources/            captured CPIC and openFDA source data, as retrieved
    cpic.ts             guideline lookup
    interactions.ts     FDA inhibitor/inducer classifications
    lifestyle-rules.ts  curated, corrected protocol rules
    citations.ts        every source; unknown ids throw rather than render
scripts/run-pharmcat.sh real PharmCAT via Docker
```

### The narrative layer, honestly described

Offline is the default, and offline composes the narrative deterministically from the same
fact objects a model would receive. That prose still passes through the validator — a
template that bypassed the check would make the architecture decorative.

The rejection log is populated by `adversarialProbe`, which submits realistic model failure
modes to the same validator: an invented starting dose, a response rate nobody measured, a
drug never in the patient's data, a citation drifted to the wrong guideline, and a bare
clinical assertion. The UI labels this as exactly what it is. Swapping in a live model means
replacing `composeNarrative`; the validator and everything downstream are unchanged.

### PharmCAT

`FixturePharmCATAdapter` is the demo path so a demonstration cannot fail on live variant
calling. `TagSnpAdapter` is a genuinely functional but deliberately reduced caller for an
uploaded 23andMe export or VCF — it reads the tag SNPs consumer arrays actually carry and
reports everything it could not see. It is not PharmCAT and does not pretend to be; the
confidence layer marks it down accordingly. `scripts/run-pharmcat.sh` runs the real thing.

Each fixture also downloads as a 23andMe-format file, so the upload path can be tested for
real rather than described. GRCh38 coordinates were read from PharmCAT's shipped
`pharmcat_positions.vcf`.

---

## On the source data

Guideline rows in `src/data/sources/` were extracted from the CPIC-hosted publication PDFs
and openFDA's label API, then put through an adversarial verification pass against the
primary sources. That pass found real errors, and they are fixed here rather than shipped:

- Intermediate-metaboliser rows coded as "decrease" actually read *"initiate therapy with
  recommended starting dose"* — CPIC states existing data do not support adjusting starting
  doses for intermediate metabolisers. Rendering them as a dose reduction would tell someone
  a drug is harder to start than it is. They are now a distinct action.
- Several tyramine figures in the MAOI diet rules could not be traced to the source they
  cited and were corrected; the restriction list follows current quantity-aware guidance
  rather than the historical blanket version.
- The lithium toxicity symptom list now matches the label's own wording.
- The fluoxetine insomnia figure was a composite category presented as a single-symptom rate.

Verification notes are in the source JSON alongside the data.

---

## Limitations worth stating

- The tag-SNP caller covers six variants. Real deployment uses PharmCAT.
- The validator's drug detection is lexicon-bound: a drug name outside the lexicon would not
  be recognised as a drug. Broadening the lexicon strictly increases what gets caught.
- Past trials are evaluated against the genetic phenotype, because we do not know what else
  the patient was taking at the time. This assumption is stated wherever it is used.
- No efficacy prediction, by design.

**Decision support only. Not a diagnosis.**
