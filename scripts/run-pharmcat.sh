#!/usr/bin/env bash
#
# Run the real PharmCAT against a VCF and emit the JSON this app's adapter consumes.
#
# The app ships with known-diplotype fixtures so a demo cannot fail on live variant
# calling. This script is how those fixtures are regenerated from the actual reference
# implementation, and how you would wire the real thing in for production use.
#
# We wrap PharmCAT rather than forking it — its maintainers state that customisation is
# unsupported, and the entire premise here is that the guideline facts come from the
# PharmGKB reference implementation rather than from us.
#
# Usage:
#   ./scripts/run-pharmcat.sh path/to/sample.vcf [outdir]
#
# Requires Docker.

set -euo pipefail

VCF="${1:?usage: run-pharmcat.sh <sample.vcf> [outdir]}"
OUTDIR="${2:-pharmcat-out}"
IMAGE="pgkb/pharmcat"

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

Wiring it into the app
----------------------
Implement PharmCATAdapter (src/engine/pharmcat/adapter.ts) against *.report.json:

  - `genes` is a map keyed by gene symbol. Read `sourceDiplotypes` for display and
    `recommendationDiplotypes` for the guideline join — they are DIFFERENT arrays, and
    joining on the wrong one silently mismatches recommendations.
  - `drugs` is nested two levels: PrescribingGuidanceSource -> drug name -> DrugReport.
    The outer keys are CPIC_GUIDELINE | DPWG_GUIDELINE | FDA_LABEL | FDA_ASSOC. That enum
    is the discriminator our citation layer keys off.
  - `uncalledHaplotypes` and the missing-variant VCF feed the confidence scorer directly.

Consumer array data
-------------------
Add `--missing-to-ref` to force absent positions to reference. Read the caveat first: an
array-derived "*1" means only "no tested variant found", so a true *2/*4 poor metaboliser
can be reported as *1/*2 intermediate. That is precisely why this app reports a per-gene
confidence score rather than a bare phenotype.

PharmCAT explicitly recommends AGAINST calling CYP2D6 from a VCF, because structural and
copy-number variation dominate the phenotype and are invisible to SNP/INDEL data. For
CYP2D6, supply an outside call instead:

  printf 'CYP2D6\t*1/*1\n' > outside.tsv
  docker run --rm -v "$PWD:/pharmcat/data" pgkb/pharmcat \
    pharmcat_pipeline /pharmcat/data/sample.vcf -o /pharmcat/data/out \
    -reporterJson --missing-to-ref -po /pharmcat/data/outside.tsv

That sets callSource=OUTSIDE on the gene report, which keeps the provenance visible.

NOTES
