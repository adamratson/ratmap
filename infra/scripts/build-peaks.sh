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

filtered_pbfs=()
i=0
for url in $PEAKS_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  # Cached outside WORK_DIR so a rerun (or the places build) costs no re-download.
  src="$(cached_osm_extract "$url")"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" \
    n/natural=peak,volcano,saddle \
    n/mountain_pass=yes \
    -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

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
PROM_IN="$WORK_DIR/peaks-normalized.geojsonl"

if [ ! -x "$PROM_PY" ]; then
  echo "Missing $PROM_PY — create it with:" >&2
  echo "  python3 -m venv infra/.venv && infra/.venv/bin/pip install numpy scipy" >&2
  exit 1
fi

# 90 m rather than the DEM's native 30 m: GDAL serves it straight from the COG overviews,
# and Scotland at 30 m would be a 2.7 GB raster for no gain — prominence of a *notable*
# peak is not a 30 m-scale quantity.
PROM_RES="${PROM_DEM_RES:-0.000833333}"

while read -r region_id w s e n; do
  echo "==> prominence: $region_id"
  dem="$WORK_DIR/dem-$region_id.tif"
  if ! bash "$SCRIPT_DIR_PK/fetch-dem.sh" "$w" "$s" "$e" "$n" "$dem" "$PROM_RES"; then
    echo "  ! no DEM for $region_id — its peaks keep no prominence" >&2
    continue
  fi
  "$PROM_PY" "$SCRIPT_DIR_PK/compute-prominence.py" \
    "$dem" "$PROM_IN" "$WORK_DIR/peaks-prom-$region_id.geojsonl" \
    --step "${PROM_STEP:-20}" --downsample 1
  PROM_IN="$WORK_DIR/peaks-prom-$region_id.geojsonl"
  rm -f "$dem"
done < <(python3 - "$INFRA_DIR/regions.json" <<'PY_REGIONS'
import json, sys
with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
# Smallest bbox first, so a larger region's pass overwrites a smaller overlapping one.
# Lochaber and Cairngorms sit inside Scotland; prominence measured in the bigger box is
# the better value, because a key col near the edge of a small box gets clipped to the
# box and the peak's prominence is over-stated. Sorting makes that independent of the
# order regions happen to appear in regions.json.
for r in sorted(regions, key=lambda r: (r["bbox"][2] - r["bbox"][0]) * (r["bbox"][3] - r["bbox"][1])):
    w, s, e, n = r["bbox"]
    print(r["id"], w, s, e, n)
PY_REGIONS
)

cp "$PROM_IN" "$WORK_DIR/peaks-final.geojsonl"

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

OUT="$DIST_DIR/peaks-global.pmtiles"
# `prom` is the computed prominence the app's zoom filter ranks on; `prominence` is OSM's
# own sparse tag, kept for reference.
tippecanoe -o "$OUT" -zg --drop-densest-as-needed \
  --include=name --include=ele --include=prom --include=prominence --include=wikidata \
  -l peaks -n "ratmap peaks" --force \
  "$WORK_DIR/peaks-final.geojsonl"

pmtiles show "$OUT"
echo "Built $OUT"
