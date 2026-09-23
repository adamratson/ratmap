#!/usr/bin/env bash
# Fetch a Copernicus GLO-30 DEM clipped to a bbox.
#
#   fetch-dem.sh <west> <south> <east> <north> <out.tif> [target-degrees-per-pixel]
#
# `-` for <out.tif> fills the cache and writes nothing else. That is how the contours
# stage fetches the next regions' DEMs while the current one traces (build-global.sh).
#
# Shared by build-contours.sh and build-avalanche.sh (native 30 m) and the prominence step
# in build-peaks.sh (coarser). Reads the published COGs through GDAL's /vsicurl, so only
# the bytes covering the bbox move — and when a coarser resolution is requested GDAL serves
# it from the COGs' own overviews rather than pulling full resolution and throwing it away.
# Scotland's bbox (99 sq°) at 90 m is a 573 MB raster before compression; at 30 m it would
# be nine times that.
#
# Only cells containing land are published, so an all-ocean cell 404s. Availability is
# checked up front and reported: a missing *land* tile would leave a silent hole, and that
# must be obvious rather than buried in a GDAL warning.
#
# Cached in DEM_CACHE_DIR (lib.sh; set it empty to disable). GLO-30 is a static dataset
# and this fetch is the slow half of every consumer — Scotland at 90 m is 138-172 s of
# /vsicurl reads against 22 s of prominence compute (measured 2026-09-23) — so a rebuild
# of peaks, contours or avalanche should not pay for it again. It is also what lets the
# avalanche stage reuse the contours stage's DEMs: both call this with the same bbox
# strings from regions.json, so they land on the same key. Only a fetch whose every tile
# was accounted for is ever cached (see check_one).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd gdalbuildvrt
require_cmd gdal_translate

WEST="${1:?usage: fetch-dem.sh W S E N out.tif [res]}"
SOUTH="${2:?}"; EAST="${3:?}"; NORTH="${4:?}"; OUT="${5:?}"
RES="${6:-}"

export CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif

# Bump the version whenever anything below changes what a given bbox fetches — tile
# selection, ordering, resampling — so no cache written by older logic is ever reused.
# v1: sorted tile list, single-threaded VRT (see VRT_NUM_THREADS below).
CACHE_KEY="glo30-v1_${WEST}_${SOUTH}_${EAST}_${NORTH}_${RES:-native}"
CACHED=""
if [ -n "${DEM_CACHE_DIR:-}" ]; then
  CACHED="$DEM_CACHE_DIR/$CACHE_KEY.tif"
  # The .txt sidecar is written last, so its presence is what marks an entry complete.
  if [ -s "$CACHED" ] && [ -s "$DEM_CACHE_DIR/$CACHE_KEY.txt" ]; then
    echo "  DEM cache hit: $CACHE_KEY" >&2
    cat "$DEM_CACHE_DIR/$CACHE_KEY.txt" >&2
    # A copy, not a link: nothing downstream should ever be able to write through to the
    # cached file. Compressed, so the copy is small — 63 MB for Scotland at 90 m.
    [ "$OUT" = "-" ] || cp "$CACHED" "$OUT"
    exit 0
  fi
elif [ "$OUT" = "-" ]; then
  echo "fetch-dem.sh: '-' means fill the cache, and DEM_CACHE_DIR is empty" >&2
  exit 2
fi

WORK="$(mktemp -d)"
PART=""
trap 'rm -rf "$WORK"; [ -z "$PART" ] || rm -f "$PART"' EXIT

# URLs only, one per line. An earlier version emitted "label<TAB>url" pairs and split them
# in the worker — xargs collapsed the tab and every tile came back "missing", including
# ones that plainly exist. The label is recoverable from the URL, so there is no reason to
# carry a second field through a word-splitting boundary.
python3 - "$WEST" "$SOUTH" "$EAST" "$NORTH" > "$WORK/candidates.txt" <<'PY'
import math, sys
west, south, east, north = (float(v) for v in sys.argv[1:5])
base = "https://copernicus-dem-30m.s3.amazonaws.com"
for lat in range(math.floor(south), math.ceil(north)):
    for lon in range(math.floor(west), math.ceil(east)):
        ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
        ew = f"{'W' if lon < 0 else 'E'}{abs(lon):03d}"
        name = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
        print(f"{base}/{name}/{name}.tif")
PY

total="$(wc -l < "$WORK/candidates.txt" | tr -d ' ')"
echo "  checking $total candidate DEM tiles" >&2

# Checked in parallel: a large region spans dozens of cells and serial HEAD requests
# dominate the runtime (63 tiles for Scotland).
#
# Classified by status code, not by curl's exit status. A 404 is the bucket saying "no
# such tile" — an all-ocean cell, and the one case that may be left out. Anything else (a
# timeout, a reset, a 5xx that outlived the retries) says nothing about whether the cell
# is land, and it used to be filed as "missing" all the same: one blip on a coastal tile
# became a hole in the DEM with a single stderr line to show for it. It now fails the
# fetch instead — which the cache makes non-negotiable, since a hole that got cached would
# be served to every later build. Status codes checked against the live bucket
# (2026-09-23): 200 for N46/E008, 404 for the open-Atlantic N45/W030, 000 for a host that
# does not resolve.
check_one() {
  local url="$1"
  # Copernicus_DSM_COG_10_N56_00_W005_00_DEM -> N56_W005
  local label code
  label="$(basename "$url" | sed -E 's/^Copernicus_DSM_COG_10_([NS][0-9]+)_00_([EW][0-9]+)_00_DEM\.tif$/\1_\2/')"
  # --retry covers timeouts and 408/429/5xx; --retry-connrefused the refusals it leaves
  # out. A 404 is not transient, so it comes back on the first attempt.
  code="$(curl -sI -o /dev/null -w '%{http_code}' --max-time 20 \
            --retry 3 --retry-delay 2 --retry-connrefused "$url" 2>/dev/null)" || true
  case "$code" in
    200) printf 'OK %s\n' "$url" ;;
    404) printf 'MISSING %s\n' "$label" ;;
    *)   printf 'ERROR %s %s\n' "$label" "${code:-000}" ;;
  esac
}
export -f check_one

xargs -P 16 -I{} bash -c 'check_one "$@"' _ {} < "$WORK/candidates.txt" > "$WORK/checked.txt"

errors="$(awk '/^ERROR /{printf "%s (HTTP %s) ", $2, $3}' "$WORK/checked.txt")"
if [ -n "$errors" ]; then
  echo "  could not tell whether these tiles exist: $errors" >&2
  echo "  Not a 404, so any of them may be land. Refusing to build a DEM that could have a" >&2
  echo "  hole in it — re-run to retry." >&2
  exit 1
fi

# Sorted, in the C locale, because the VRT's source order decides the seams — see
# VRT_NUM_THREADS below. LC_ALL=C because the image runs C.UTF-8 and a laptop may not.
awk '/^OK /{print "/vsicurl/" $2}' "$WORK/checked.txt" | LC_ALL=C sort > "$WORK/tiles.txt"
missing="$(awk '/^MISSING /{print $2}' "$WORK/checked.txt" | LC_ALL=C sort | tr '\n' ' ')"
usable="$(wc -l < "$WORK/tiles.txt" | tr -d ' ')"

{
  echo "  usable tiles: $usable of $total"
  if [ -n "$missing" ]; then
    echo "  not published (expected for all-ocean cells): $missing"
  fi
} > "$WORK/report.txt"
cat "$WORK/report.txt" >&2
if [ "$usable" -eq 0 ]; then
  echo "No DEM tiles available for this bbox — nothing to do." >&2
  exit 1
fi

gdalbuildvrt -input_file_list "$WORK/tiles.txt" "$WORK/dem.vrt" >/dev/null

# One thread for the VRT, or the DEM is different every time.
#
# GDAL reads a VRT's sources in parallel by default (NUM_THREADS open option, then
# VRT_NUM_THREADS, then GDAL_NUM_THREADS, default ALL_CPUS — frmts/vrt/vrtdataset.cpp,
# read at v3.10.3, the image's version) whenever a request is >= 1 Mpx and the sources'
# bounding boxes do not overlap. Copernicus tiles abut exactly, so they pass that check —
# but a downsampled or resampled read maps both neighbours onto the pixels straddling a
# seam, and the threads race to write them. Measured 2026-09-23: two identical Scotland
# 90 m fetches differed in 7,843 pixels, every one on a 1-degree seam, by up to 53 m;
# Switzerland in 2,500-4,500 per pair of runs, by up to 109 m, with the tile list already
# sorted. Single-threaded, the sources are painted in list order, so the sorted list above
# makes the result the same on every run and every host: two Switzerland fetches
# byte-identical, differing from the threaded ones only on seam pixels.
#
# It costs time on a cache miss — the threads were also fetching tiles in parallel
# (Switzerland at 90 m: 66-70 s threaded, 156-220 s without) — which the cache repays on
# every later build, and which callers win back by fetching several regions at once
# (three at once: 70 s against 146 s one after another, identical output).
export VRT_NUM_THREADS=1

# Written compressed. The pixels are identical either way (same `gdalinfo -checksum`), so
# nothing that reads this can tell the difference except by its size. DEFLATE with the
# floating-point predictor takes land to 50-70% of raw (eight Balkan and northern England
# regions at 90 m: 232 MB against 410 MB) and sea to almost nothing (Scotland, mostly sea
# by area: 63 MB against 573 MB), measured 2026-09-23. It keeps the cache and every
# consumer's scratch space smaller. Threaded compression writes the same bytes as
# unthreaded, 3.7x faster.
CREATE_OPTS=(-co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=3 -co BIGTIFF=IF_SAFER
             -co NUM_THREADS=ALL_CPUS)

# A bounded block cache, so a caller running several fetches at once (the prominence pass
# runs three) knows what each can hold. The image sets GDAL_CACHEMAX=2048 for the whole
# pipeline, and a big region's fetch would fill it; a straight copy like this one does not
# need it. Bosnia at 90 m: 229 MB peak with 2048, 236 MB with 256, 147 s against 158 s —
# within the network's own noise — and the same bytes out (2026-09-23).
CACHE_OPTS=(--config GDAL_CACHEMAX 512)

# Cache-only, the raster is written straight to its temporary name in the cache: no copy
# for a caller that wants none.
DEST="$OUT"
if [ "$OUT" = "-" ]; then
  mkdir -p "$DEM_CACHE_DIR"
  PART="$CACHED.part.$$"
  DEST="$PART"
fi

# `-r max` when downsampling: averaging would erode summits, which are exactly what both
# consumers care about.
if [ -n "$RES" ]; then
  gdal_translate -q "${CACHE_OPTS[@]}" -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
    -tr "$RES" "$RES" -r max -of GTiff "${CREATE_OPTS[@]}" "$WORK/dem.vrt" "$DEST"
else
  gdal_translate -q "${CACHE_OPTS[@]}" -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
    -of GTiff "${CREATE_OPTS[@]}" "$WORK/dem.vrt" "$DEST"
fi

if [ -n "$CACHED" ]; then
  mkdir -p "$DEM_CACHE_DIR"
  # Into place atomically, raster first and report last: a run killed part-way leaves at
  # worst a .part file (removed by the EXIT trap), never an entry that reads as complete.
  if [ -z "$PART" ]; then
    PART="$CACHED.part.$$"
    cp "$OUT" "$PART"
  fi
  mv -f "$PART" "$CACHED"
  PART=""
  cp "$WORK/report.txt" "$DEM_CACHE_DIR/$CACHE_KEY.txt.part.$$"
  mv -f "$DEM_CACHE_DIR/$CACHE_KEY.txt.part.$$" "$DEM_CACHE_DIR/$CACHE_KEY.txt"
fi
