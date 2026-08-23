#!/usr/bin/env bash
# Builds a region's contour artifact (Phase 3).
#
#   ./build-contours.sh <region-id>
#
# Source is Copernicus GLO-30 on AWS Open Data, read as Cloud-Optimized GeoTIFF through
# GDAL's /vsicurl — so only the bytes covering the region's bbox are fetched, not the
# whole global DEM. Same posture as the pmtiles extracts: no giant download, and nothing
# generated in the browser (C14).
#
# Note this is a *different* DEM from the hillshade terrain (Mapterhorn/terrarium). Both
# ultimately derive from Copernicus, but hillshade needs pre-encoded raster tiles while
# contours need real elevation values to trace lines through.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd gdalbuildvrt
require_cmd gdal_translate
require_cmd gdal_contour
require_cmd ogr2ogr
require_cmd tippecanoe
require_cmd python3

REGION_ID="${1:?Usage: build-contours.sh <region-id>}"
REGIONS_JSON="$INFRA_DIR/regions.json"

if ! REGION_VARS="$(python3 - "$REGIONS_JSON" "$REGION_ID" <<'PY_INNER'
import json, shlex, sys
with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
match = next((r for r in regions if r["id"] == sys.argv[2]), None)
if match is None:
    sys.exit(f"Unknown region '{sys.argv[2]}'. Known: {', '.join(r['id'] for r in regions)}")
w, s, e, n = match["bbox"]
print(f"REGION_NAME={shlex.quote(match['name'])}")
print(f"WEST={w}"); print(f"SOUTH={s}"); print(f"EAST={e}"); print(f"NORTH={n}")
PY_INNER
)"; then
  exit 1
fi
eval "$REGION_VARS"

# 10 m base interval with every 5th (50 m) tagged as an index contour — the convention on
# UK hill maps. §8.3 (contour interval and styling) is still formally open and wants a
# cartographic call on real target regions; this is a defensible default, not a decision.
CONTOUR_INTERVAL="${CONTOUR_INTERVAL:-10}"
INDEX_EVERY="${INDEX_EVERY:-50}"

# Contours are meaningless when zoomed out and enormous if tiled that far down, so they
# start at z11. z14 is the practical detail ceiling for 30 m-resolution source data.
CONTOUR_MINZOOM="${CONTOUR_MINZOOM:-11}"
CONTOUR_MAXZOOM="${CONTOUR_MAXZOOM:-14}"

OUT_DIR="$DIST_DIR/regions/$REGION_ID"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$REGION_ID-contours.pmtiles"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# GDAL only range-reads remote files whose extension it has been told to trust.
export CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif

echo "Region: $REGION_NAME ($REGION_ID)"
echo "  bbox: $WEST,$SOUTH,$EAST,$NORTH"
echo "  interval: ${CONTOUR_INTERVAL} m (index every ${INDEX_EVERY} m), zoom ${CONTOUR_MINZOOM}-${CONTOUR_MAXZOOM}"
echo

# Copernicus tiles are 1°x1°, named by their south-west corner.
echo "==> resolving Copernicus GLO-30 tiles"
python3 - "$WEST" "$SOUTH" "$EAST" "$NORTH" > "$WORK_DIR/tiles.txt" <<'PY'
import math, sys
west, south, east, north = (float(v) for v in sys.argv[1:5])
base = "https://copernicus-dem-30m.s3.amazonaws.com"
for lat in range(math.floor(south), math.ceil(north)):
    for lon in range(math.floor(west), math.ceil(east)):
        ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
        ew = f"{'W' if lon < 0 else 'E'}{abs(lon):03d}"
        name = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
        print(f"/vsicurl/{base}/{name}/{name}.tif")
PY
wc -l < "$WORK_DIR/tiles.txt" | xargs echo "  tiles:"

gdalbuildvrt -input_file_list "$WORK_DIR/tiles.txt" "$WORK_DIR/dem.vrt" >/dev/null

echo "==> clipping DEM to bbox"
gdal_translate -q -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
  -of GTiff "$WORK_DIR/dem.vrt" "$WORK_DIR/clip.tif"

echo "==> tracing contours"
gdal_contour -q -a ele -i "$CONTOUR_INTERVAL" -f GeoJSON \
  "$WORK_DIR/clip.tif" "$WORK_DIR/contours.geojson"

# Index contours are tagged here rather than computed in a style expression: doing it once
# at build time keeps the renderer trivial and avoids float modulo in the style.
# GeoJSONSeq (line-delimited) so tippecanoe streams rather than loading one huge document.
echo "==> tagging index contours"
ogr2ogr -f GeoJSONSeq "$WORK_DIR/contours-idx.geojsonl" "$WORK_DIR/contours.geojson" \
  -dialect SQLite \
  -sql "SELECT geometry, ele, (CAST(ele AS INTEGER) % $INDEX_EVERY = 0) AS idx FROM contour"

echo "==> tiling"
tippecanoe -o "$OUT" \
  -Z"$CONTOUR_MINZOOM" -z"$CONTOUR_MAXZOOM" \
  --simplification=4 \
  --no-tile-size-limit \
  -l contours -n "ratmap contours $REGION_ID" --force \
  "$WORK_DIR/contours-idx.geojsonl" 2>&1 | tail -1

pmtiles verify "$OUT" >/dev/null
echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "Next: python3 ./scripts/build-manifest.py && ./scripts/upload.sh"
