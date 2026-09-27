#!/usr/bin/env bash
# Builds a region's avalanche terrain artifact (Phase 4.6).
#
#   ./build-avalanche.sh <region-id>
#
# Output: dist/regions/<id>/<id>-avalanche-1.pmtiles — a raster pyramid carrying
# R = slope in whole degrees, G = aspect octant, B = runout (0 until Stage B).
#
# **This layer shows avalanche *terrain*, never avalanche *risk*.** Danger is terrain x
# snowpack x weather and this pipeline has one of the three, permanently. See
# plans/avalanche-terrain.md §1 — the naming is a safety property, not a preference.
#
# Source is Copernicus GLO-30 read as COG through GDAL's /vsicurl, exactly like
# build-contours.sh: only the region's bbox moves, nothing is generated in the browser
# (C14), and no third-party live feed is involved anywhere.
#
# Gated on `"avalanche": true` in regions.json — this is a mountain artifact and building
# it for the whole global catalogue would be CPU and bytes spent on flat ground.
#
# The trailing `-1` in the filename is a **content version**, and it is load-bearing:
# `downloadArtifact` skips an artifact whose filename is already in OPFS
# (src/regions/downloader.ts:355), so a rebuilt file under an unchanged name would never
# reach anyone who already has the region. Stage B's runout channel publishes `-2`.
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
source "$SCRIPT_DIR/lib.sh"
require_cmd gdalwarp
require_cmd gdal_translate
require_cmd pmtiles

REGION_ID="${1:?Usage: build-avalanche.sh <region-id>}"
REGIONS_JSON="$INFRA_DIR/regions.json"

require_cmd go

# Zoom floor. Cheap (z8 was 16 kB of the 562 kB Ben Nevis pyramid) and it gives the
# region-wide "where is the steep ground" view before any detail is legible.
ZMIN="${AVALANCHE_MINZOOM:-8}"

# The maximum zoom is a property of the source data, not a preference (constraint A5).
# Copernicus GLO-30 is ~30 m; publishing finer than that would present interpolation as
# measurement. Web Mercator ground resolution at 512 px tiles is
# 40075017*cos(lat)/(2^z*512), so the cap is latitude-dependent — z11 in Scotland, z12 in
# the Alps and nearer the equator.
if ! REGION_VARS="$(go_run catalog region-vars avalanche "$REGIONS_JSON" "$REGION_ID" "$ZMIN")"; then
  exit 1
fi
eval "$REGION_VARS"

OUT_DIR="$DIST_DIR/regions/$REGION_ID"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$REGION_ID-avalanche-1.pmtiles"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Region: $REGION_NAME ($REGION_ID)"
echo "  bbox: $BBOX"
echo "  zoom $ZMIN-$ZMAX (capped at the DEM's own ~30 m resolution)"
echo

# Slope, aspect and the pyramid are Go (tools/cmd/encode-avalanche), the port of
# encode-avalanche.py: the same files out, without numpy. Built from this checkout
# (lib.sh), into this region's own WORK_DIR.
echo "==> building encode-avalanche and assemble-avalanche"
ENCODE_BIN="$(go_tool encode-avalanche "$WORK_DIR")"
ASSEMBLE_BIN="$(go_tool assemble-avalanche "$WORK_DIR")"

# The maths that decides which slopes get drawn earns a test of its own, run on every
# build — same standard as normalize-sac. Its last case fails loudly if the Mercator
# cos(lat) correction is ever dropped, which is the regression that would otherwise ship a
# map reading 21 degrees for a 36-degree slope.
echo "==> checking the slope maths"
"$ENCODE_BIN" --self-test

# A 512 MB GDAL block cache for everything below — the warp, the level rasters and
# assemble-avalanche's tiling, which inherits it — where the image sets 2048 for the whole
# pipeline. Every one of them streams and fills whatever cache it is given, so with 2048 a
# region's cost grew with the region: the warp peaked at 1209 MB for Aragón and 1460 MB
# for Switzerland, against 1078 MB and 1042 MB capped, and ran no slower (2026-09-27).
# Capped, a region costs the same ~1.1 GB whatever its size, which is what
# build-global.sh's avalanche budget assumes. fetch-dem.sh caps its own at the same figure.
export GDAL_CACHEMAX=512

echo "==> fetching DEM"
"$SCRIPT_DIR/fetch-dem.sh" "$WEST" "$SOUTH" "$EAST" "$NORTH" "$WORK_DIR/clip.tif"

echo "==> warping to the tile grid"
# Bilinear here, on *elevation*, before any derivative is taken — resampling the DEM is
# ordinary, and the alternative (resampling a finished slope raster) would smooth the
# gradients themselves.
gdalwarp -q -t_srs EPSG:3857 -te $TE -tr "$RES" "$RES" -r bilinear \
  "$WORK_DIR/clip.tif" "$WORK_DIR/dem.tif"

# Slope, aspect, and the whole pyramid in one pass. The reduction lives in the encoder,
# not in `gdal_translate -r max`: GDAL does not implement max reduction and falls back to
# nearest with only a warning ("GDAL_RASTERIO_RESAMPLING = max not supported"), which
# would build a pyramid that loses exactly the steep pockets A4 exists to keep — silently,
# and looking entirely normal.
echo "==> slope, aspect and pyramid"
"$ENCODE_BIN" \
  --zmax "$ZMAX" --zmin "$ZMIN" --stats-json "$WORK_DIR/stats.json" \
  "$WORK_DIR/dem.tif" "$WORK_DIR"

LEVELS=""
for z in $(seq "$ZMIN" "$ZMAX"); do
  LEVELS="$LEVELS $z:$WORK_DIR/rgb-$z.vrt"
done

# One RGB view per level. B is an all-zero band held for Stage B's runout channel; it is
# produced by scaling the slope raster's whole range onto 0..0, which needs no extra file
# and no arithmetic driver.
for z in $(seq "$ZMIN" "$ZMAX"); do
  gdal_translate -q -ot Byte -scale 0 255 0 0 \
    "$WORK_DIR/slope-$z.tif" "$WORK_DIR/zero-$z.tif"
  gdalbuildvrt -q -separate "$WORK_DIR/rgb-$z.vrt" \
    "$WORK_DIR/slope-$z.tif" "$WORK_DIR/aspect-$z.tif" "$WORK_DIR/zero-$z.tif"
done

# Lossless WebP by default: measured 61% of PNG on this region, and assemble-avalanche
# decodes every re-encoded tile back and compares it byte for byte before accepting the
# pass, so the size win costs no trust. AVALANCHE_NO_WEBP=1 falls back to PNG.
WEBP_FLAG="--webp"
[ -n "${AVALANCHE_NO_WEBP:-}" ] && WEBP_FLAG=""

# Cores this region may use for the WebP pass.
#
# Only set when the *stage* is building several regions at once
# (RATMAP_AVALANCHE_PARALLEL): assemble-avalanche would otherwise take its own share in
# each of them, which is several times the machine's cores in `cwebp` processes and queues
# rather than goes faster. Dividing gives each region a slice of one budget.
#
# Left unset for a plain single-region run, so assemble-avalanche applies its own
# default of half the cores. Passing an explicit job count here used to override that with
# *every* core — which is what made the first Aragón run take the laptop down with it.
#
# `getconf` rather than `nproc`: nproc is GNU coreutils and absent on a Mac, where this
# script is run by hand often enough to matter. Floor of 1, so an over-large outer number
# cannot silently ask for zero.
JOBS_FLAG=""
if [ -n "${RATMAP_AVALANCHE_PARALLEL:-}" ]; then
  AVALANCHE_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  AVALANCHE_JOBS=$(( AVALANCHE_CORES / RATMAP_AVALANCHE_PARALLEL ))
  [ "$AVALANCHE_JOBS" -lt 1 ] && AVALANCHE_JOBS=1
  JOBS_FLAG="--jobs=$AVALANCHE_JOBS"
fi

echo "==> tiling"
# `--bounds=` with an equals sign, not a space. A bbox whose western longitude is negative
# starts with `-`, which a parser can read as an option name rather than a value: under
# the Python's argparse every region west of Greenwich died with "argument --bounds:
# expected one argument". Go's flag package would take it either way; the equals sign
# keeps it unambiguous for any parser.
# shellcheck disable=SC2086
"$ASSEMBLE_BIN" \
  --out "$WORK_DIR/out.mbtiles" \
  --name "ratmap avalanche terrain $REGION_ID" \
  --bounds="$BBOX" \
  $JOBS_FLAG \
  $WEBP_FLAG \
  $LEVELS

echo "==> converting"
# Built under a temporary name and only moved into place after verification — an
# interrupted convert leaves a file of plausible size whose header is all zeros, which
# looks fine in `ls` and fails only when a phone tries to read it. Same guard as
# build-region.sh's extract_verified().
TMP_OUT="$OUT.building"
rm -f "$TMP_OUT"
pmtiles convert "$WORK_DIR/out.mbtiles" "$TMP_OUT" 2>&1 | tail -1
if ! pmtiles verify "$TMP_OUT" >/dev/null 2>&1; then
  echo "FAILED verification: $(basename "$OUT") is not a valid PMTiles archive" >&2
  rm -f "$TMP_OUT"
  exit 1
fi
mv "$TMP_OUT" "$OUT"

echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "Next:"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
