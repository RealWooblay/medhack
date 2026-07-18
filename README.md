# Antidepressant PGx validator

This prototype makes one clinical data chain easy to inspect:

> **Genome file → gene result → medicine guidance → daily-life facts → bounded AI review → evidence**

It is patient-initiated and clinician-facing. It helps a person prepare questions for their
prescriber. It does not choose an antidepressant, predict which medicine will improve
depression, prescribe, diagnose or prove that a medicine is safe.

## Run it

```bash
npm install
npm run dev
npm test
npm run build
```

## The six validation steps

1. **File** — use a fictional example or inspect an uploaded genome file.
2. **Genes** — see the supported gene results in plain English, with limitations together in
   one place.
3. **Medicines** — see the exact CPIC action for supported gene–medicine pairs. Medicines are
   grouped by the action to discuss, not ranked by likely benefit.
4. **Daily life** — choose one medicine and compare its label-backed timing, food and warning
   facts with the person's routine.
5. **AI Review** — inspect the bounded MedGemma role and connection state. A live review is
   shown only when an operator-controlled endpoint is connected; the app never fakes one.
6. **Evidence** — inspect the input, method, rules, sources, limitations and raw result.

The first five views use short language. Technical details remain available in **Evidence**.

## What decides each result

| Result | Authority |
| --- | --- |
| File type and build | Deterministic file checks |
| Variant, diplotype and phenotype | PharmCAT or another validated specialist caller |
| Gene-based medicine action | Versioned CPIC rule |
| Timing, food and labelled warning | Versioned regulator-approved medicine label |
| Plain-language layout | Reviewed templates, with optional bounded AI |
| Prescription | Patient and clinician; never automated |

The model never invents a gene call, dose, action, warning or source.

## File handling

File type is detected from the contents, not only the filename.

- A supported PharmCAT Reporter JSON can be imported with its limitations visible.
- VCF and consumer genotype files can be inspected locally.
- The fictional examples can run through the reduced six-variant prototype caller.
- [`examples/fictional-genome-demo.txt`](examples/fictional-genome-demo.txt) tests the real
  upload control and content-detection path.
- A real raw VCF or consumer file still needs a governed backend running a pinned official
  PharmCAT workflow before it can produce a reliable clinical result.
- Unknown build, missing allele, no-call and unsupported structure are never guessed.

The reduced caller is a software demonstration. It is not PharmCAT, does not resolve CYP2D6
structural variation and must not be used for patient care.

## The smart AI role

MedGemma is a bounded clinical journey agent over facts that the deterministic system has
already approved. Its useful jobs are to:

- ask for a missing allowed field when that field could change the interpretation;
- connect gene results, current medicines, treatment history and drug-specific daily-life
  constraints;
- request a typed “what if” calculation, which makes the deterministic engine rerun the full
  pipeline;
- arrange sourced daily-protocol facts around the person's stated routine;
- turn gaps and conflicts into clear questions for the prescriber; and
- later, summarise recorded symptoms, side effects, adherence and the clinician's plan over
  time.

It never receives the raw genome. It cannot create a dose or CPIC action, rank efficacy,
prescribe, diagnose, triage or settle a disagreement between sources. Its output must use the
approved schema and known fact IDs. Invalid output is rejected and shown as rejected.
Accepted model wording is kept for audit; the main screen renders reviewed fixed wording from
the validated action, fact IDs and typed rerun request.

The current repository includes the privacy-minimised review context, same-origin provider,
typed output contract and mechanical validator. A clinical AI service is not enabled by
default. Set `VITE_MEDGEMMA_ENDPOINT` to the path of an operator-controlled, same-origin
backend; `VITE_MEDGEMMA_MODEL` may override the default model name. These are endpoint
settings, not browser credentials. No model key belongs in the browser.

Before clinical use, the provider still needs server-side authentication, an agreed retention
policy, representative evaluation and clinical release review. The typed counterfactual
request also needs a production executor that reruns the whole deterministic pipeline before
any scenario result is displayed.

## Evidence status

- **Gene calls:** imported PharmCAT output, or the clearly labelled fictional prototype path.
- **Medicine actions:** captured, versioned CPIC tables.
- **Daily instructions:** cached US FDA label excerpts, labelled
  `US FDA LABEL — NOT AUSTRALIAN PI`.
- **Australian medicine scope:** a draft list exists in the repository but is not used in
  calculations until its CPIC, ARTG, PBS and Australian PI/CMI records are reconciled.

No source means no clinical statement should render.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the boundaries, current implementation and work
still required.
