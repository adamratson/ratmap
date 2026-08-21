#!/usr/bin/env bash
# Builds places.sqlite — the offline search index (C9: local FTS5, no geocoding API,
# no key or quota, queries never leave the device).
#
# Same OSM sources as the peaks build; this extracts settlements *and* summits so one
# search box covers both ("Fort William" and "Ben Nevis").
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd python3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults to the same small region as build-peaks.sh — see that script for how to point
# this at continent-scale sources.
PLACES_SOURCE_URLS="${PLACES_SOURCE_URLS:-${PEAKS_SOURCE_URLS:-https://download.geofabrik.de/europe/united-kingdom/scotland-latest.osm.pbf}}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

geojsons=()
i=0
for url in $PLACES_SOURCE_URLS; do
  i=$((i + 1))
  src="$WORK_DIR/source-$i.osm.pbf"
  echo "Downloading $url"
  curl -sL "$url" -o "$src"

  # Settlements and summits in one pass.
  osmium tags-filter "$src" \
    n/place=city,town,village,hamlet,suburb \
    n/natural=peak,volcano,saddle \
    n/mountain_pass=yes \
    -o "$WORK_DIR/filtered-$i.osm.pbf" --overwrite
  rm -f "$src"

  osmium export "$WORK_DIR/filtered-$i.osm.pbf" \
    -o "$WORK_DIR/places-$i.geojson" --overwrite -a id
  geojsons+=("$WORK_DIR/places-$i.geojson")
done

# Reuse the peaks elevation normalizer so `ele` is a real number here too — the search
# results show elevation, and "~340" would render as junk.
normalized=()
for f in "${geojsons[@]}"; do
  python3 "$SCRIPT_DIR/normalize-peaks.py" "$f" "$f.norm"
  normalized+=("$f.norm")
done

OUT="$DIST_DIR/places.sqlite"
rm -f "$OUT"
python3 "$SCRIPT_DIR/build-places-db.py" "${normalized[@]}" "$OUT"

ls -lh "$OUT"
echo "Built $OUT"
