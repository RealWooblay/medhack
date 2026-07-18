#!/usr/bin/env bash
#
# Run the official PharmCAT container against a VCF and emit the artefacts this app expects.
#
# The caller is deliberately separate from the browser app. The browser never turns a raw
# VCF into a clinical result. This script is a local operator tool and is also the command a
# governed asynchronous worker can wrap.
#
# We wrap PharmCAT rather than forking it — its maintainers state that customisation is
# unsupported, and the entire premise here is that the guideline facts come from the
# PharmGKB reference implementation rather than from us.
#
# Usage:
#   PHARMCAT_IMAGE='pgkb/pharmcat:<version>@sha256:<manifest-digest>' \
#     ./scripts/run-pharmcat.sh path/to/sample.vcf [outdir]
#
# Requires Docker.

set -euo pipefail

VCF="${1:?usage: run-pharmcat.sh <sample.vcf> [outdir]}"
OUTDIR="${2:-pharmcat-out}"
IMAGE="${PHARMCAT_IMAGE:-}"

if [[ ! "$IMAGE" =~ ^pgkb/pharmcat:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "error: PHARMCAT_IMAGE must be an official version pinned to a full sha256 manifest digest" >&2
  echo "example: pgkb/pharmcat:<version>@sha256:<64 lowercase hex characters>" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required but not on PATH" >&2
  exit 1
fi

VCF_DIR="$(cd "$(dirname "$VCF")" && pwd)"
VCF_NAME="$(basename "$VCF")"
mkdir -p "$OUTDIR"
OUT_ABS="$(cd "$OUTDIR" && pwd)"

echo "==> pulling $IMAGE"
docker pull "$IMAGE"

echo "==> running PharmCAT pipeline on $VCF_NAME"
docker run --rm \
  -v "$VCF_DIR:/pharmcat/in:ro" \
  -v "$OUT_ABS:/pharmcat/out" \
  "$IMAGE" \
  pharmcat_pipeline "/pharmcat/in/$VCF_NAME" \
  -o /pharmcat/out \
  -reporterJson

cat <<'NOTES'

==> done

Output written to the directory above:

  *.match.json       matcher   — raw star-allele matches
  *.phenotype.json   phenotyper — { matcherMetadata, geneReports, unannotatedGeneCalls }
  *.report.json      reporter  — { genes, drugs, messages, pharmcatVersion, ... }
  *.report.html      human-readable report
  *.missing_pgx_var.vcf  positions PharmCAT expected and did not find

Importing the result
--------------------
Upload *.report.json to the app. The adapter:

  - `genes` is a map keyed by gene symbol. Read `sourceDiplotypes` for display and
    `recommendationDiplotypes` for the guideline join — they are DIFFERENT arrays, and
    joining on the wrong one silently mismatches recommendations.
  - imports exact CPIC Guideline Annotation recommendation text rather than reconstructing
    a recommendation from a shortened local table;
  - retains every gene result attached to a recommendation, including combined-gene rules;
  - keeps PharmCAT and data versions with the result; and
  - labels coverage unknown when the separate missing-position artefact is unavailable.

The current browser import accepts Reporter JSON only. A production worker must return the
Reporter JSON together with the missing-position VCF and an immutable run manifest so the
coverage state can be checked instead of assumed.

Consumer array data
-------------------
Do not add `--missing-to-ref` in the production path. PharmCAT treats missing positions as
no-calls by default, which is the safe meaning unless the upstream laboratory has explicitly
established that every absent position is a true reference call. Import the
`*.missing_pgx_var.vcf` beside the Reporter JSON and keep the limitation visible.

PharmCAT explicitly recommends AGAINST calling CYP2D6 from a VCF, because structural and
copy-number variation dominate the phenotype and are invisible to SNP/INDEL data. For
CYP2D6, supply an outside call instead:

  printf 'CYP2D6\t*1/*1\n' > outside.tsv
  docker run --rm -v "$PWD:/pharmcat/data" \
    "$PHARMCAT_IMAGE" \
    pharmcat_pipeline /pharmcat/data/sample.vcf -o /pharmcat/data/out \
    -reporterJson -po /pharmcat/data/outside.tsv

That sets callSource=OUTSIDE on the gene report, which keeps the provenance visible.

NOTES
