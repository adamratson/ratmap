#!/usr/bin/env bash
# Builds peaks-global.pmtiles: natural=peak|volcano|saddle + mountain_pass=yes, keeping
# name/ele/prominence/wikidata. Needed because Protomaps v4 dropped elevation from its own
# peaks (C6) — this is ours.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe

# Space-separated .osm.pbf URLs to build from; multiple URLs are merged before filtering.
#
# For a real global peaks-global.pmtiles, override with Geofabrik's continent extracts —
# that's tens of GB combined and will take a long time, run it somewhere with disk and
# bandwidth to spare:
#   export PEAKS_SOURCE_URLS="
#     https://download.geofabrik.de/africa-latest.osm.pbf
#     https://download.geofabrik.de/antarctica-latest.osm.pbf
#     https://download.geofabrik.de/asia-latest.osm.pbf
#     https://download.geofabrik.de/australia-oceania-latest.osm.pbf
#     https://download.geofabrik.de/central-america-latest.osm.pbf
#     https://download.geofabrik.de/europe-latest.osm.pbf
#     https://download.geofabrik.de/north-america-latest.osm.pbf
#     https://download.geofabrik.de/south-america-latest.osm.pbf
#   "
# Defaults to the union of every region's `osmExtract` in regions.json, so publishing a
# region automatically gives it summits rather than silently shipping a map with none.
PEAKS_SOURCE_URLS="${PEAKS_SOURCE_URLS:-$(python3 "$(dirname "${BASH_SOURCE[0]}")/region-osm-sources.py")}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PEAKS_FILTER="n/natural=peak,volcano,saddle n/mountain_pass=yes"

filtered_pbfs=()
i=0
for url in $PEAKS_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  # Cached outside WORK_DIR so a rerun (or the places build) costs no re-download.
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all five OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $PEAKS_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" $PEAKS_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# munro=yes lives on the same natural=peak nodes the filter above already keeps in full
# (osmium tags-filter keeps every tag on a matching object, it doesn't project down to the
# filter tags), so no extra filter expression is needed here — normalize-peaks.py reads it
# straight off the export.
if [ "${#filtered_pbfs[@]}" -gt 1 ]; then
  echo "Merging ${#filtered_pbfs[@]} filtered extracts"
  osmium merge "${filtered_pbfs[@]}" -o "$WORK_DIR/peaks-raw.osm.pbf" --overwrite
else
  cp "${filtered_pbfs[0]}" "$WORK_DIR/peaks-raw.osm.pbf"
fi

# Line-delimited, not a single GeoJSON document: at planet scale this file is ~1.2 M
# features and every consumer below streams it instead of loading it whole. `-f` is
# explicit because osmium doesn't infer the format from a .geojsonl suffix, and
# `print_record_separator=false` drops the RFC8142 RS byte so each line is plain JSON.
osmium export "$WORK_DIR/peaks-raw.osm.pbf" -o "$WORK_DIR/peaks.geojsonl" \
  -f geojsonseq -x print_record_separator=false --overwrite -a id

# Clean the free-text OSM `ele` into a real number before tiling — see normalize-peaks.py.
python3 "$(dirname "${BASH_SOURCE[0]}")/normalize-peaks.py" \
  "$WORK_DIR/peaks.geojsonl" "$WORK_DIR/peaks-normalized.geojsonl"

# Compute topographic prominence from the DEM, per region bbox.
#
# This is what the zoom filter ranks on. Absolute elevation encodes an assumption about
# local terrain and does not travel: at ele>=1000 m Montenegro carries 268x Scotland's
# peaks per square degree, so a threshold tuned on one is meaningless on the other. On
# prominence the same comparison is 2.8x — which is a real difference in how mountainous
# the two places are, not an artefact of the measure. OSM's own `prominence` tag is far
# too sparse to use, so it is derived here.
#
# Peaks outside every region bbox keep no `prom` and fall back to elevation in the app.
SCRIPT_DIR_PK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROM_PY="$INFRA_DIR/.venv/bin/python"

if [ ! -x "$PROM_PY" ]; then
  echo "Missing $PROM_PY — create it with:" >&2
  echo "  python3 -m venv infra/.venv && infra/.venv/bin/pip install numpy scipy" >&2
  exit 1
fi

# 90 m rather than the DEM's native 30 m: GDAL serves it straight from the COG overviews,
# and Scotland at 30 m would be a 2.7 GB raster for no gain — prominence of a *notable*
# peak is not a 30 m-scale quantity.
PROM_RES="${PROM_DEM_RES:-0.000833333}"

# The whole catalogue in one run: the peaks are read once, each region's DEM is fetched
# (fetch-dem.sh, cached in DEM_CACHE_DIR) PROM_FETCH_WORKERS at a time, and the regions are
# scored smallest bbox first so a larger region overwrites a smaller overlapping one. This
# used to be a loop here that re-ran the script — and re-parsed every peak — once per
# region; the ordering rule and its reasons now live in compute-prominence.py's
# run_regions(). A region with no DEM keeps no prominence and is listed at the end.
"$PROM_PY" "$SCRIPT_DIR_PK/compute-prominence.py" \
  --regions "$INFRA_DIR/regions.json" \
  --fetch-dem "$SCRIPT_DIR_PK/fetch-dem.sh" \
  --res "$PROM_RES" \
  --work-dir "$WORK_DIR" \
  --fetch-workers "${PROM_FETCH_WORKERS:-3}" \
  --step "${PROM_STEP:-20}" --downsample 1 \
  "$WORK_DIR/peaks-normalized.geojsonl" "$WORK_DIR/peaks-final.geojsonl"

# Elevation regression check (plan §4 Phase 1 acceptance): a schema or parsing change that
# silently breaks `ele` should fail the build here, not be discovered on a mountain.
# Only asserts summits actually present in the sources being built.
python3 - "$WORK_DIR/peaks-final.geojsonl" <<'PYCHECK'
import json, sys

# Each value read out of a real build's output before being asserted here, not taken from
# a guidebook — OSM's `ele` is what the pipeline must preserve, and it does not always
# match the published height. Zla Kolata is tagged 2535 (commonly cited as 2534), and its
# OSM name carries the Albanian form too, so it is matched on prefix.
EXPECTED = {
    "Ben Nevis": 1345,       # Scotland — highest in the UK
    "Mont Blanc": 4808,      # only present in an Alpine build
    "Bobotov Kuk": 2523,     # Montenegro — Durmitor
    "Zla Kolata": 2535,      # Montenegro — highest point
}
TOLERANCE_M = 2

# Streamed for the same reason normalize-peaks.py is: this only ever needs the handful of
# named summits in EXPECTED, so there is no reason to materialise a planet's worth of
# features to find them.
by_name = {}
with open(sys.argv[1]) as f:
    for line in f:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        props = json.loads(line).get("properties", {})
        name, ele = props.get("name"), props.get("ele")
        if not isinstance(name, str) or not isinstance(ele, (int, float)):
            continue
        # Prefix, not equality: OSM often carries a multilingual name for a summit —
        # Zla Kolata is tagged "Zla Kolata / Kollate e Keqe". Exact matching would skip it
        # silently and the assertion would quietly stop testing anything.
        for expected_name in EXPECTED:
            if name.startswith(expected_name):
                by_name.setdefault(expected_name, ele)

checked = 0
for name, expected in EXPECTED.items():
    actual = by_name.get(name)
    if actual is None:
        print(f"  (skip {name}: not in this extract)")
        continue
    if abs(actual - expected) > TOLERANCE_M:
        sys.exit(f"FAIL: {name} ele={actual}, expected ~{expected}")
    print(f"  OK {name}: {actual} m")
    checked += 1

if checked == 0:
    print("  (no known summits in this extract — elevation assertions skipped)")
PYCHECK

# Munro count assertion (C19, same standard as the elevation check above): 282, the SMC's
# current published count, verified directly against taginfo's munro=yes usage count
# (2026-09-11) rather than taken from a guidebook. A rebuild that silently drops munros —
# a changed osmium filter, a broken tag passthrough — fails here, not on someone's phone.
python3 - "$WORK_DIR/peaks-final.geojsonl" <<'PYCHECK_MUNRO'
import json, sys

EXPECTED_MUNROS = 282

count = 0
with open(sys.argv[1]) as f:
    for line in f:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        lists = json.loads(line).get("properties", {}).get("lists", "")
        if "munro" in lists.split(";"):
            count += 1

if count == 0:
    print("  (no munro=yes nodes in this extract — count assertion skipped)")
elif count != EXPECTED_MUNROS:
    sys.exit(f"FAIL: {count} munros, expected {EXPECTED_MUNROS}")
else:
    print(f"  OK {count} munros")
PYCHECK_MUNRO

OUT="$DIST_DIR/peaks-global.pmtiles"
# Built beside OUT and renamed into place only once every check below has passed: a failed
# check used to leave the archive at OUT, and build-global.sh's peaks stage skips when OUT
# exists — so the next run called it "already built" and cut regions from it unchecked.
# Still ending in .pmtiles, since tippecanoe and pmtiles both pick the format by extension
# (anything else is written as MBTiles); the leading dot keeps a leftover from a killed run
# out of upload.sh's *.pmtiles glob.
PARTIAL="$DIST_DIR/.peaks-global.partial.pmtiles"
trap 'rm -rf "$WORK_DIR" "$PARTIAL"' EXIT
# `prom` is the computed prominence the app's zoom filter ranks on; `prominence` is OSM's
# own sparse tag, kept for reference. `lists` is the summit-list membership derived in
# normalize-peaks.py (Phase 3.5, C19).
# `--extend-zooms-if-still-dropping`: `--drop-densest-as-needed` thins even the top zoom
# when a tile is too big, and the top zoom is the complete set — the app overzooms from
# it. Found 2026-09-24 decoding the published archive: "Sandpit Hil" (-0.108, 53.832) is
# missing from its z6 tile and survives only in a neighbour's buffer. This adds zooms
# until nothing needs dropping; the app and build-region.sh both read the top zoom from
# the header, so a deeper archive needs no change anywhere else. The tile check below
# fails the build if anything is still missing.
tippecanoe -o "$PARTIAL" -zg --drop-densest-as-needed --extend-zooms-if-still-dropping \
  --include=name --include=ele --include=prom --include=prominence --include=wikidata \
  --include=lists \
  -l peaks -n "ratmap peaks" --force \
  "$WORK_DIR/peaks-final.geojsonl"

# Check the tiles, not only the input. The checks above run on the GeoJSONL; nothing
# checked what tippecanoe made of it, and the published archive went two weeks with no
# `lists` property at all — every Munro marker and badge silently absent (found
# 2026-09-24). At the top zoom tippecanoe must not have thinned anything: every peak and
# every Munro has to be there, since that is the zoom the app overzooms from.
MAXZOOM="$(pmtiles show --header-json "$PARTIAL" | python3 -c 'import json, sys; print(json.load(sys.stdin)["maxzoom"])')"
# The script goes in with -c, not as `python3 - <<EOF`: that reads the program from stdin,
# and the heredoc then *is* stdin, replacing the pipe — the script saw no tiles at all and
# failed the first global build with "0 peaks in the z7 tiles" (2026-09-24).
CHECK_TILES="$(cat <<'PYCHECK_TILES'
import json, math, re, sys

source, maxzoom = sys.argv[1], sys.argv[2]
expected = expected_munros = 0
with open(source) as f:
    for line in f:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        expected += 1
        if "munro" in json.loads(line).get("properties", {}).get("lists", "").split(";"):
            expected_munros += 1

# Streamed, a line at a time: decoded in one piece the global archive is hundreds of MB of
# JSON. tippecanoe-decode writes each tile's header on a line of its own ("zoom", "x",
# "y") and each feature on a line of its own — checked against a real extract.
#
# Counted, not matched by position: tippecanoe snaps coordinates to its tile grid, ~150 m
# at z6, so positions do not match the input's. A peak near an edge is also copied into
# the neighbouring tile's buffer, so only features inside their own tile's bounds count.
TILE = re.compile(r'"zoom": (\d+), "x": (\d+), "y": (\d+)')

def bounds(z, x, y):
    n = 2 ** z
    lat = lambda row: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * row / n))))
    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)

tile = None
count = munros = 0
for line in sys.stdin:
    match = TILE.search(line)
    if match and '"FeatureCollection"' in line:
        tile = bounds(*map(int, match.groups()))
        continue
    text = line.strip().rstrip(",")
    if tile is None or not text.startswith('{ "type": "Feature"'):
        continue
    feature = json.loads(text)
    lon, lat = feature["geometry"]["coordinates"][:2]
    west, south, east, north = tile
    if west <= lon < east and south < lat <= north:
        count += 1
        if "munro" in str(feature.get("properties", {}).get("lists", "")).split(";"):
            munros += 1

if count != expected:
    sys.exit(f"FAIL: {count} peaks in the z{maxzoom} tiles, {expected} in the input")
if munros != expected_munros:
    sys.exit(f"FAIL: {munros} munros in the z{maxzoom} tiles, {expected_munros} in the input")
print(f"  OK z{maxzoom} tiles hold all {count} peaks and {munros} munros")
PYCHECK_TILES
)"
tippecanoe-decode -z"$MAXZOOM" -Z"$MAXZOOM" "$PARTIAL" \
  | python3 -c "$CHECK_TILES" "$WORK_DIR/peaks-final.geojsonl" "$MAXZOOM"

mv "$PARTIAL" "$OUT"
pmtiles show "$OUT"
echo "Built $OUT"
