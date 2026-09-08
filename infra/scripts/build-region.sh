#!/usr/bin/env bash
# Builds one region's downloadable artifacts (Phase 3).
#
#   ./build-region.sh <region-id> [--dry-run] [--only=<kinds>]
#
# `--only=sac` (or `--only=basemap,terrain`) builds a subset. That exists for adding a new
# artifact kind to a catalogue that is already published: the grades are a 1.8 MB cutout
# for Scotland against a 646 MB basemap, and re-extracting the basemap to get them would
# mean days and hundreds of GB of range requests for bytes that have not changed.
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

REGION_ID="${1:?Usage: build-region.sh <region-id> [--dry-run] [--only=<kinds>]}"
shift
DRY_RUN=""
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN="--dry-run" ;;
    --only=*)   ONLY="${arg#--only=}" ;;
    # Rejected rather than ignored: a mistyped --only would otherwise build everything,
    # which for a global catalogue is the difference between minutes and days.
    *) echo "Unknown option: $arg (expected --dry-run or --only=<kinds>)" >&2; exit 2 ;;
  esac
done

# Which artifact kinds this run should build. Empty ONLY means all of them.
wants() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *,"$1",*) return 0 ;; esac
  return 1
}

for requested in ${ONLY//,/ }; do
  case "$requested" in
    basemap|paths|sac|terrain) ;;
    *) echo "Unknown artifact kind in --only: $requested (known: basemap, paths, sac, terrain)" >&2
       exit 2 ;;
  esac
done

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

# SAC grades (T1-T6) are ours, not upstream's — build-sac.sh makes sac-global.pmtiles from
# OSM. Prefer the local copy when this machine has just built one, and fall back to the
# published archive so a region can be rebuilt on a machine that has not.
#
# Absent altogether is not an error: a region built before the grades existed is a
# perfectly good region (C16), and the app draws whatever artifacts it finds.
if [ -n "${SAC_SOURCE_URL:-}" ]; then
  SAC_SOURCE="$SAC_SOURCE_URL"
elif [ -s "$DIST_DIR/sac-global.pmtiles" ]; then
  SAC_SOURCE="$DIST_DIR/sac-global.pmtiles"
elif [ -n "${PUBLIC_BASE_URL:-}" ]; then
  SAC_SOURCE="$PUBLIC_BASE_URL/sac-global.pmtiles"
else
  SAC_SOURCE=""
fi

# The z12-13 walkable network, also ours (build-paths.sh), resolved the same way. The
# basemap has no paths below z14 — see that script's header — so without this a region
# draws grade bands over blank hillside.
if [ -n "${PATHS_SOURCE_URL:-}" ]; then
  PATHS_SOURCE="$PATHS_SOURCE_URL"
elif [ -s "$DIST_DIR/paths-global.pmtiles" ]; then
  PATHS_SOURCE="$DIST_DIR/paths-global.pmtiles"
elif [ -n "${PUBLIC_BASE_URL:-}" ]; then
  PATHS_SOURCE="$PUBLIC_BASE_URL/paths-global.pmtiles"
else
  PATHS_SOURCE=""
fi

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

# Never deeper than the basemap: the grade is drawn as a band under a path, and a band at
# a zoom where the region has no path to draw it under is an annotation on nothing.
# sac-global.pmtiles itself stops at z15.
SAC_MAXZOOM="$BASEMAP_MAXZOOM"
[ "$SAC_MAXZOOM" -gt 15 ] && SAC_MAXZOOM=15

# paths-global.pmtiles only holds z12-13 — it exists to fill the gap below where the
# basemap starts carrying paths, not to duplicate it.
PATHS_MAXZOOM=13

OUT_DIR="$DIST_DIR/regions/$REGION_ID"
mkdir -p "$OUT_DIR"

echo "Region: $REGION_NAME ($REGION_ID)"
echo "  bbox: $BBOX"
[ -n "$ONLY" ] && echo "  only: $ONLY"
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
#
# `--allow-empty` additionally accepts "this region contains none of that data" as a
# result. Only the SAC grades use it: `sac_scale` is tagged nowhere in most of the world,
# and an empty cutout is the honest answer for Egypt rather than a failed build — but an
# empty *basemap* would be a broken region, so it stays an error by default.
extract_verified() {
  local source="$1" out="$2" maxzoom="$3" allow_empty="${4:-}"
  local tmp="$out.building"

  rm -f "$tmp"
  pmtiles extract "$source" "$tmp" --bbox="$BBOX" --maxzoom="$maxzoom" $DRY_RUN
  [ -n "$DRY_RUN" ] && return 0

  # An empty extract does not merely contain nothing — it fails `pmtiles verify` outright
  # ("header MinZoom=12 does not match min tile z 31"), so it has to be recognised before
  # the verify step or every grade-less region would abort its own build.
  #
  # Read from the header rather than inferred from the file size: an empty archive is
  # 1754 bytes of header and root directory, and "small" is not the same fact as "holds
  # no tiles".
  if [ "$allow_empty" = "--allow-empty" ] && [ "$(archive_tile_count "$tmp")" = "0" ]; then
    # The previous build's copy goes too: a region that no longer has graded paths (or
    # whose grades were built from a narrower source) must not keep publishing yesterday's.
    rm -f "$tmp" "$out"
    echo "  nothing here — no $(basename "$out") published"
    return 0
  fi

  if ! pmtiles verify "$tmp" >/dev/null 2>&1; then
    echo "  FAILED verification: $(basename "$out") is not a valid PMTiles archive" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$out"
  echo "  verified $(basename "$out") ($(du -h "$out" | cut -f1))"
}

# Tiles addressed by a PMTiles v3 archive: u64 little-endian at offset 72 of the fixed
# 127-byte header (spec v3). Prints "invalid" for anything that is not a PMTiles file, so
# a truncated download can never be read as an empty region.
archive_tile_count() {
  python3 - "$1" <<'PY_COUNT'
import struct, sys
with open(sys.argv[1], "rb") as f:
    header = f.read(127)
print(struct.unpack_from("<Q", header, 72)[0] if header[:7] == b"PMTiles" else "invalid")
PY_COUNT
}

if wants basemap; then
  echo "==> basemap"
  extract_verified "$BASEMAP_SOURCE" "$OUT_DIR/$REGION_ID-basemap.pmtiles" "$BASEMAP_MAXZOOM"
fi

if ! wants paths; then
  :
elif [ -n "$PATHS_SOURCE" ]; then
  echo "==> low-zoom paths"
  extract_verified "$PATHS_SOURCE" "$OUT_DIR/$REGION_ID-paths.pmtiles" "$PATHS_MAXZOOM" --allow-empty
else
  echo "==> low-zoom paths: skipped (no paths-global.pmtiles — run ./scripts/build-paths.sh)"
fi

if ! wants sac; then
  :
elif [ -n "$SAC_SOURCE" ]; then
  echo "==> sac grades"
  extract_verified "$SAC_SOURCE" "$OUT_DIR/$REGION_ID-sac.pmtiles" "$SAC_MAXZOOM" --allow-empty
else
  # Said out loud rather than skipped quietly: a catalogue where half the regions have
  # grades and half do not, with no note of which, is worse than one with none.
  echo "==> sac grades: skipped (no sac-global.pmtiles — run ./scripts/build-sac.sh)"
fi

if ! wants terrain; then
  :
elif [ "$WANT_TERRAIN" = 1 ]; then
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
  # --base-live, not a bare rebuild: see build-contours.sh's own version of this note —
  # dist/ is essentially never the whole catalogue, so a bare build-manifest.py run would
  # publish an unpublish of every region it can't see on this disk.
  echo "Next:"
  echo "  python3 ./scripts/build-manifest.py --base-live"
  echo "  ./scripts/upload.sh"
fi
