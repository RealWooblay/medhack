# Deploy the real system

The frontend is a Vite app on Vercel. Raw genomes are processed by a private PharmCAT
service on Google Cloud. MedGemma runs behind an IAM-protected Vertex AI prediction endpoint.

```text
Browser ── app and small control calls ──> Vercel
   │                                         │
   │                                         ├─> private Cloud Run control service
   │                                         └─> IAM-protected Vertex MedGemma endpoint
   │
   └─ raw VCF bytes ──> private Cloud Storage ──> pinned Cloud Run Job
```

The repository contains all application, gateway, control-service and worker code. It does
not create billable Google Cloud or Vertex resources automatically. Until those resources
are deployed, raw uploads and AI reviews fail visibly; they never switch to demo data.

## 1. Verify the repository

Use Node 22, Go 1.22 and Docker:

```bash
npm ci
npm run test:all
npm run typecheck
npm run build
(cd services/pharmcat-worker && go vet ./...)
```

## 2. Set the deployment names

Replace every example value before running a command:

```bash
export PGX_PROJECT="your-gcp-project-id"
export PGX_PROJECT_NUMBER="your-gcp-project-number"
export PGX_REGION="australia-southeast1"
export PGX_REPOSITORY="pgx"
export PGX_RUN_BUCKET="your-private-pgx-run-bucket"
export PGX_APP_ORIGIN="https://your-project.vercel.app"
export PGX_VERCEL_TEAM="your-vercel-team-slug"
export PGX_VERCEL_PROJECT="your-vercel-project-name"

export PGX_WORKER_SA="pgx-worker@${PGX_PROJECT}.iam.gserviceaccount.com"
export PGX_CONTROL_SA="pgx-control@${PGX_PROJECT}.iam.gserviceaccount.com"
export PGX_GATEWAY_SA="pgx-vercel@${PGX_PROJECT}.iam.gserviceaccount.com"
```

Enable the APIs and create the three separate runtime identities:

```bash
gcloud config set project "$PGX_PROJECT"
gcloud services enable \
  aiplatform.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com \
  sts.googleapis.com

gcloud artifacts repositories create "$PGX_REPOSITORY" \
  --repository-format=docker \
  --location="$PGX_REGION"

gcloud iam service-accounts create pgx-worker
gcloud iam service-accounts create pgx-control
gcloud iam service-accounts create pgx-vercel
```

## 3. Create private run storage

```bash
gcloud storage buckets create "gs://${PGX_RUN_BUCKET}" \
  --project="$PGX_PROJECT" \
  --location="$PGX_REGION" \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update "gs://${PGX_RUN_BUCKET}" --clear-soft-delete
gcloud storage buckets update "gs://${PGX_RUN_BUCKET}" \
  --lifecycle-file=services/pharmcat-control/lifecycle.json
```

Cloud Storage enables seven-day soft delete on new buckets by default. This command disables
it for this short-lived genome bucket; otherwise the one-day lifecycle would not mean one-day
deletion. Do not enable object versioning on this bucket. Lifecycle deletion is asynchronous,
so production must also expose an explicit cancel/delete operation before accepting patient data.

Copy `services/pharmcat-control/cors.example.json` to a temporary file, replace the origin
with the exact `PGX_APP_ORIGIN`, then apply it:

```bash
gcloud storage buckets update "gs://${PGX_RUN_BUCKET}" \
  --cors-file=/path/to/edited-cors.json
```

The origin must not be `*`. The resumable upload URL is a bearer capability and must not be
logged. Both runtime services need read/write access only to this isolated bucket:

```bash
gcloud storage buckets add-iam-policy-binding "gs://${PGX_RUN_BUCKET}" \
  --member="serviceAccount:${PGX_WORKER_SA}" \
  --role="roles/storage.objectAdmin"

gcloud storage buckets add-iam-policy-binding "gs://${PGX_RUN_BUCKET}" \
  --member="serviceAccount:${PGX_CONTROL_SA}" \
  --role="roles/storage.objectAdmin"
```

## 4. Build immutable containers

These are the verified multi-architecture digests used for this release:

```bash
export PGX_GO_IMAGE="golang:1.22-bookworm@sha256:3d699e4d15d0f8f13c9195c0632a16702b8cbdece2955af1c23b37ae5d55a253"
export PGX_NODE_IMAGE="node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3"
export PGX_PHARMCAT_IMAGE="pgkb/pharmcat:3.3.0@sha256:e9b02865a0abe1a0085ac0d7625f1ec33a06a56e9571d5befb16f90d4fedc435"

export PGX_WORKER_IMAGE="${PGX_REGION}-docker.pkg.dev/${PGX_PROJECT}/${PGX_REPOSITORY}/pharmcat-worker"
export PGX_CONTROL_IMAGE="${PGX_REGION}-docker.pkg.dev/${PGX_PROJECT}/${PGX_REPOSITORY}/pharmcat-control"

gcloud auth configure-docker "${PGX_REGION}-docker.pkg.dev"

docker buildx build --platform=linux/amd64 --push \
  --build-arg "GO_IMAGE=${PGX_GO_IMAGE}" \
  --build-arg "PHARMCAT_IMAGE=${PGX_PHARMCAT_IMAGE}" \
  --tag "${PGX_WORKER_IMAGE}:release" \
  services/pharmcat-worker

docker buildx build --platform=linux/amd64 --push \
  --build-arg "NODE_IMAGE=${PGX_NODE_IMAGE}" \
  --tag "${PGX_CONTROL_IMAGE}:release" \
  services/pharmcat-control

gcloud artifacts docker images describe "${PGX_WORKER_IMAGE}:release" \
  --format='value(image_summary.digest)'
gcloud artifacts docker images describe "${PGX_CONTROL_IMAGE}:release" \
  --format='value(image_summary.digest)'
```

Record the two returned digests. Do not deploy the mutable `:release` tags:

```bash
export PGX_WORKER_DIGEST="sha256:replace-with-returned-worker-digest"
export PGX_CONTROL_DIGEST="sha256:replace-with-returned-control-digest"
```

## 5. Deploy PharmCAT

Deploy the job with exactly one named container. The control service checks this name and
digest before every run:

```bash
gcloud run jobs deploy pharmcat-worker \
  --project="$PGX_PROJECT" \
  --region="$PGX_REGION" \
  --service-account="$PGX_WORKER_SA" \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=20m \
  --container=worker \
  --image="${PGX_WORKER_IMAGE}@${PGX_WORKER_DIGEST}" \
  --cpu=4 \
  --memory=8Gi
```

The control service reads the job and starts it with per-run overrides. Give it only those
three permissions:

```bash
gcloud iam roles create pgxPharmcatJobRunner \
  --project="$PGX_PROJECT" \
  --title="PGx PharmCAT job runner" \
  --permissions="run.jobs.get,run.jobs.run,run.jobs.runWithOverrides" \
  --stage=GA

gcloud run jobs add-iam-policy-binding pharmcat-worker \
  --project="$PGX_PROJECT" \
  --region="$PGX_REGION" \
  --member="serviceAccount:${PGX_CONTROL_SA}" \
  --role="projects/${PGX_PROJECT}/roles/pgxPharmcatJobRunner"
```

Deploy the control service as authenticated-only:

```bash
gcloud run deploy pharmcat-control \
  --project="$PGX_PROJECT" \
  --region="$PGX_REGION" \
  --image="${PGX_CONTROL_IMAGE}@${PGX_CONTROL_DIGEST}" \
  --service-account="$PGX_CONTROL_SA" \
  --ingress=all \
  --no-allow-unauthenticated \
  --set-env-vars="PHARMCAT_RUN_BUCKET=${PGX_RUN_BUCKET}" \
  --set-env-vars="PHARMCAT_JOB_NAME=projects/${PGX_PROJECT}/locations/${PGX_REGION}/jobs/pharmcat-worker" \
  --set-env-vars="PHARMCAT_JOB_CONTAINER=worker" \
  --set-env-vars="PHARMCAT_IMAGE=${PGX_PHARMCAT_IMAGE}" \
  --set-env-vars="PHARMCAT_WORKER_IMAGE_DIGEST=${PGX_WORKER_DIGEST}" \
  --set-env-vars="PGX_APP_ORIGIN=${PGX_APP_ORIGIN}"

export PGX_CONTROL_URL="$(gcloud run services describe pharmcat-control \
  --project="$PGX_PROJECT" \
  --region="$PGX_REGION" \
  --format='value(status.url)')"
```

Only the Vercel gateway identity may invoke this service:

```bash
gcloud run services add-iam-policy-binding pharmcat-control \
  --project="$PGX_PROJECT" \
  --region="$PGX_REGION" \
  --member="serviceAccount:${PGX_GATEWAY_SA}" \
  --role="roles/run.invoker"
```

Do not grant Cloud Run Invoker to `allUsers`, `allAuthenticatedUsers`, the control-service
identity or the worker identity. The internal tenant header is trusted only because the sole
caller is the gateway.

## 6. Connect Vercel without a service-account key

Create a team-specific Vercel workload identity provider:

```bash
export PGX_WIF_POOL="vercel-pgx"
export PGX_WIF_PROVIDER="vercel-pgx"

gcloud iam workload-identity-pools create "$PGX_WIF_POOL" \
  --project="$PGX_PROJECT" \
  --location=global \
  --display-name="Vercel PGx"

gcloud iam workload-identity-pools providers create-oidc "$PGX_WIF_PROVIDER" \
  --project="$PGX_PROJECT" \
  --location=global \
  --workload-identity-pool="$PGX_WIF_POOL" \
  --issuer-uri="https://oidc.vercel.com/${PGX_VERCEL_TEAM}" \
  --attribute-mapping="google.subject=assertion.sub"

gcloud iam service-accounts add-iam-policy-binding "$PGX_GATEWAY_SA" \
  --project="$PGX_PROJECT" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/${PGX_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${PGX_WIF_POOL}/subject/owner:${PGX_VERCEL_TEAM}:project:${PGX_VERCEL_PROJECT}:environment:production"
```

Create a separate Preview binding only if Preview should reach a separate non-production
backend. Do not wildcard the team, project or environment.

The same gateway identity calls Vertex. A narrow custom role is sufficient for prediction:

```bash
gcloud iam roles create pgxVertexPredict \
  --project="$PGX_PROJECT" \
  --title="PGx Vertex prediction caller" \
  --permissions="aiplatform.endpoints.predict" \
  --stage=GA

gcloud projects add-iam-policy-binding "$PGX_PROJECT" \
  --member="serviceAccount:${PGX_GATEWAY_SA}" \
  --role="projects/${PGX_PROJECT}/roles/pgxVertexPredict"
```

## 7. Deploy MedGemma

In Vertex AI Model Garden, accept the model terms and deploy
`google/medgemma-27b-text-it` to an IAM-protected public or public-dedicated prediction endpoint
in the approved region. A VPC-only private endpoint is not directly reachable from Vercel; use
one only if the model gateway is moved into the same GCP network. Endpoint creation is billable.
Record:

- Vertex location and endpoint ID;
- exact model revision or weights identity;
- serving-container digest and accelerator configuration; and
- deployment date.

The app sends only a completed private run ID and bounded patient context. The server reloads
the session-owned run, rebuilds all facts, calls MedGemma at temperature zero and accepts only
known fact IDs and typed actions. The model cannot name a new dose, drug, gene, source or URL.

## 8. Deploy the Vercel app

Import the GitHub repository into Vercel with:

```text
Framework: Vite
Build command: npm run build
Output directory: dist
Production branch: main
Function region: syd1
```

Set these Vercel environment variables:

```text
VITE_MEDGEMMA_ENDPOINT=/api/clinical-review

GCP_PROJECT_ID=<project id>
GCP_PROJECT_NUMBER=<project number>
GCP_SERVICE_ACCOUNT_EMAIL=<pgx-vercel service-account email>
GCP_WORKLOAD_IDENTITY_POOL_ID=vercel-pgx
GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID=vercel-pgx
GCP_AUDIENCE=https://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/vercel-pgx/providers/vercel-pgx

PHARMCAT_SERVICE_URL=<exact PGX_CONTROL_URL>
PHARMCAT_SERVICE_AUDIENCE=<same exact PGX_CONTROL_URL>
PHARMCAT_SESSION_SECRET=<at least 32 cryptographically random bytes, base64url encoded>

MEDGEMMA_VERTEX_LOCATION=<deployed region>
MEDGEMMA_VERTEX_ENDPOINT_ID=<numeric endpoint id>
MEDGEMMA_MODEL_ID=google/medgemma-27b-text-it
MEDGEMMA_VERTEX_DEDICATED_DNS=<optional hostname only>
```

Keep the first deployment behind Vercel Authentication and redeploy after setting the
variables. There is no service-account JSON key.

## 9. Prove the deployed path

Use synthetic, biologically coherent inputs before any patient data:

1. Upload the official PharmCAT GRCh38 example through the browser.
2. Confirm Cloud Storage received the exact browser SHA-256 and the worker reached `complete`.
3. Confirm the manifest contains the pinned worker and PharmCAT digests, exact command,
   versions, coverage and output hashes.
4. Confirm missing positions remain missing and CYP2D6 is absent.
5. Confirm a wrong build, second sample, altered object, altered manifest and failed job all
   produce a visible failure with no partial result.
6. Confirm an official UI example and an imported Reporter file cannot call AI.
7. Confirm a private completed run can call the exact deployed MedGemma revision and that an
   unknown fact ID or malformed response is rejected.
8. Confirm the browser, Vercel, Cloud Run and Vertex logs contain no genome, upload URL,
   report, prompt or model output.
9. Verify the endpoint serves the exact accepted MedGemma weights/revision. The request model ID
   is fixed to `google/medgemma-27b-text-it`; the endpoint still needs independent deployment
   attestation because a request field cannot prove the weights behind it.

## Release boundary

This is suitable for protected technical and clinical validation after the deployed-path
checks above pass. Do not use real patient data or expose it as a public patient service until
there is user authentication, per-user revocation, rate limiting, an upload cancellation and
deletion path, approved retention, Australian formulation-specific PI/CMI evidence, validated
CYP2D6 SV/CNV calling, clinical evaluation, privacy/security review and regulatory review.
