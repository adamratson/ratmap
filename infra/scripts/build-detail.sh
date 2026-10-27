#!/usr/bin/env bash
# Builds detail-global.pmtiles: the field detail a hill map draws and the basemap does not
# carry — walls and fences, power lines and pylons, gates, stiles, cattle grids and fords.
# Protomaps' tiles have no power, barrier or ford data at all (checked by decoding
# scotland-basemap z15 tiles over the Cairngorms, 2026-10-27), so, like terrain-features and
# landmarks, this is its own artifact.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-detail-1.pmtiles` out of this file with `pmtiles extract`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-sac.sh: defaults to the union of every region's `osmExtract`.
DETAIL_SOURCE_URLS="${DETAIL_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> building normalize-detail"
NORMALIZE_DETAIL_BIN="$(go_tool normalize-detail "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_DETAIL_BIN" --self-test

# Walls, fences and power lines are ways. Gates, stiles and cattle grids are nodes on a
# path, occasionally a short way across it; pylons are nodes; a ford is either the crossing
# node or the stretch of track through the water. `ford` is matched on its key alone —
# normalize-detail drops `ford=no` and keeps every value that means a crossing.
DETAIL_FILTER="w/barrier=wall,fence nw/barrier=gate,kissing_gate,stile,cattle_grid w/power=line,minor_line n/power=tower nw/ford"

filtered_pbfs=()
i=0
for url in $DETAIL_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all the OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $DETAIL_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" $DETAIL_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Exported per extract and concatenated, not `osmium merge`d — the continent-seam trap
# build-terrain-features.sh documents.
#
# --geometry-types=point,linestring: everything here is drawn as a line or a symbol. By
# default a closed way — a fence around a field — would also come out as an area.
: > "$WORK_DIR/detail.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite \
    --geometry-types=point,linestring
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/detail.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

"$NORMALIZE_DETAIL_BIN" "$WORK_DIR/detail.geojsonl" "$WORK_DIR/detail-final.geojsonl"

# Every kind present in meaningful numbers, every line a line and every symbol a point.
# Thresholds and the Scotland counts they come from are in tools/cmd/check-output.
"$CHECK_OUTPUT_BIN" detail "$WORK_DIR/detail-final.geojsonl"

OUT="$DIST_DIR/detail-global.pmtiles"

# Tiled in the work directory and moved into dist/ after: see move_into_dist in lib.sh.
#
# -Z12: power lines start at z12 (normalize-detail's minZoom), everything else later, as
# each feature's own `tippecanoe.minzoom`.
#
# -z15: the basemap's own ceiling.
#
# -r1: no thinning of points by zoom — a gate is either on its path or the walker is
# looking for one that is not there. The tile-size guard is --drop-densest-as-needed, and
# it should not fire in open country: see the measurement in docker/README.md.
tippecanoe -o "$WORK_DIR/detail-global.pmtiles" -Z12 -z15 -r1 \
  --include=kind \
  -l detail -n "ratmap field detail (walls, fences, power lines, gates, stiles, fords)" \
  --drop-densest-as-needed --progress-interval=10 --force \
  "$WORK_DIR/detail-final.geojsonl"

move_into_dist "$WORK_DIR/detail-global.pmtiles" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-detail-1.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
