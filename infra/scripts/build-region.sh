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
    basemap|paths|peaks|sac|terrain|terrain-features) ;;
    *) echo "Unknown artifact kind in --only: $requested (known: basemap, paths, peaks, sac, terrain, terrain-features)" >&2
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

# Summits with heights, ours too (build-peaks.sh), resolved the same way. Cut per region
# because the app otherwise reads them only from the published global archive — over the
# network — so a downloaded region lost every summit height, marker and detail card as
# soon as the signal did (found 2026-09-24: none drawn offline over Andorra). The app
# serves a region's copy in place of the global archive's tiles inside that region.
if [ -n "${PEAKS_SOURCE_URL:-}" ]; then
  PEAKS_SOURCE="$PEAKS_SOURCE_URL"
elif [ -s "$DIST_DIR/peaks-global.pmtiles" ]; then
  PEAKS_SOURCE="$DIST_DIR/peaks-global.pmtiles"
elif [ -n "${PUBLIC_BASE_URL:-}" ]; then
  PEAKS_SOURCE="$PUBLIC_BASE_URL/peaks-global.pmtiles"
else
  PEAKS_SOURCE=""
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

# Scree/shingle/rock/stone (build-terrain-features.sh), resolved the same way again.
# Protomaps carries none of these — see that script's header.
if [ -n "${TERRAIN_FEATURES_SOURCE_URL:-}" ]; then
  TERRAIN_FEATURES_SOURCE="$TERRAIN_FEATURES_SOURCE_URL"
elif [ -s "$DIST_DIR/terrain-features-global.pmtiles" ]; then
  TERRAIN_FEATURES_SOURCE="$DIST_DIR/terrain-features-global.pmtiles"
elif [ -n "${PUBLIC_BASE_URL:-}" ]; then
  TERRAIN_FEATURES_SOURCE="$PUBLIC_BASE_URL/terrain-features-global.pmtiles"
else
  TERRAIN_FEATURES_SOURCE=""
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

# Same reasoning as SAC: no reason for scree/rock detail to outrun the basemap it's drawn
# over, and terrain-features-global.pmtiles itself stops at z15.
TERRAIN_FEATURES_MAXZOOM="$BASEMAP_MAXZOOM"
[ "$TERRAIN_FEATURES_MAXZOOM" -gt 15 ] && TERRAIN_FEATURES_MAXZOOM=15

# paths-global.pmtiles only holds z12-13 — it exists to fill the gap below where the
# basemap starts carrying paths, not to duplicate it.
PATHS_MAXZOOM=13

# Range requests in flight per extract. go-pmtiles defaults to 4 (`--download-threads`,
# read from main.go at v1.31.2, the image's version); a Praha basemap cutout (41 MB) took
# 18.4 s and 26.0 s at 4 against 14.7 s and 14.0 s at 16, byte-identical output
# (2026-09-23). The upstream archives answer range reads slowly rather than narrowly, so
# more of them in flight is most of what makes a region faster.
DOWNLOAD_THREADS="${REGION_DOWNLOAD_THREADS:-16}"

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

  rm -f "$out.building"
  pmtiles extract "$source" "$out.building" --bbox="$BBOX" --maxzoom="$maxzoom" \
    --download-threads="$DOWNLOAD_THREADS" $DRY_RUN
  [ -n "$DRY_RUN" ] && return 0
  finish_extract "$out" "$allow_empty"
}

# The second half of extract_verified: check <out>.building and move it into place. Split
# out so the terrain extract can download in the background and be finished here later.
finish_extract() {
  local out="$1" allow_empty="${2:-}"
  local tmp="$out.building"

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

  local verdict
  if ! verdict="$(pmtiles verify "$tmp" 2>&1)"; then
    if ! verify_wide_header "$tmp"; then
      echo "  FAILED verification: $(basename "$out") is not a valid PMTiles archive" >&2
      # verify's own reason, which is what anyone reading this log needs next.
      echo "    $(printf '%s\n' "$verdict" | tail -1)" >&2
      rm -f "$tmp"
      return 1
    fi
  fi
  mv "$tmp" "$out"
  echo "  verified $(basename "$out") ($(du -h "$out" | cut -f1))"
}

# A sparse cutout is a valid archive that `pmtiles verify` still rejects, and this tells the
# two apart.
#
# `pmtiles extract` writes the zoom range it was asked for into the header, not the range
# of the tiles it found (read from pmtiles/extract.go at v1.31.2). A small or sparse region
# can have tiles at only some of those zooms — its bbox overlaps big low-zoom tiles that
# carry nearby features, while at z15 nothing falls inside it — and verify insists the
# header's MinZoom and MaxZoom equal the lowest and highest tiles present ("header
# MaxZoom=15 does not match max tile z 12"). That failed monaco-terrain-features on the
# 2026-09-23 run, and 24 of 40 small test cutouts of Scotland and Montenegro.
#
# The header is left as it is. The app takes each source's zoom range from it, and a
# terrain-features cutout re-labelled as ending at z12 would be overzoomed at z13-15,
# stretching coarse z12 shapes of the neighbours' features across the map. Instead, a copy
# gets its header narrowed to the tiles it holds (`pmtiles edit`, which rewrites only the
# header) and must then pass every one of verify's checks. So a truncated or corrupt file
# still fails, and only a header wider than its tiles is let through.
verify_wide_header() {  # verify_wide_header <archive>
  local archive="$1" zooms tile_min tile_max head_min head_max check ok=1
  zooms="$(archive_zooms "$archive")" || return 1
  read -r tile_min tile_max head_min head_max <<<"$zooms"
  # Only ever a header range around the tiles' range — anything else is a real fault.
  { [ "$tile_min" -ge "$head_min" ] && [ "$tile_max" -le "$head_max" ]; } || return 1

  check="$(mktemp -d)"
  cp "$archive" "$check/check.pmtiles"
  # The centre zoom has to move inside the narrowed range too, or verify's next check
  # ("CenterZoom not within MinZoom/MaxZoom") fails on the copy instead.
  if pmtiles show --header-json "$check/check.pmtiles" 2>/dev/null \
       | python3 -c '
import json, sys
h = json.load(sys.stdin)
lo, hi = int(sys.argv[1]), int(sys.argv[2])
h["minzoom"], h["maxzoom"] = lo, hi
h["center"][2] = min(max(h["center"][2], lo), hi)
json.dump(h, open(sys.argv[3], "w"))
' "$tile_min" "$tile_max" "$check/header.json" \
     && pmtiles edit "$check/check.pmtiles" --header-json "$check/header.json" >/dev/null 2>&1 \
     && pmtiles verify "$check/check.pmtiles" >/dev/null 2>&1; then
    ok=0
    echo "  tiles only at z$tile_min-$tile_max of the z$head_min-$head_max cut: a sparse region, verified as such"
  fi
  rm -rf "$check"
  return "$ok"
}

# "<tile min> <tile max> <header min> <header max>" for a PMTiles v3 archive: the lowest and
# highest zoom it holds tiles at, read from its directories (spec v3), then the header's own
# MinZoom and MaxZoom. Only the header and directories are read, never tile data.
archive_zooms() {
  python3 - "$1" <<'PY_ZOOMS'
import gzip, struct, sys

def varints(buf):
    pos = 0
    while pos < len(buf):
        value = shift = 0
        while True:
            byte = buf[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        yield value

def entries(raw):
    it = varints(raw)
    n = next(it)
    ids, tile_id = [], 0
    for _ in range(n):
        tile_id += next(it)
        ids.append(tile_id)
    runs = [next(it) for _ in range(n)]
    lengths = [next(it) for _ in range(n)]
    offsets = []
    for i in range(n):
        v = next(it)
        offsets.append(offsets[i - 1] + lengths[i - 1] if v == 0 and i > 0 else v - 1)
    return zip(ids, runs, offsets, lengths)

def zoom_of(tile_id):
    z, first = 0, 0
    while tile_id >= first + 4 ** z:
        first += 4 ** z
        z += 1
    return z

with open(sys.argv[1], "rb") as f:
    header = f.read(127)
    if header[:7] != b"PMTiles" or header[7] != 3:
        sys.exit("not a PMTiles v3 archive")
    root_off, root_len, _, _, leaf_off = struct.unpack_from("<5Q", header, 8)
    compression, header_min, header_max = header[97], header[100], header[101]
    if compression not in (1, 2):  # none or gzip — all this pipeline's sources use
        sys.exit(f"unsupported internal compression {compression}")

    def read_dir(offset, length):
        f.seek(offset)
        raw = f.read(length)
        return entries(gzip.decompress(raw) if compression == 2 else raw)

    lo = hi = None
    pending = [(root_off, root_len)]
    while pending:
        for tile_id, run, offset, length in read_dir(*pending.pop()):
            if run == 0:  # a leaf directory, not a tile
                pending.append((leaf_off + offset, length))
                continue
            first, last = zoom_of(tile_id), zoom_of(tile_id + run - 1)
            lo = first if lo is None else min(lo, first)
            hi = last if hi is None else max(hi, last)

if lo is None:
    sys.exit("no tiles")
print(lo, hi, header_min, header_max)
PY_ZOOMS
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

# Terrain comes from a different host (Mapterhorn) than the basemap (Source Cooperative),
# and both are latency-bound range reads, so it downloads in the background while
# everything else is cut: a region then costs about the longer of the two, not their sum.
# The pmtiles process itself is the background job, so the EXIT trap can stop it if
# anything in the foreground fails; verification happens in the terrain step below, once
# it has finished. A dry run stays sequential, so its report reads in order.
TERRAIN_OUT="$OUT_DIR/$REGION_ID-terrain.pmtiles"
TERRAIN_PID=""
TERRAIN_LOG=""
if wants terrain && [ "$WANT_TERRAIN" = 1 ] && [ -z "$DRY_RUN" ]; then
  TERRAIN_LOG="$(mktemp)"
  trap 'if [ -n "$TERRAIN_PID" ]; then kill "$TERRAIN_PID" 2>/dev/null || true; fi; rm -f "$TERRAIN_LOG"' EXIT
  rm -f "$TERRAIN_OUT.building"
  pmtiles extract "$TERRAIN_SOURCE" "$TERRAIN_OUT.building" --bbox="$BBOX" \
    --maxzoom="$TERRAIN_MAXZOOM" --download-threads="$DOWNLOAD_THREADS" > "$TERRAIN_LOG" 2>&1 &
  TERRAIN_PID=$!
  echo "==> terrain: downloading in the background"
fi

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

if ! wants peaks; then
  :
elif [ -n "$PEAKS_SOURCE" ]; then
  # Which archive, said out loud: a local dist/ copy wins over the published one, and a
  # stale local copy (a Scotland-only build from August, found 2026-09-24) would be cut
  # into every region without a word. Rebuild it with build-peaks.sh first.
  if [ -f "$PEAKS_SOURCE" ]; then
    echo "==> summits (from $PEAKS_SOURCE, $(du -h "$PEAKS_SOURCE" | cut -f1), built $(date -r "$PEAKS_SOURCE" +%Y-%m-%d))"
  else
    echo "==> summits (from $PEAKS_SOURCE)"
  fi
  # The source archive's own top zoom, read from its header rather than written down here:
  # a number written down is how the app came to cap summits at z5 over a z6 archive,
  # hiding ~60% of them. Every zoom is needed — tippecanoe thins the lower ones.
  PEAKS_MAXZOOM="$(pmtiles show --header-json "$PEAKS_SOURCE" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["maxzoom"])')"
  # Versioned like the avalanche artifact: a region already downloaded only fetches a
  # file whose name it does not hold, so a rebuilt summit set needs a new name to reach it.
  # Bump the number here and in build-manifest.py's ARTIFACT_KINDS together.
  extract_verified "$PEAKS_SOURCE" "$OUT_DIR/$REGION_ID-peaks-1.pmtiles" "$PEAKS_MAXZOOM" --allow-empty
else
  echo "==> summits: skipped (no peaks-global.pmtiles — run ./scripts/build-peaks.sh)"
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

if ! wants terrain-features; then
  :
elif [ -n "$TERRAIN_FEATURES_SOURCE" ]; then
  echo "==> terrain features (scree, shingle, rock, stone)"
  extract_verified "$TERRAIN_FEATURES_SOURCE" "$OUT_DIR/$REGION_ID-terrain-features.pmtiles" \
    "$TERRAIN_FEATURES_MAXZOOM" --allow-empty
else
  echo "==> terrain features: skipped (no terrain-features-global.pmtiles — run ./scripts/build-terrain-features.sh)"
fi

if ! wants terrain; then
  :
elif [ "$WANT_TERRAIN" = 1 ]; then
  echo "==> terrain"
  if [ -n "$TERRAIN_PID" ]; then
    terrain_status=0
    wait "$TERRAIN_PID" || terrain_status=$?
    TERRAIN_PID=""
    cat "$TERRAIN_LOG"
    if [ "$terrain_status" != 0 ]; then
      echo "  FAILED: pmtiles extract exited $terrain_status" >&2
      rm -f "$TERRAIN_OUT.building"
      exit 1
    fi
    finish_extract "$TERRAIN_OUT"
  else
    extract_verified "$TERRAIN_SOURCE" "$TERRAIN_OUT" "$TERRAIN_MAXZOOM"
  fi
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
