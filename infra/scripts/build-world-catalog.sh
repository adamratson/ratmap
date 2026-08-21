#!/usr/bin/env bash
# Builds the catalog-only world basemap (§8.2, decided 2026-08-21): a low-zoom-capped
# extract, not the ~120 GB planet. High-detail regions come from Phase 4's on-demand
# per-region extracts, not this file.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd pmtiles

# C13: pin, don't track "latest". This points at Protomaps' Source Cooperative mirror of
# their published v4 build (docs/IMPLEMENTATION.md C13/C15) — we don't hotlink it from the
# running app, we extract our own copy below and upload *that*. The extracted file's
# embedded `planetiler:buildtime` / `planetiler:osm:osmosisreplicationtime` metadata
# (`pmtiles show` on the output) is the actual record of which upstream build this is —
# note those values in the commit/PR whenever this is re-run.
SOURCE_URL="${WORLD_SOURCE_URL:-https://data.source.coop/protomaps/openstreetmap/v4.pmtiles}"

# Verified 2026-08-21: maxzoom=5 extracted in ~9s, transferring ~15 MB (not the 135 GB
# source) via range requests, for a ~15 MB world.pmtiles at zoom 0-5.
MAXZOOM="${WORLD_CATALOG_MAXZOOM:-5}"
VERSION="$(date +%Y-%m-%d)"
OUT="$DIST_DIR/world-catalog-${VERSION}.pmtiles"

echo "Extracting world catalog (maxzoom=${MAXZOOM}) from ${SOURCE_URL}"
echo "This reads over HTTP range requests — it does not download the full source archive."
pmtiles extract "$SOURCE_URL" "$OUT" --maxzoom="$MAXZOOM"

pmtiles show "$OUT"
echo "Built $OUT"
