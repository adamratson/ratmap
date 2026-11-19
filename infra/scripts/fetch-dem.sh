#!/usr/bin/env bash
# Fetch a DEM clipped to a bbox, in EPSG:4326.
#
#   fetch-dem.sh <west> <south> <east> <north> <out.tif> [target-degrees-per-pixel]
#
# `-` for <out.tif> fills the cache and writes nothing else. That is how the contours
# stage fetches the next regions' DEMs while the current one traces (build-global.sh).
#
# Shared by build-contours.sh and build-avalanche.sh (native resolution) and the prominence
# step in build-peaks.sh (coarser, with the true maximum of each coarse cell).
#
# **The source is Mapterhorn** (DEM_SOURCE=mapterhorn, the default): its planet.pmtiles,
# the same terrain the hillshade is cut from, at the zoom whose pixel is about GLO-30's. Mapterhorn merges ~150 national DEMs
# over Copernicus GLO-30, and wherever a country publishes lidar or a fine national model
# — all of England, the Alps, Norway, France, Germany, Spain, Poland: 131 of our 184
# regions have finer data than GLO-30 under at least half their land — that is what its
# z11 tiles are made from, downsampled. GLO-30 is a 30 m radar *surface* model: it reads
# the tops of trees and buildings, and smooths crags away. Measured on the 415 OSM
# summits with a surveyed `ele` in the central Lakes (2026-11-18), the highest point within
# 20 m of each:
#
#                 median error   within 5 m
#   GLO-30           4.7 m          55%
#   Mapterhorn z11   2.4 m          91%
#   Mapterhorn z12   1.3 m          97%
#
# That zoom is the coarsest whose pixel is no coarser than 30 m at the bbox's middle
# latitude — the rule build-avalanche.sh's zoom cap uses — because a Web Mercator pixel
# shrinks with latitude: z11 for Britain, the Alps and southern Norway (22, 27 and 19 m),
# z10 at 70°N, z9 for Svalbard, z12 nearer the equator. A fixed z11 would be 6.6 m at
# 80°N, tens of gigapixels for Svalbard's bbox, and 38 m at the equator, coarser than
# GLO-30. So no consumer costs more than it did. The next zoom has four times the pixels
# for the last metre; the contour tiles it makes came out only 21% bigger
# (tippecanoe's simplification absorbs most of it), but tracing and slope work scale with
# pixels, and for most of the catalogue's area that would be resampled GLO-30. Where
# Mapterhorn has nothing finer than GLO-30 (the Highlands, the Balkans, Turkey), its z11
# is GLO-30 resampled: no better, no worse.
#
# DEM_SOURCE=glo30 reads Copernicus GLO-30 itself, the source before 2026-11-18, kept
# so a Mapterhorn problem can be told from ours with one variable. Its COGs are read
# through GDAL's /vsicurl, so only the bytes covering the bbox move. Only cells containing
# land are published, so an all-ocean cell 404s. Availability is checked up front and
# reported: a missing *land* tile would leave a silent hole, and that must be obvious
# rather than buried in a GDAL warning.
#
# Cached in DEM_CACHE_DIR (lib.sh; set it empty to disable). Both sources are pinned
# (Mapterhorn by ETag, lib.sh) and this fetch is the slow half of every consumer — Scotland at 90 m is 138-172 s of
# /vsicurl reads against 22 s of prominence compute (measured 2026-09-23) — so a rebuild
# of peaks, contours or avalanche should not pay for it again. It is also what lets the
# avalanche stage reuse the contours stage's DEMs: both call this with the same bbox
# strings from regions.json, so they land on the same key. Only a fetch whose every tile
# was accounted for is ever cached (see check_one).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd gdalbuildvrt
require_cmd gdal_translate
require_cmd gdalwarp

WEST="${1:?usage: fetch-dem.sh W S E N out.tif [res]}"
SOUTH="${2:?}"; EAST="${3:?}"; NORTH="${4:?}"; OUT="${5:?}"
RES="${6:-}"

DEM_SOURCE="${DEM_SOURCE:-mapterhorn}"
case "$DEM_SOURCE" in
  mapterhorn) require_cmd pmtiles; require_cmd go; require_cmd curl ;;
  glo30) ;;
  *) echo "fetch-dem.sh: DEM_SOURCE must be mapterhorn or glo30, not '$DEM_SOURCE'" >&2; exit 2 ;;
esac

# The zoom read from Mapterhorn's planet.pmtiles: the coarsest whose 512 px pixel is no
# coarser than 30 m at the bbox's middle latitude (see the header), within the archive's
# z0-12.
MAPTERHORN_DEM_ZOOM="$(awk -v s="$SOUTH" -v n="$NORTH" 'BEGIN {
  ground = 40075016.686 * cos((s + n) / 2 * atan2(0, -1) / 180) / (512 * 30)
  z = log(ground) / log(2); zi = int(z); if (zi < z) zi++
  if (zi > 12) zi = 12; if (zi < 0) zi = 0
  print zi
}')"

export CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif

# Seconds to wait before each retry of a step that failed on the network, and so how many
# retries there are: tiles the availability check could not get an answer for are asked
# again, and a failed raster read is run again from the start. Spread over minutes because
# what failed the 2026-09-24 global run were blips that outlasted curl's own retries
# (seconds apart), on nine regions of 184, and a read that came back short on three more.
# Overridable so the retry paths can be exercised without waiting for them.
DEM_RETRY_WAITS="${DEM_RETRY_WAITS:-15 60 180}"

# Bump the version whenever anything below changes what a given bbox fetches — tile
# selection, ordering, resampling — so no cache written by older logic is ever reused.
# v1: sorted tile list, single-threaded VRT (see VRT_NUM_THREADS below).
# v2: a downsampled fetch really takes the maximum (gdalwarp; see translate below).
# Mapterhorn's key carries the pinned ETag, so a re-pin never reuses an older release.
# mapterhorn v1: zoom by latitude, absent tiles as sea level, bilinear to 4326.
mapterhorn_key() {  # mapterhorn_key <res or empty>
  local pin
  pin="$(printf '%s' "$MAPTERHORN_PLANET_ETAG" | tr -cd 'A-Za-z0-9' | cut -c1-12)"
  printf 'mapterhorn-z%s-%s-v1_%s_%s_%s_%s_%s' "$MAPTERHORN_DEM_ZOOM" "$pin" \
    "$WEST" "$SOUTH" "$EAST" "$NORTH" "${1:-native}"
}
if [ "$DEM_SOURCE" = mapterhorn ]; then
  CACHE_KEY="$(mapterhorn_key "$RES")"
else
  CACHE_KEY="glo30-v2_${WEST}_${SOUTH}_${EAST}_${NORTH}_${RES:-native}"
fi
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

# Into the cache, if there is one: raster first and report last, atomically, so a run
# killed part-way leaves at worst a .part file (removed by the EXIT trap), never an entry
# that reads as complete.
store_in_cache() {
  if [ -n "$CACHED" ]; then
    mkdir -p "$DEM_CACHE_DIR"
    if [ -z "$PART" ]; then
      PART="$CACHED.part.$$"
      cp "$OUT" "$PART"
    fi
    mv -f "$PART" "$CACHED"
    PART=""
    cp "$WORK/report.txt" "$DEM_CACHE_DIR/$CACHE_KEY.txt.part.$$"
    mv -f "$DEM_CACHE_DIR/$CACHE_KEY.txt.part.$$" "$DEM_CACHE_DIR/$CACHE_KEY.txt"
  fi
}

# Mapterhorn: `pmtiles extract` takes the bbox's tiles at that zoom out of planet.pmtiles
# (only their bytes move), terrarium-dem decodes them into a Web Mercator mosaic, and
# gdalwarp puts that on a 4326 grid as fine as the tiles: the zoom's pixel in longitude,
# and that times cos(latitude) in latitude, at the bbox's middle, so a pixel stays
# roughly square on the ground as GLO-30's are.
#
# A coarser request (the prominence pass's 3") is cut from this native DEM — from the
# cache when there is one — with the true maximum of each cell, so a region's tiles are
# downloaded once whatever asks for them.
fetch_mapterhorn() {
  if [ -n "$RES" ]; then
    local native
    if [ -n "${DEM_CACHE_DIR:-}" ]; then
      bash "${BASH_SOURCE[0]}" "$WEST" "$SOUTH" "$EAST" "$NORTH" - || exit 1
      native="$DEM_CACHE_DIR/$(mapterhorn_key "").tif"
    else
      bash "${BASH_SOURCE[0]}" "$WEST" "$SOUTH" "$EAST" "$NORTH" "$WORK/native.tif" || exit 1
      native="$WORK/native.tif"
    fi
    gdalwarp -q -overwrite "${CACHE_OPTS[@]}" -te "$WEST" "$SOUTH" "$EAST" "$NORTH" \
      -tr "$RES" "$RES" -r max -of GTiff "${CREATE_OPTS[@]}" "$native" "$DEST" \
      || { rm -f "$DEST"; exit 1; }
    echo "  Mapterhorn z$MAPTERHORN_DEM_ZOOM, the maximum of each ${RES}° cell" > "$WORK/report.txt"
    cat "$WORK/report.txt" >&2
    return
  fi

  # The pin. planet.pmtiles is republished in place, so the ETag is the only thing that
  # says which release this is (C13: never track latest). A republish fails here, loudly,
  # rather than mixing releases across regions or caching a new one under the old key.
  local etag="" wait
  for wait in $DEM_RETRY_WAITS -; do
    etag="$(curl -sfI --max-time 30 --retry 3 --retry-connrefused "$MAPTERHORN_PLANET_URL" \
      | tr -d '\r' | awk 'tolower($1) == "etag:" { print $2 }')" || true
    [ -n "$etag" ] && break
    if [ "$wait" = - ]; then
      echo "  could not read $MAPTERHORN_PLANET_URL's ETag — giving up" >&2
      exit 1
    fi
    echo "  no answer from $MAPTERHORN_PLANET_URL; asking again in ${wait}s" >&2
    sleep "$wait"
  done
  if [ "$etag" != "$MAPTERHORN_PLANET_ETAG" ]; then
    echo "  Mapterhorn has republished planet.pmtiles: its ETag is $etag, and lib.sh pins" >&2
    echo "  $MAPTERHORN_PLANET_ETAG. Check the new release (download_urls.json's \"version\")," >&2
    echo "  then set MAPTERHORN_PLANET_ETAG in lib.sh to re-pin." >&2
    exit 1
  fi

  # `pmtiles extract` checks the ETag on every request itself, so a republish mid-extract
  # fails it rather than splicing two releases. Retried as a whole, like a GLO-30 read.
  local attempt=1
  for wait in $DEM_RETRY_WAITS -; do
    pmtiles extract --bbox="$WEST,$SOUTH,$EAST,$NORTH" \
      --minzoom="$MAPTERHORN_DEM_ZOOM" --maxzoom="$MAPTERHORN_DEM_ZOOM" \
      "$MAPTERHORN_PLANET_URL" "$WORK/mh.pmtiles" > "$WORK/extract.log" 2>&1 && break
    if [ "$wait" = - ]; then
      tail -5 "$WORK/extract.log" >&2
      echo "  Mapterhorn extract failed $attempt times — giving up" >&2
      exit 1
    fi
    echo "  Mapterhorn extract failed (attempt $attempt); trying again in ${wait}s" >&2
    rm -f "$WORK/mh.pmtiles"
    sleep "$wait"
    attempt=$((attempt + 1))
  done

  local bin
  bin="$(go_tool terrarium-dem "$WORK")" || exit 1
  "$bin" "$WORK/mh.pmtiles" "$MAPTERHORN_DEM_ZOOM" "$WORK/mh.vrt" 2> "$WORK/decode.txt" \
    || { cat "$WORK/decode.txt" >&2; exit 1; }
  rm -f "$WORK/mh.pmtiles"

  local trx try
  read -r trx try < <(awk -v s="$SOUTH" -v n="$NORTH" -v z="$MAPTERHORN_DEM_ZOOM" 'BEGIN {
    x = 360 / (2 ^ z * 512)
    printf "%.17g %.17g\n", x, x * cos((s + n) / 2 * atan2(0, -1) / 180)
  }')
  # Bilinear: the grids are about the same size, so this interpolates rather than thins.
  # One thread for the strip mosaic, for the reason VRT_NUM_THREADS gives below.
  VRT_NUM_THREADS=1 gdalwarp -q -overwrite "${CACHE_OPTS[@]}" -t_srs EPSG:4326 \
    -te "$WEST" "$SOUTH" "$EAST" "$NORTH" -tr "$trx" "$try" -r bilinear \
    -of GTiff "${CREATE_OPTS[@]}" "$WORK/mh.vrt" "$DEST" || { rm -f "$DEST"; exit 1; }
  rm -rf "$WORK/mh.vrt" "$WORK/mh.vrt.d"

  {
    echo "  Mapterhorn planet.pmtiles $etag"
    cat "$WORK/decode.txt"
  } > "$WORK/report.txt"
  cat "$WORK/report.txt" >&2
}

if [ "$DEM_SOURCE" = mapterhorn ]; then
  fetch_mapterhorn
  store_in_cache
  exit 0
fi

# URLs only, one per line. An earlier version emitted "label<TAB>url" pairs and split them
# in the worker — xargs collapsed the tab and every tile came back "missing", including
# ones that plainly exist. The label is recoverable from the URL, so there is no reason to
# carry a second field through a word-splitting boundary.
go_run util dem-tiles "$WEST" "$SOUTH" "$EAST" "$NORTH" > "$WORK/candidates.txt"

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
    *)   printf 'ERROR %s %s %s\n' "$label" "${code:-000}" "$url" ;;
  esac
}
export -f check_one

check_all() {
  xargs -P 16 -I{} bash -c 'check_one "$@"' _ {}
}

check_all < "$WORK/candidates.txt" > "$WORK/checked.txt"

# Unanswered tiles are asked again, a round at a time and further apart each time; the
# answered ones stand. Order does not matter here, the tile list is sorted below.
for wait in $DEM_RETRY_WAITS; do
  grep -q '^ERROR ' "$WORK/checked.txt" || break
  echo "  no answer for $(grep -c '^ERROR ' "$WORK/checked.txt") tile(s); asking again in ${wait}s" >&2
  sleep "$wait"
  awk '/^ERROR /{print $4}' "$WORK/checked.txt" > "$WORK/retry.txt"
  grep -v '^ERROR ' "$WORK/checked.txt" > "$WORK/answered.txt" || true
  check_all < "$WORK/retry.txt" >> "$WORK/answered.txt"
  mv "$WORK/answered.txt" "$WORK/checked.txt"
done

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

# `-r max` when downsampling: averaging would erode summits, which are exactly what both
# consumers care about. Through gdalwarp, not gdal_translate: gdal_translate does not
# implement max ("Warning 6: GDAL_RASTERIO_RESAMPLING = max not supported") and quietly
# resamples another way. Measured over the central Lakes at 3" (2026-11-18): its "max"
# DEM put Scafell Pike at 967.4 m against GLO-30's own 974.0 m; gdalwarp's at 974.0 m.
# Every prominence before cache key v2 was scored from that under-read DEM. And from the
# full-resolution tiles, not the COGs' overviews (`-ovr NONE`): the overviews are already
# averaged, and the maximum of an average is not the summit — 972.1 m for Scafell Pike
# with them, 974.0 m without. It costs reading full resolution for a coarse grid.
translate() {
  if [ -n "$RES" ]; then
    gdalwarp -q -overwrite -ovr NONE "${CACHE_OPTS[@]}" -te "$WEST" "$SOUTH" "$EAST" "$NORTH" \
      -tr "$RES" "$RES" -r max -of GTiff "${CREATE_OPTS[@]}" "$WORK/dem.vrt" "$DEST"
  else
    gdal_translate -q "${CACHE_OPTS[@]}" -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
      -of GTiff "${CREATE_OPTS[@]}" "$WORK/dem.vrt" "$DEST"
  fi
}

# A failed read is retried here, as a whole new gdal_translate, because GDAL will not
# retry it. The failure seen is a range request answered 206 with a body cut short
# ("TIFFFillTile: Read error ... got 181347 bytes, expected 430907", 2026-09-24): /vsicurl
# judges a request by its status code, and 206 is success, so GDAL_HTTP_MAX_RETRY and
# GDAL_HTTP_RETRY_CODES=ALL never see it (DownloadRegion, port/cpl_vsil_curl.cpp, read at
# v3.10.3). libtiff then fails the tile and gdal_translate exits non-zero, which is at
# least loud. A new process starts with an empty /vsicurl cache, so the short read is
# fetched again rather than served from memory. Same tile list, so the same DEM.
attempt=1
for wait in $DEM_RETRY_WAITS -; do
  translate && break
  if [ "$wait" = - ]; then
    echo "  DEM read failed $attempt times — giving up" >&2
    rm -f "$DEST"  # not left looking like a DEM to whoever asked for it
    exit 1
  fi
  echo "  DEM read failed (attempt $attempt); trying again in ${wait}s" >&2
  rm -f "$DEST"
  sleep "$wait"
  attempt=$((attempt + 1))
done

store_in_cache
