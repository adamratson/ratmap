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
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
source "$SCRIPT_DIR/lib.sh"
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
# start at z11 — that's as far out as the client (region-layers.ts) ever draws them, as a
# sparse index-only (every 5th line) preview from z11-z13 before full 10 m detail takes
# over at z13. z14 is the practical detail ceiling for 30 m-resolution source data.
CONTOUR_MINZOOM="${CONTOUR_MINZOOM:-11}"
CONTOUR_MAXZOOM="${CONTOUR_MAXZOOM:-14}"

OUT_DIR="$DIST_DIR/regions/$REGION_ID"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$REGION_ID-contours.pmtiles"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Region: $REGION_NAME ($REGION_ID)"
echo "  bbox: $WEST,$SOUTH,$EAST,$NORTH"
echo "  interval: ${CONTOUR_INTERVAL} m (index every ${INDEX_EVERY} m), zoom ${CONTOUR_MINZOOM}-${CONTOUR_MAXZOOM}"
echo

# Tile resolution, availability checking (in parallel — 16-way, dominates for a
# multi-tile region) and clipping all live in fetch-dem.sh, shared with the prominence
# step in build-peaks.sh.
echo "==> fetching DEM"
"$SCRIPT_DIR/fetch-dem.sh" "$WEST" "$SOUTH" "$EAST" "$NORTH" "$WORK_DIR/clip.tif"

echo "==> tracing contours"
# GeoJSONSeq (line-delimited), not plain GeoJSON: this is the full, unfiltered 10 m-interval
# line set for the whole region — the largest intermediate in the pipeline — and it's read
# straight back in by the next step. Classic GeoJSON is a single FeatureCollection document;
# OGR's reader for it parses the whole thing into an in-memory json-c tree before yielding a
# single feature, so a plain-GeoJSON file here forces that whole raw line set into RAM a
# second time on top of gdal_contour's own working set. GeoJSONSeq has no such document-level
# framing, so ogr2ogr below streams it feature by feature instead.
#
# Filename is "contour.geojsonl", not "contours...": a GeoJSONSeq file carries no layer-name
# metadata (there's no FeatureCollection to hang a "name" off), so OGR falls back to the
# basename for the layer name it reports — and the `-sql ... FROM contour` below has to match
# that. Plain GeoJSON doesn't have this constraint (it persists the name gdal_contour gives
# the layer, "contour", regardless of the file's own name), which is how this went unnoticed.
gdal_contour -q -a ele -i "$CONTOUR_INTERVAL" -f GeoJSONSeq \
  "$WORK_DIR/clip.tif" "$WORK_DIR/contour.geojsonl"

# Index contours are tagged here rather than computed in a style expression: doing it once
# at build time keeps the renderer trivial and avoids float modulo in the style. Output is
# GeoJSONSeq too, for the same streaming reason, so tippecanoe below never loads one huge
# document either.
echo "==> tagging index contours"
ogr2ogr -f GeoJSONSeq "$WORK_DIR/contours-idx.geojsonl" "$WORK_DIR/contour.geojsonl" \
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
