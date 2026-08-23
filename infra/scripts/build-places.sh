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

# Same derivation as build-peaks.sh — the union of every region's `osmExtract` in
# regions.json, so a published region always has search results for it.
PLACES_SOURCE_URLS="${PLACES_SOURCE_URLS:-${PEAKS_SOURCE_URLS:-$(python3 "$(dirname "${BASH_SOURCE[0]}")/region-osm-sources.py")}}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

geojsons=()
i=0
for url in $PLACES_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  # Shares build-peaks.sh's cache — running peaks then places downloads nothing twice.
  src="$(cached_osm_extract "$url")"

  # Settlements and summits in one pass.
  osmium tags-filter "$src" \
    n/place=city,town,village,hamlet,suburb \
    n/natural=peak,volcano,saddle \
    n/mountain_pass=yes \
    -o "$WORK_DIR/filtered-$i.osm.pbf" --overwrite

  # Line-delimited so normalize-peaks.py and build-places-db.py can stream it — a
  # continent's settlements+summits run to millions of features. See build-peaks.sh.
  osmium export "$WORK_DIR/filtered-$i.osm.pbf" \
    -o "$WORK_DIR/places-$i.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a id
  geojsons+=("$WORK_DIR/places-$i.geojsonl")
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
