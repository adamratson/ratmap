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
west, south, east, north = match["bbox"]
if not (west < east and south < north):
    sys.exit(
        f"Region '{match['id']}' has an invalid bbox {match['bbox']} "
        f"(need west<east, south<north). Fix regions.json before building."
    )
print(f"REGION_NAME={shlex.quote(match['name'])}")
# Opt-out, not opt-in: every region gets terrain unless it says otherwise.
print(f"WANT_TERRAIN={'0' if match.get('terrain') is False else '1'}")
print(f"BBOX={shlex.quote(','.join(str(c) for c in match['bbox']))}")
# Empty unless the catalogue caps this region below the defaults below.
print(f"REGION_BASEMAP_Z={match.get('basemapMaxzoom', '')}")
print(f"REGION_TERRAIN_Z={match.get('terrainMaxzoom', '')}")
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
# Precedence: environment override, then the region's own ceiling from regions.json,
# then these defaults. The per-region ceiling exists because a few regions have nothing
# left to subdivide into and are simply enormous — Greenland, Alaska, the Far Eastern
# Federal District. Shipping those at z13/z9 is better than listing a download nobody can
# finish, and the manifest records each archive's real zoom range, so the app's
# "limited detail" notice tells the truth about them without any extra plumbing.
BASEMAP_MAXZOOM="${REGION_BASEMAP_MAXZOOM:-${REGION_BASEMAP_Z:-15}}"
TERRAIN_MAXZOOM="${REGION_TERRAIN_MAXZOOM:-${REGION_TERRAIN_Z:-11}}"

OUT_DIR="$DIST_DIR/regions/$REGION_ID"
mkdir -p "$OUT_DIR"

echo "Region: $REGION_NAME ($REGION_ID)"
echo "  bbox: $BBOX"
if [ "$WANT_TERRAIN" = 1 ]; then
  echo "  basemap maxzoom=$BASEMAP_MAXZOOM, terrain maxzoom=$TERRAIN_MAXZOOM"
else
  echo "  basemap maxzoom=$BASEMAP_MAXZOOM, terrain skipped"
fi
echo

# Extract to a temporary name, verify, and only then move into place.
#
# An interrupted `pmtiles extract` leaves a file of roughly the right *size* whose header
# is still all zeros — it looks like a plausible artifact in `ls` and only fails on
# "magic number not detected". One of those was nearly published: it survived because the
# build was killed after writing tile data but before finalising the header. Nothing may
# appear under its real name until it has passed verification.
extract_verified() {
  local source="$1" out="$2" maxzoom="$3"
  local tmp="$out.building"

  rm -f "$tmp"
  pmtiles extract "$source" "$tmp" --bbox="$BBOX" --maxzoom="$maxzoom" $DRY_RUN
  [ -n "$DRY_RUN" ] && return 0

  if ! pmtiles verify "$tmp" >/dev/null 2>&1; then
    echo "  FAILED verification: $(basename "$out") is not a valid PMTiles archive" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$out"
  echo "  verified $(basename "$out") ($(du -h "$out" | cut -f1))"
}

echo "==> basemap"
extract_verified "$BASEMAP_SOURCE" "$OUT_DIR/$REGION_ID-basemap.pmtiles" "$BASEMAP_MAXZOOM"

if [ "$WANT_TERRAIN" = 1 ]; then
  echo "==> terrain"
  extract_verified "$TERRAIN_SOURCE" "$OUT_DIR/$REGION_ID-terrain.pmtiles" "$TERRAIN_MAXZOOM"
else
  # C16: a region is a set of named artifacts, so basemap-only is a legitimate region and
  # not a broken one. Antarctica is the case that forced this — its terrain spans every
  # longitude and measures 101 GB at z11, and still 1.4 GB at z7, which is ~1 km per pixel
  # and no use to anyone on foot. The global terrain layer still covers it.
  echo "==> terrain: skipped (regions.json sets terrain: false)"
fi

if [ -z "$DRY_RUN" ]; then
  echo
  echo "Built $OUT_DIR"
  echo "Next: ./scripts/build-manifest.py, then ./scripts/upload.sh"
fi
