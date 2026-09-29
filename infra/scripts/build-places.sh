#!/usr/bin/env bash
# Builds the offline search indexes (C9: local FTS5, no geocoding API, no key or quota,
# queries never leave the device):
#
#   dist/regions/<id>/<id>-places-1.sqlite   one per catalogue region, published beside its
#                                            archives and downloaded with them
#   dist/places.sqlite                       the global fallback the app ships (public/data/)
#
# Same OSM sources as the peaks build; this extracts settlements *and* summits so one
# search box covers both ("Fort William" and "Ben Nevis"). The planet's full index is a few
# hundred MB — too big to ship or to hold in a phone's memory — so it stays in WORK_DIR and
# only the cuts from it leave (tools/cmd/build-places-db/cut.go).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd go

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Same derivation as build-peaks.sh — the union of every region's `osmExtract` in
# regions.json, so a published region always has search results for it.
PLACES_SOURCE_URLS="${PLACES_SOURCE_URLS:-${PEAKS_SOURCE_URLS:-$(go_run region-osm-sources)}}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Settlements and summits in one pass.
PLACES_FILTER="n/place=city,town,village,hamlet,suburb n/natural=peak,volcano,saddle n/mountain_pass=yes"

geojsons=()
i=0
for url in $PLACES_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  # Shares build-peaks.sh's cache — running peaks then places downloads nothing twice.
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all five OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $PLACES_FILTER)"

  osmium tags-filter "$src" $PLACES_FILTER -o "$WORK_DIR/filtered-$i.osm.pbf" --overwrite

  # Line-delimited so normalize-peaks and build-places-db can stream it — a
  # continent's settlements+summits run to millions of features. See build-peaks.sh.
  osmium export "$WORK_DIR/filtered-$i.osm.pbf" \
    -o "$WORK_DIR/places-$i.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a id
  geojsons+=("$WORK_DIR/places-$i.geojsonl")
done

# Reuse the peaks elevation normalizer (tools/cmd/normalize-peaks) so `ele` is a real
# number here too — the search results show elevation, and "~340" would render as junk.
NORMALIZE_PEAKS_BIN="$(go_tool normalize-peaks "$WORK_DIR")"
normalized=()
for f in "${geojsons[@]}"; do
  "$NORMALIZE_PEAKS_BIN" "$f" "$f.norm"
  normalized+=("$f.norm")
done

# Go (tools/cmd/build-places-db); it streams rows into SQLite rather than holding them all
# first. Built from this checkout (lib.sh).
echo "==> building build-places-db"
PLACES_DB_BIN="$(go_tool build-places-db "$WORK_DIR")"

FALLBACK="$DIST_DIR/places.sqlite"
rm -f "$FALLBACK"
"$PLACES_DB_BIN" --regions "$INFRA_DIR/regions.json" --regions-out "$DIST_DIR" --fallback "$FALLBACK" \
  "${normalized[@]}" "$WORK_DIR/places-full.sqlite"

# The service worker precaches files up to 6 MiB (vite.config.ts,
# maximumFileSizeToCacheInBytes) and silently leaves out anything bigger — which would
# make search fail on an offline start with nothing said. Refused here instead.
PRECACHE_LIMIT=$((6 * 1024 * 1024))
FALLBACK_BYTES="$(wc -c < "$FALLBACK" | tr -d ' ')"
if [ "$FALLBACK_BYTES" -gt "$PRECACHE_LIMIT" ]; then
  echo "FAIL: $FALLBACK is $FALLBACK_BYTES bytes, over the app shell's $PRECACHE_LIMIT-byte precache" >&2
  echo "      limit. Lower build-places-db's --fallback-places / --fallback-summits." >&2
  exit 1
fi

ls -lh "$FALLBACK"
echo "Built $FALLBACK (copy into public/data/) and the region indexes under $DIST_DIR/regions/"
