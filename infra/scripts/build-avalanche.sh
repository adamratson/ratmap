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
require_cmd python3

REGION_ID="${1:?Usage: build-avalanche.sh <region-id>}"
REGIONS_JSON="$INFRA_DIR/regions.json"

PY="${AVALANCHE_PYTHON:-$INFRA_DIR/.venv/bin/python3}"
[ -x "$PY" ] || PY=python3
"$PY" -c "import numpy" 2>/dev/null || {
  echo "numpy is required (infra/.venv). See infra/README.md." >&2
  exit 1
}

# Zoom floor. Cheap (z8 was 16 kB of the 562 kB Ben Nevis pyramid) and it gives the
# region-wide "where is the steep ground" view before any detail is legible.
ZMIN="${AVALANCHE_MINZOOM:-8}"

# The maximum zoom is a property of the source data, not a preference (constraint A5).
# Copernicus GLO-30 is ~30 m; publishing finer than that would present interpolation as
# measurement. Web Mercator ground resolution at 512 px tiles is
# 40075017*cos(lat)/(2^z*512), so the cap is latitude-dependent — z11 in Scotland, z12 in
# the Alps and nearer the equator.
if ! REGION_VARS="$("$PY" - "$REGIONS_JSON" "$REGION_ID" "$ZMIN" <<'PY_INNER'
import json, math, shlex, sys

with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
match = next((r for r in regions if r["id"] == sys.argv[2]), None)
if match is None:
    sys.exit(f"Unknown region '{sys.argv[2]}'. Known: {', '.join(r['id'] for r in regions)}")
if not match.get("avalanche"):
    sys.exit(
        f"Region '{match['id']}' does not set \"avalanche\": true in regions.json. "
        "This artifact is opt-in per region (A8) — add the flag if it is wanted here."
    )

west, south, east, north = match["bbox"]
if not (west < east and south < north):
    sys.exit(f"Region '{match['id']}' has an invalid bbox {match['bbox']}.")

DEM_METRES = 30.0
EQUATOR = 40075016.685578488
lat = math.radians((south + north) / 2)

# Round *up*, not down. Under-resolving a slope raster smooths gradients and reports
# terrain as gentler than it is — the same direction of error as A1, and the one that
# matters. Mild oversampling of a 30 m DEM costs bytes and loses nothing; the app draws
# the layer with nearest resampling above this anyway, so the cell grid stays visible and
# nobody mistakes it for finer data than it is.
zmax = math.ceil(math.log2(EQUATOR * math.cos(lat) / (512 * DEM_METRES)))
zmax = max(9, min(12, zmax))

# Never build below the zoom the app will actually draw at. region-layers.ts suppresses a
# region's own layers below ceil(log2(360/span)) — a `pmtiles extract` keeps whole upstream
# tiles, so low-zoom tiles span far more than the region and would paint a hard-edged
# rectangle across the map. Building levels nobody renders is pure waste: for Liechtenstein
# that floor is z11, so z8-z10 would have been three levels of nothing.
span = max(east - west, north - south)
zmin = max(int(sys.argv[3]), math.ceil(math.log2(360 / span)))
zmin = min(zmin, zmax)

# Snap the extent to the tile grid at the *finest* level. Snapping at the coarsest instead
# is what the first version did, and a z8 tile is 156 km across — Liechtenstein's 18x25 km
# box inflated to a 313x313 km raster, 268 megapixels of mostly nothing, and a class
# histogram diluted to 1% steep ground. Aligning at zmax keeps the raster tight; the
# origin is then a multiple of 512 px there and stays pixel-aligned through every halving.
HALF = EQUATOR / 2
def to_merc(lon, latitude):
    x = lon * HALF / 180.0
    y = math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)) * HALF / math.pi
    return x, y

x0, y0 = to_merc(west, south)
x1, y1 = to_merc(east, north)
tile = 2 * HALF / (2 ** zmax)
ax0 = math.floor((x0 + HALF) / tile) * tile - HALF
ay0 = math.floor((y0 + HALF) / tile) * tile - HALF
ax1 = math.ceil((x1 + HALF) / tile) * tile - HALF
ay1 = math.ceil((y1 + HALF) / tile) * tile - HALF

print(f"REGION_NAME={shlex.quote(match['name'])}")
print(f"BBOX={shlex.quote(','.join(str(c) for c in match['bbox']))}")
print(f"WEST={west}"); print(f"SOUTH={south}"); print(f"EAST={east}"); print(f"NORTH={north}")
print(f"ZMAX={zmax}"); print(f"ZMIN={zmin}")
# Quoted so `eval` assigns all four numbers to TE; the caller then leaves `$TE` unquoted
# so it word-splits back into gdalwarp's four -te arguments.
print(f"TE={shlex.quote(f'{ax0} {ay0} {ax1} {ay1}')}")
print(f"RES={2 * HALF / (2 ** zmax) / 512}")
PY_INNER
)"; then
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

# The maths that decides which slopes get drawn earns a test of its own, run on every
# build — same standard as normalize-sac.py. Its last case fails loudly if the Mercator
# cos(lat) correction is ever dropped, which is the regression that would otherwise ship a
# map reading 21 degrees for a 36-degree slope.
echo "==> checking the slope maths"
"$PY" "$SCRIPT_DIR/encode-avalanche.py" --self-test

echo "==> fetching DEM"
"$SCRIPT_DIR/fetch-dem.sh" "$WEST" "$SOUTH" "$EAST" "$NORTH" "$WORK_DIR/clip.tif"

echo "==> warping to the tile grid"
# Bilinear here, on *elevation*, before any derivative is taken — resampling the DEM is
# ordinary, and the alternative (resampling a finished slope raster) would smooth the
# gradients themselves.
gdalwarp -q -t_srs EPSG:3857 -te $TE -tr "$RES" "$RES" -r bilinear \
  "$WORK_DIR/clip.tif" "$WORK_DIR/dem.tif"

# Slope, aspect, and the whole pyramid in one pass. The reduction lives in the Python,
# not in `gdal_translate -r max`: GDAL does not implement max reduction and falls back to
# nearest with only a warning ("GDAL_RASTERIO_RESAMPLING = max not supported"), which
# would build a pyramid that loses exactly the steep pockets A4 exists to keep — silently,
# and looking entirely normal.
echo "==> slope, aspect and pyramid"
"$PY" "$SCRIPT_DIR/encode-avalanche.py" \
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

# Lossless WebP by default: measured 61% of PNG on this region, and assemble-avalanche.py
# decodes every re-encoded tile back and compares it byte for byte before accepting the
# pass, so the size win costs no trust. AVALANCHE_NO_WEBP=1 falls back to PNG.
WEBP_FLAG="--webp"
[ -n "${AVALANCHE_NO_WEBP:-}" ] && WEBP_FLAG=""

# Cores this region may use for the WebP pass. The stage builds several regions at once
# (RATMAP_AVALANCHE_PARALLEL, 4 by default), and assemble-avalanche.py otherwise runs a
# thread per core in each of them — four times the machine's cores in `cwebp` processes,
# which queues rather than goes faster. Dividing gives each region a share.
#
# `getconf` rather than `nproc`: nproc is GNU coreutils and absent on a Mac, where this
# script is run by hand often enough to matter. Floor of 1, so an over-large outer number
# cannot silently ask for zero.
AVALANCHE_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
AVALANCHE_JOBS=$(( AVALANCHE_CORES / ${RATMAP_AVALANCHE_PARALLEL:-1} ))
[ "$AVALANCHE_JOBS" -lt 1 ] && AVALANCHE_JOBS=1

echo "==> tiling"
# shellcheck disable=SC2086
"$PY" "$SCRIPT_DIR/assemble-avalanche.py" \
  --out "$WORK_DIR/out.mbtiles" \
  --name "ratmap avalanche terrain $REGION_ID" \
  --bounds "$BBOX" \
  --jobs "$AVALANCHE_JOBS" \
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
echo "  python3 ./scripts/build-manifest.py --base-live"
echo "  ./scripts/upload.sh"
