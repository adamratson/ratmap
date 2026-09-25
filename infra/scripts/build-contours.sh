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
require_cmd tippecanoe
require_cmd python3
require_cmd go

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

# Traced in cells of this many DEM pixels a side (3600 is 1 degree of GLO-30), and this
# many at once. See "tracing contours" below for why cells. CONTOUR_CELL_GB is what one
# cell is budgeted: measured at 281 MB for a full 3600-pixel cell of synthetic mountains
# denser in contours than Corsica (2026-09-25), so 1 GB is 3-4x that. CONTOUR_WORKERS
# defaults to as many as the box can hold; build-global.sh sets it when it runs several
# regions at once.
CONTOUR_CELL_PX="${CONTOUR_CELL_PX:-3600}"
CONTOUR_CELL_GB="${CONTOUR_CELL_GB:-1}"
CONTOUR_WORKERS="${CONTOUR_WORKERS:-$(workers_for_budget "$CONTOUR_CELL_GB")}"

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

echo "==> building contour-cell"
# Compiled from this checkout on every build, never carried in the image: the pipeline is
# whatever the working copy says it is (docker/compose.yml mounts it over the image's
# copy), and a binary baked into the image would go on running old logic after the source
# changed. Go's build cache makes this a moment after the first time; in the container it
# lives under $HOME, on the /work volume. GOTOOLCHAIN=local: never fetch a toolchain.
CONTOUR_CELL_BIN="$WORK_DIR/contour-cell"
(cd "$SCRIPT_DIR/contour-cell" \
  && GOTOOLCHAIN=local go build -trimpath -buildvcs=false -o "$CONTOUR_CELL_BIN" .)

echo "==> tracing contours"
# In cells, not in one pass, and written as CSV, not GeoJSON: together they take
# gdal_contour's memory from growing with the region to a few hundred MB, whatever the
# region. Measured 2026-09-25 (synthetic mountains, local GDAL 3.13.3): a 52-Mpx DEM in
# one pass writing GeoJSONSeq, 4975 MB; in one pass writing CSV, 564 MB; in 3600-pixel
# cells writing CSV, 281 MB. Morocco is 3,488 Mpx.
#
# The CSV is most of it. GDAL's GeoJSON writers hold ~17 bytes for every byte written, for
# the life of the process (measured in contour-cell/main.go, which writes the GeoJSON
# instead); Corsica's 6.4 GB on the image's GDAL 3.10.3 (2026-09-03) is that same ratio,
# and was never the tracing. The cells are the
# rest. gdal_contour sweeps the DEM a row at a time and holds every line it has not
# finished: a line stays in memory until the sweep passes its last point
# (SegmentMerger::endOfLine, alg/marching_squares/segment_merger.h, GDAL 3.10.3), so what
# it holds grows with the region's height as well as its width (4x the height cost 80%
# more, 2x the width 7%). A cell bounds that, and GDAL's block cache, to one cell. The
# old estimate for morocco, Corsica's figure scaled by the square root of area, was 70 GB.
#
# The seams are pixel-centre lines, and each cell is traced from a window one pixel past
# them. At a raster's edge gdal_contour extrapolates half a pixel from its own side alone
# (the split squares in alg/marching_squares/square.h), so cells that merely abut would
# kink at every seam. With the overlap, the squares either side of a seam are computed
# whole, from the same pixels, in both cells; contour-cell then keeps each cell's own
# side, and the pieces meet at the same points: on a 12-cell test, every one of 14,744
# seam ends met its neighbour's exactly, and each level's total length matched a single
# pass to 1e-7. A region of one cell is not cut at all, and differs from the old single
# pass only where rounding 15 significant digits to 7 places lands a last digit
# differently (40 coordinates of a 26-Mpx test, by 1e-7 degrees).
#
# Through a VRT window (-srcwin) on the one DEM: nothing is copied.
python3 - "$WORK_DIR/clip.tif" "$CONTOUR_CELL_PX" > "$WORK_DIR/cells.txt" <<'PY_CELLS'
import json, math, subprocess, sys

info = json.loads(subprocess.run(["gdalinfo", "-json", sys.argv[1]],
                                 check=True, capture_output=True, text=True).stdout)
width, height = info["size"]
gt = info["geoTransform"]
if gt[2] != 0 or gt[4] != 0:
    sys.exit("build-contours.sh: rotated DEM geotransform, cells assume north-up")
cell = int(sys.argv[2])

def seams(size):
    # Even cells, so none is a sliver: n cells, seams at pixel indices between them.
    n = max(1, math.ceil(size / cell))
    return [round(k * size / n) for k in range(1, n)]

def spans(size, cuts):
    # (first pixel, last pixel, low bound, high bound), bounds in pixel-centre coordinates
    # (pixel i's centre is i + 0.5), None for the region's own edge.
    edges = [None] + cuts + [None]
    for lo, hi in zip(edges, edges[1:]):
        first = 0 if lo is None else lo - 1
        last = size - 1 if hi is None else hi + 1
        yield first, last, (None if lo is None else lo + 0.5), (None if hi is None else hi + 0.5)

n = 0
for r0, r1, top, bottom in spans(height, seams(height)):
    for c0, c1, left, right in spans(width, seams(width)):
        n += 1
        x = lambda px: "-inf" if px is None else repr(gt[0] + px * gt[1])
        # Rows run south as y grows: gt[5] < 0, so the bottom seam is the smaller latitude.
        ymin = "-inf" if bottom is None else repr(gt[3] + bottom * gt[5])
        ymax = "inf" if top is None else repr(gt[3] + top * gt[5])
        xmax = "inf" if right is None else x(right)
        print(n, c0, r0, c1 - c0 + 1, r1 - r0 + 1, x(left), xmax, ymin, ymax)
PY_CELLS
CELLS="$(wc -l < "$WORK_DIR/cells.txt" | tr -d ' ')"
echo "  $CELLS cell(s) of up to ${CONTOUR_CELL_PX} px, $CONTOUR_WORKERS at a time"

trace_cell() {  # trace_cell <n> <xoff> <yoff> <xsize> <ysize> <xmin> <xmax> <ymin> <ymax>
  local n="$1" base="$WORK_DIR/cell-$1"
  gdal_translate -q -of VRT -srcwin "$2" "$3" "$4" "$5" "$WORK_DIR/clip.tif" "$base.vrt" \
    && gdal_contour -q -a ele -i "$CONTOUR_INTERVAL" -f CSV -lco GEOMETRY=AS_WKT \
         "$base.vrt" "$base.csv" \
    && "$CONTOUR_CELL_BIN" "$base.csv" "$base.geojsonl" \
         "$INDEX_EVERY" "$6" "$7" "$8" "$9" \
    && rm -f "$base.vrt" "$base.csv" \
    || { echo "  cell $n failed" >&2; return 1; }
}
export -f trace_cell
export WORK_DIR CONTOUR_CELL_BIN CONTOUR_INTERVAL INDEX_EVERY
xargs -P "$CONTOUR_WORKERS" -L 1 bash -c 'trace_cell "$@"' _ < "$WORK_DIR/cells.txt"

# Joined in cell order, each deleted as it goes: the output is the same whatever order
# the cells finished in, and the disk holds one extra cell at most, not a second copy.
: > "$WORK_DIR/contours-idx.geojsonl"
for n in $(seq 1 "$CELLS"); do
  cat "$WORK_DIR/cell-$n.geojsonl" >> "$WORK_DIR/contours-idx.geojsonl"
  rm -f "$WORK_DIR/cell-$n.geojsonl"
done

echo "==> tiling"
# Written to a temp name and only renamed to $OUT after verification — same reason as
# build-region.sh's extract_verified(): tippecanoe writing straight to the final path
# means a run killed mid-write (OOM, timeout, an interrupted docker compose) leaves a
# corrupt file sitting at the real filename with no warning. build-manifest.py's own
# fails-closed guard then refuses on it — correctly — but blocks publishing every OTHER
# region too, since it scans everything under dist/regions/. Hit for real (austria,
# 2026-09) before this fix.
#
# The temporary name still ends in .pmtiles, deliberately: tippecanoe picks its output
# *format* from the extension, and the "$OUT.building" this used to write came out as
# MBTiles ("SQLite format 3" in the header, tippecanoe 2.79.0 — the image's version), which
# then failed `pmtiles verify` — as any contours build since 0c483f6 (2026-09-04) would
# have, until this was found on 2026-09-23. The same trap build-paths.sh's comment
# describes, with the same fix. The leading dot keeps it out of upload.sh's glob, and
# build-manifest.py skips it as an unrecognised suffix should a killed run leave one behind.
TMP_OUT="$OUT_DIR/.$REGION_ID-contours.building.pmtiles"
rm -f "$TMP_OUT"
tippecanoe -o "$TMP_OUT" \
  -Z"$CONTOUR_MINZOOM" -z"$CONTOUR_MAXZOOM" \
  --simplification=4 \
  --no-tile-size-limit \
  -l contours -n "ratmap contours $REGION_ID" --force \
  "$WORK_DIR/contours-idx.geojsonl" 2>&1 | tail -1

if ! pmtiles verify "$TMP_OUT" >/dev/null 2>&1; then
  echo "FAILED verification: $(basename "$OUT") is not a valid PMTiles archive" >&2
  rm -f "$TMP_OUT"
  exit 1
fi
mv "$TMP_OUT" "$OUT"
echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
# --base-live, not a bare rebuild: this dist/ almost never holds every region in the
# catalogue (regions are built incrementally, often on different machines), and a bare
# `build-manifest.py` only knows about what's on disk right here — publishing that would
# unpublish every region it doesn't see. --base-live fetches the live manifest itself as
# the merge base; only this run's region is (re)computed, everything else carries over.
echo "Next:"
echo "  python3 ./scripts/build-manifest.py --base-live"
echo "  ./scripts/upload.sh"
