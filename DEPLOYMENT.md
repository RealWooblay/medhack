# Deployment

## Production shape

Use Vercel for the Vite app and small same-origin API requests. Use Google Cloud for the two
medical workloads. The repository is ready for a protected validation deployment, not an
open patient-facing production release.

```text
Browser
  |-- app and /api/* ------------------------------> Vercel (Sydney)
  |     |-- derived facts only --------------------> Vertex AI MedGemma
  |     `-- upload/run/status control messages ----> Cloud Run API
  |
  `-- raw genome upload ---------------------------> private Cloud Storage
                                                       |
                                                       `-> pinned PharmCAT worker
                                                           -> private result object
```

There is no simulated provider, forced result or success fallback in this design. A missing
service, rejected model response, incomplete genome or failed PharmCAT run must remain a
visible failure state.

### Why PharmCAT is not a Vercel Function

Vercel Functions limit both request and response payloads to 4.5 MB. Whole VCF files can be
far larger, and a reproducible PharmCAT pipeline needs a container, temporary working space,
its missing-position artefact and an immutable run manifest. PharmCAT therefore belongs in a
pinned container on Google Cloud, not in the frontend host.

The deployed upload flow should be asynchronous:

1. `POST /api/pharmcat/uploads` authenticates the user, checks declared size/type and asks the
   private backend for a single-object, run-scoped resumable upload session.
2. The browser uploads the bytes directly to Cloud Storage. The session URL is a bearer
   credential and must never be logged or reused.
3. `POST /api/pharmcat/runs` sends only the opaque object ID to the Cloud Run control service.
4. A worker runs the pinned official PharmCAT image without any missing-to-reference flag.
5. `GET /api/pharmcat/runs/{id}` returns `queued`, `running`, `failed` or `complete`.
6. The browser receives a restricted Reporter JSON plus coverage, missing-position and run
   manifest data. Raw input and unrestricted reports are not returned through Vercel.

Do not accept the genome as JSON/base64, do not proxy it through a Vercel Function and do not
run PharmCAT synchronously while an HTTP request waits.

### MedGemma path

Deploy `google/medgemma-27b-text-it` from Vertex AI Model Garden as a private HTTPS endpoint.
If Vertex creates a dedicated public prediction endpoint, set
`MEDGEMMA_VERTEX_DEDICATED_DNS` to its returned `dedicatedEndpointDns` hostname only. Do not
copy an arbitrary URL from a client request into this setting.
The same-origin `POST /api/clinical-review` function sends only the already-derived fact
object. In this build, that route is enabled only for the live official example. It must:

- reject non-POST and non-JSON requests;
- reject unexpected top-level fields and bodies over the application limit;
- use the server-configured Vertex endpoint and model, ignoring any client attempt to choose
  an arbitrary upstream URL;
- use temperature zero and request JSON output;
- apply an upstream abort timeout shorter than the 60-second Vercel limit;
- return `Cache-Control: private, no-store`;
- never log prompts, genome-derived fact text, model output or credentials; and
- return an error when Vertex is unavailable. It must not manufacture an AI review.

Set the clinical-review application body limit to 256 KiB and its upstream abort timer to 45
seconds. Set PharmCAT control-message bodies to 32 KiB. Reject an over-limit body even when
`Content-Length` is missing or false; the declared header is only an early check. The raw-file
path has its own tested compressed size, uncompressed size, record and sample-count limits in
the Cloud Run service.

MedGemma is a developer model, not a clinically validated decision maker. Its output remains
inside the repository's schema, fact-ID and source-ID verifier. Do not deploy it as a generic
chat endpoint.

## Authentication between Vercel and Google Cloud

Use Vercel OIDC plus Google Cloud Workload Identity Federation. Do not store a Google service
account JSON key in Vercel.

In Vercel, use the recommended team-specific OIDC issuer. In Google Cloud:

1. Create a dedicated workload identity pool and OIDC provider for Vercel.
2. Map `google.subject` to `assertion.sub`.
3. Restrict the principal to the exact Vercel team, project and environment. Create separate
   bindings for Preview and Production.
4. Allow that principal to impersonate a dedicated service account.
5. Give the service account only the permissions its API route needs. Separate the MedGemma
   caller from the PharmCAT control service if possible.
6. Grant Cloud Run Invoker only on the PharmCAT control service. Keep that service private.

The non-secret identity settings are listed in `.env.example`. They are still server-only and
must not have a `VITE_` prefix.

After replacing the placeholders, the core Google Cloud setup is:

```bash
export PGX_GCP_PROJECT_ID="your-project-id"
export PGX_GCP_PROJECT_NUMBER="your-project-number"
export PGX_WIF_POOL_ID="vercel-pgx"
export PGX_WIF_PROVIDER_ID="vercel-pgx"
export PGX_VERCEL_TEAM="your-vercel-team-slug"
export PGX_VERCEL_PROJECT="your-vercel-project-name"
export PGX_VERCEL_SA="pgx-vercel@${PGX_GCP_PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PGX_GCP_PROJECT_ID"
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  aiplatform.googleapis.com run.googleapis.com storage.googleapis.com \
  artifactregistry.googleapis.com

gcloud iam workload-identity-pools create "$PGX_WIF_POOL_ID" \
  --location=global \
  --display-name="Vercel PGx"

gcloud iam workload-identity-pools providers create-oidc "$PGX_WIF_PROVIDER_ID" \
  --location=global \
  --workload-identity-pool="$PGX_WIF_POOL_ID" \
  --issuer-uri="https://oidc.vercel.com/${PGX_VERCEL_TEAM}" \
  --attribute-mapping="google.subject=assertion.sub"

gcloud iam service-accounts create pgx-vercel \
  --display-name="PGx Vercel caller"

gcloud iam service-accounts add-iam-policy-binding "$PGX_VERCEL_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/${PGX_GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${PGX_WIF_POOL_ID}/subject/owner:${PGX_VERCEL_TEAM}:project:${PGX_VERCEL_PROJECT}:environment:production"
```

Repeat the last binding for `environment:preview` only if Preview is allowed to reach a
separate non-production backend. Do not use a wildcard project or environment subject. Set
`GCP_AUDIENCE` to:

```text
https://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID
```

Grant endpoint prediction and Cloud Run invocation only after those resources exist. Prefer a
custom Vertex role containing only the required prediction permission; `roles/aiplatform.user`
is broader than this route needs.

## Vercel setup

### 1. Import the GitHub repository

Import the repository in Vercel and keep these settings:

```text
Framework preset: Vite
Build command: npm run build
Output directory: dist
Production branch: main
Function region: Sydney (syd1)
```

`vercel.json` records those settings, enables SPA deep links, prevents API response caching
and installs a restrictive browser security policy. Vercel checks the filesystem before the
SPA fallback, so files under `api/` continue to resolve as Functions.

Sydney is the validation default because the intended users and PharmCAT control plane are
Australian. Confirm that the chosen Vertex model-serving region meets the project's data
residency decision. If it does not, document the cross-region transfer of derived health facts
before enabling AI; moving the Vercel function alone does not solve data residency.

### 2. Add environment variables

Add the public build setting to Preview and Production:

```bash
vercel env add VITE_MEDGEMMA_ENDPOINT preview
vercel env add VITE_MEDGEMMA_ENDPOINT production
```

Use `/api/clinical-review` as its value. The browser cannot name the model. Set the exact
deployed model/revision in the server-only `MEDGEMMA_MODEL_ID` value from `.env.example`.

Add every server-only value from `.env.example` interactively. Mark credentials or sensitive
configuration as sensitive where the Vercel CLI supports it. Never paste a private key into a
`VITE_` variable.

After changing environment variables, create a new deployment; existing deployments do not
receive the new values.

### 3. Test a protected Preview deployment

```bash
npm ci
npm test
npm run build
npx vercel link
npx vercel dev
npx vercel
```

Keep Preview deployments behind Vercel Authentication. Validate all of these before promoting:

- `/` renders and a deep link returns the app, not a 404;
- an absent MedGemma endpoint is shown as not configured;
- a valid derived-facts request reaches the real Vertex endpoint;
- malformed model JSON is rejected rather than repaired;
- an upload larger than 4.5 MB goes directly to Cloud Storage;
- a missing or no-call position never becomes reference;
- a failed PharmCAT job is returned as failed, never as a partial result;
- API responses contain `Cache-Control: private, no-store`; and
- browser and server logs contain no genome, report, prompt, signed URL or model output.

### 4. Deploy production

Either merge the validated commit to `main` with the Vercel Git integration enabled, or run:

```bash
npx vercel --prod
```

Do not expose this build publicly or use real patient data. Keep the deployment behind Vercel
Authentication. Use a synthetic but biologically coherent VCF processed by the same pinned
PharmCAT container. Before patient use, add application authentication, server-authoritative
run records, per-run authorisation and rate limits, then complete privacy, security, clinical,
human-factors, regulatory and Australian data-residency reviews.

## Google Cloud services still required

The repository must contain deployable backend code before the following services can be
created. A URL or environment variable alone is not an implementation.

### PharmCAT service

Required components:

- private Cloud Storage input and output buckets with uniform bucket-level access;
- a bucket CORS rule restricted to the production app origin and the exact upload method and
  headers; never use `*` for an authenticated validation app;
- retention/lifecycle deletion rules and object versioning policy agreed before testing;
- a small authenticated Cloud Run control API;
- an asynchronous worker or Cloud Run Job that wraps the pinned official PharmCAT image;
- exact limits for compressed and uncompressed size, sample count and run time;
- SHA-256 input hash, image digest, PharmCAT/data versions, command arguments, timestamps,
  output hashes and terminal status in each run manifest;
- GRCh38 and coverage validation; and
- a separately validated structural/copy-number-aware CYP2D6 outside-call path.

The control API must never add `--missing-to-ref`, silently lift over an unknown build, infer
CYP2D6 from sparse SNP data or return a recommendation when the official run failed.

### Vertex MedGemma endpoint

Use the Model Garden deployment flow in the Google Cloud Console or the official deployment
notebook. Accept the Health AI Developer Foundations terms for the account/project first.
Endpoint creation provisions billable accelerator capacity. Record the model ID,
revision/weights, serving-container digest, machine/accelerator configuration, region and
deployment timestamp. Run the repository's adversarial and schema evaluation set against that
exact deployment before enabling `VITE_MEDGEMMA_ENDPOINT` in Production.

The current API validates shape, size, drug names, fact IDs and source IDs. It does not prove
that arbitrary browser-supplied fact text came from this deterministic engine. A production
implementation must load the fact context from an authenticated server-side run record (or
verify a short-lived signed context created by that server) rather than trust request text.

## Operational controls

- Put rate limits on `/api/clinical-review` and `/api/pharmcat/*` in Vercel WAF. Start in log
  mode, establish expected traffic, then enforce a conservative fixed window.
- Require application authentication and per-run authorization. An opaque run ID is not
  authorization.
- Use separate GCP projects or service accounts for Preview and Production.
- Disable public access on buckets, Cloud Run and Vertex endpoints.
- Redact request and response bodies from Vercel and Google Cloud logs.
- Alert on repeated model rejection, job failure, unusual upload volume and unexpected cost.
- Pin every clinical data release and container by version and immutable digest.
- Document deletion of raw inputs, derived reports, logs and backups; test deletion.
- Treat signed upload URLs and resumable session URIs as bearer secrets.
- Cloud Storage resumable session URIs can remain valid for up to a week. Cancel abandoned
  sessions and delete orphan objects rather than treating browser navigation as revocation.

## Primary deployment references

- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)
- [Vercel OIDC with Google Cloud](https://vercel.com/docs/oidc/gcp)
- [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
- [Google Cloud Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
- [Cloud Storage signed URLs](https://cloud.google.com/storage/docs/access-control/signed-urls)
- [Cloud Storage resumable uploads](https://cloud.google.com/storage/docs/resumable-uploads)
- [Cloud Run service-to-service authentication](https://cloud.google.com/run/docs/authenticating/service-to-service)
- [MedGemma deployment options](https://developers.google.com/health-ai-developer-foundations/medgemma/get-started)
- [PharmCAT VCF requirements](https://pharmcat.clinpgx.org/using/VCF-Requirements/)
- [PharmCAT CYP2D6 boundary](https://pharmcat.clinpgx.org/using/Calling-CYP2D6/)
- [PharmCAT in Docker](https://pharmcat.clinpgx.org/using/PharmCAT-in-Docker/)
