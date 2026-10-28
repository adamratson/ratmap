#!/usr/bin/env bash
# Builds parking-global.pmtiles: OSM `amenity=parking` a walker can use — car parks, which
# on a hill map are trailheads. The Protomaps basemap carries car parks but loses the
# small unnamed ones: over the central Lake District its z15 tiles held 79 of 81 named
# public car parks and only 51 of 241 unnamed, 25 of the 181 unnamed areas under 500 m²
# that are the laybys and trailhead lots walks start from (measured against the published
# england-north-west basemap, 2026-10-28). So, like landmarks, this is its own artifact,
# and the app draws car parks from it rather than from the basemap.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-parking-1.pmtiles` out of this file with `pmtiles extract`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-sac.sh: defaults to the union of every region's `osmExtract`.
PARKING_SOURCE_URLS="${PARKING_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> building normalize-parking"
NORMALIZE_PARKING_BIN="$(go_tool normalize-parking "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_PARKING_BIN" --self-test

# Every car park. Which a walker can use — not private, not residents', not lock-up
# garages — is decided in normalize-parking, where the reasons are written down and
# tested, not in a filter expression.
PARKING_FILTER="nwr/amenity=parking"

filtered_pbfs=()
i=0
for url in $PARKING_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all the OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $PARKING_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" $PARKING_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Exported per extract and concatenated, not `osmium merge`d — the continent-seam trap
# build-terrain-features.sh documents. `--geometry-types=point,polygon`: a car park is a
# node or an area, and normalize-parking reduces the area to one point. `-a type,id` for
# the seam dedup, as in build-landmarks.sh.
: > "$WORK_DIR/parking.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a type,id \
    --geometry-types=point,polygon
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/parking.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

"$NORMALIZE_PARKING_BIN" "$WORK_DIR/parking.geojsonl" "$WORK_DIR/parking-final.geojsonl"

# Enough car parks, every one a sized point. Threshold and the Scotland count it comes
# from are in tools/cmd/check-output.
"$CHECK_OUTPUT_BIN" parking "$WORK_DIR/parking-final.geojsonl"

OUT="$DIST_DIR/parking-global.pmtiles"

# Tiled in the work directory and moved into dist/ after: see move_into_dist in lib.sh.
#
# -Z13: the app draws car parks from z13 (src/map/parking.ts), as it did from the basemap.
#
# -z15: the basemap's own ceiling.
#
# -r1: no thinning by zoom. tippecanoe's default drops 60% of points per zoom below the
# top, which would take the trailhead lot at the head of a valley off z13 at random —
# z13 basemap tiles held 8 car parks for the whole central Lake District. Collision in the
# app does the thinning instead, named and larger first (`size`); a tile that still
# overflows (a city centre) is cut back by --drop-densest-as-needed.
tippecanoe -o "$WORK_DIR/parking-global.pmtiles" -Z13 -z15 -r1 \
  --include=name --include=customers --include=size \
  -l parking -n "ratmap car parks" \
  --drop-densest-as-needed --progress-interval=10 --force \
  "$WORK_DIR/parking-final.geojsonl"

move_into_dist "$WORK_DIR/parking-global.pmtiles" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-parking-1.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
