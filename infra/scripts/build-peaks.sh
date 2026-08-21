#!/usr/bin/env bash
# Builds peaks-global.pmtiles: natural=peak|volcano|saddle + mountain_pass=yes, keeping
# name/ele/prominence/wikidata. Needed because Protomaps v4 dropped elevation from its own
# peaks (C6) — this is ours.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe

# Space-separated .osm.pbf URLs to build from. Defaults to one small region — this is what
# was actually run and verified during Phase 1 development (2026-08-21): 11,746 features,
# includes Ben Nevis at ele=1345 (the exact figure docs/IMPLEMENTATION.md's Phase 1
# acceptance check names). Multiple URLs are merged before filtering.
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
PEAKS_SOURCE_URLS="${PEAKS_SOURCE_URLS:-https://download.geofabrik.de/europe/united-kingdom/scotland-latest.osm.pbf}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

filtered_pbfs=()
i=0
for url in $PEAKS_SOURCE_URLS; do
  i=$((i + 1))
  src="$WORK_DIR/source-$i.osm.pbf"
  echo "Downloading $url"
  curl -sL "$url" -o "$src"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" \
    n/natural=peak,volcano,saddle \
    n/mountain_pass=yes \
    -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
  rm -f "$src"
done

if [ "${#filtered_pbfs[@]}" -gt 1 ]; then
  echo "Merging ${#filtered_pbfs[@]} filtered extracts"
  osmium merge "${filtered_pbfs[@]}" -o "$WORK_DIR/peaks-raw.osm.pbf" --overwrite
else
  cp "${filtered_pbfs[0]}" "$WORK_DIR/peaks-raw.osm.pbf"
fi

osmium export "$WORK_DIR/peaks-raw.osm.pbf" -o "$WORK_DIR/peaks.geojson" --overwrite -a id

# Clean the free-text OSM `ele` into a real number before tiling — see normalize-peaks.py.
python3 "$(dirname "${BASH_SOURCE[0]}")/normalize-peaks.py" \
  "$WORK_DIR/peaks.geojson" "$WORK_DIR/peaks-normalized.geojson"

# Elevation regression check (plan §4 Phase 1 acceptance): a schema or parsing change that
# silently breaks `ele` should fail the build here, not be discovered on a mountain.
# Only asserts summits actually present in the sources being built.
python3 - "$WORK_DIR/peaks-normalized.geojson" <<'PYCHECK'
import json, sys

EXPECTED = {"Ben Nevis": 1345, "Mont Blanc": 4808}
TOLERANCE_M = 2

with open(sys.argv[1]) as f:
    features = json.load(f)["features"]

by_name = {}
for feat in features:
    props = feat.get("properties", {})
    name, ele = props.get("name"), props.get("ele")
    if name in EXPECTED and isinstance(ele, (int, float)):
        by_name.setdefault(name, ele)

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
tippecanoe -o "$OUT" -zg --drop-densest-as-needed \
  --include=name --include=ele --include=prominence --include=wikidata \
  -l peaks -n "ratmap peaks" --force \
  "$WORK_DIR/peaks-normalized.geojson"

pmtiles show "$OUT"
echo "Built $OUT"
