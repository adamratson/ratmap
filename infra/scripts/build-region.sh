#!/usr/bin/env bash
# Builds one region's downloadable artifacts (Phase 3).
#
#   ./build-region.sh <region-id> [--dry-run]
#
# Region ids and bboxes come from infra/regions.json. Output lands in
# dist/regions/<id>/ using <id>-<artifact>.pmtiles filenames — C3: these names are the
# TileSourceRegistry keys once downloaded into OPFS, so two regions must never produce
# the same filename.
#
# Nothing is generated here: both artifacts are `pmtiles extract` cutouts read over HTTP
# range requests from upstream archives. No 135 GB basemap or 706 GB terrain download,
# and no tile generation in-browser (C14).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd pmtiles
require_cmd python3

REGION_ID="${1:?Usage: build-region.sh <region-id> [--dry-run]}"
DRY_RUN=""
[ "${2:-}" = "--dry-run" ] && DRY_RUN="--dry-run"

REGIONS_JSON="$INFRA_DIR/regions.json"

# Emit shell assignments rather than whitespace-separated fields — region names contain
# spaces ("Lochaber & Ben Nevis") and would otherwise split across variables.
#
# Assigned via a temp var, not `eval "$(...)"` directly: command substitution discards the
# child's exit status, so an unknown region id would print its error and then carry on to
# a confusing "unbound variable" failure instead of stopping here.
if ! REGION_VARS="$(python3 - "$REGIONS_JSON" "$REGION_ID" <<'PY_INNER'
import json, shlex, sys
with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
match = next((r for r in regions if r["id"] == sys.argv[2]), None)
if match is None:
    sys.exit(f"Unknown region '{sys.argv[2]}'. Known: {', '.join(r['id'] for r in regions)}")
print(f"REGION_NAME={shlex.quote(match['name'])}")
print(f"BBOX={shlex.quote(','.join(str(c) for c in match['bbox']))}")
PY_INNER
)"; then
  exit 1
fi
eval "$REGION_VARS"

# Upstream sources, pinned the same way as the global builds (C13/C15 — we extract our
# own copies rather than hotlinking these at runtime).
BASEMAP_SOURCE="${WORLD_SOURCE_URL:-https://data.source.coop/protomaps/openstreetmap/v4.pmtiles}"
TERRAIN_SOURCE="${TERRAIN_SOURCE_URL:-https://download.mapterhorn.com/planet.pmtiles}"

# Measured for Scotland (2026-08-21): basemap z12 ~84 MB / z13 ~175 MB; terrain z10
# ~107 MB / z11 ~340 MB. Raster terrain grows far faster than vector basemap per level,
# hence the different ceilings. Override per build if a region needs more.
#
# Basemap z15 (not 13) because **paths carry `min_zoom: 14`** in the Protomaps schema, so
# a z13 cutout generalises nearly all of them away — verified by decoding a z13 tile over
# Ben Nevis, which contained a single path feature. On a hiking map the paths are the
# point. z15 is also the source archive's own maximum. Cheap: Lochaber goes 4.9 MB → 14 MB.
BASEMAP_MAXZOOM="${REGION_BASEMAP_MAXZOOM:-15}"
TERRAIN_MAXZOOM="${REGION_TERRAIN_MAXZOOM:-11}"

OUT_DIR="$DIST_DIR/regions/$REGION_ID"
mkdir -p "$OUT_DIR"

echo "Region: $REGION_NAME ($REGION_ID)"
echo "  bbox: $BBOX"
echo "  basemap maxzoom=$BASEMAP_MAXZOOM, terrain maxzoom=$TERRAIN_MAXZOOM"
echo

echo "==> basemap"
pmtiles extract "$BASEMAP_SOURCE" "$OUT_DIR/$REGION_ID-basemap.pmtiles" \
  --bbox="$BBOX" --maxzoom="$BASEMAP_MAXZOOM" $DRY_RUN

echo "==> terrain"
pmtiles extract "$TERRAIN_SOURCE" "$OUT_DIR/$REGION_ID-terrain.pmtiles" \
  --bbox="$BBOX" --maxzoom="$TERRAIN_MAXZOOM" $DRY_RUN

if [ -z "$DRY_RUN" ]; then
  echo
  for f in "$OUT_DIR"/*.pmtiles; do
    pmtiles verify "$f" >/dev/null && echo "verified $(basename "$f") ($(du -h "$f" | cut -f1))"
  done
  echo "Built $OUT_DIR"
  echo "Next: ./scripts/build-manifest.py, then ./scripts/upload.sh"
fi
