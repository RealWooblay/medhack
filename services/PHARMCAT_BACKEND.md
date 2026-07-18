# PharmCAT backend

This is the real raw-genome path behind the app:

```text
browser → run-scoped GCS upload → private control service
        → pinned Cloud Run Job → sealed result + manifest
```

PharmCAT is an internal dependency. A normal user uploads a single-person GRCh38 VCF or
VCF.GZ, not a PharmCAT report. The Vercel function receives only small control messages; raw
genome bytes go directly to the private upload session.

## Fail-closed rules

- Generic consumer genotype files are rejected until a provider-specific build, strand and
  coverage adapter is validated.
- The worker accepts one GRCh38 sample and enforces compressed, uncompressed, record and line
  limits.
- Missing positions are not changed to reference calls.
- CYP2D6 is removed until a structural/copy-number-aware outside caller is integrated.
- The official PharmCAT 3.3.0 image is pinned by digest.
- The custom worker runs as a non-root user and is also deployed by digest.
- The control service checks the deployed job's named container and digest before every run.
- State updates use object-generation preconditions. Outputs are returned only after hashes,
  versions, coverage, command, image and run identity all agree.
- Partial, altered, expired and failed runs return no clinical result.

The final manifest records input SHA-256, object generation, sample/build checks, exact command,
worker and PharmCAT image digests, software/data versions, coverage, missing-position count,
output hashes, Cloud Run execution and timestamps.

## Isolation

Every storage path is derived from a keyed browser-session tenant ID plus a random run ID. The
gateway never accepts a caller-supplied tenant ID. The control service does accept its internal
tenant header, so Cloud Run Invoker must be granted only to the Vercel gateway service account.
Cross-tenant reads/submits and forged session cookies are regression-tested.

## Deployment

The exact storage, CORS, immutable-build, named-job, IAM, Cloud Run and Vercel commands are in
[`DEPLOYMENT.md`](../DEPLOYMENT.md). In particular, the controller needs
`run.jobs.get`, `run.jobs.run` and `run.jobs.runWithOverrides`; the worker and control identities
need access only to the isolated run bucket.

## Verification

```bash
npm test --prefix services/pharmcat-control
(cd services/pharmcat-worker && go test ./... && go vet ./...)
npm test -- --run src/pharmcat/__tests__/gateway.test.ts
```

Unit tests do not prove container runtime paths, resource requirements or output filenames.
Before calling raw upload operational, build the pinned worker and run the official PharmCAT
GRCh38 VCF through the actual container and deployed Cloud Run/GCS path.
