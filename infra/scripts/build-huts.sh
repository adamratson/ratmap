#!/usr/bin/env bash
# Builds huts-global.pmtiles: where a walker can get out of the weather, sleep or fill a
# bottle — mountain huts and bothies, shelters, campsites, drinking water and springs.
#
# The Protomaps basemap keeps most of these in `pois`, but not what tells them apart: no
# `shelter_type`, so 642 of Scotland's 1,282 shelters are bus shelters with nothing to say
# so; bothies also tagged `amenity=shelter` (Corrour among them) come out as shelters; no
# drinkable taps at all; and almost none below z15 — 23 of 147 bothies in the z14 tiles,
# no springs (measured against scotland-latest.osm.pbf and the scotland-basemap tiles,
# 2026-11-18). So, like car parks, this is its own artifact, and the app draws these from
# it rather than from the basemap. See tools/cmd/normalize-huts for what is kept.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-huts-1.pmtiles` out of this file with `pmtiles extract`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-sac.sh: defaults to the union of every region's `osmExtract`.
HUTS_SOURCE_URLS="${HUTS_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> building normalize-huts"
NORMALIZE_HUTS_BIN="$(go_tool normalize-huts "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_HUTS_BIN" --self-test

# Every member of each family. Which are cover for a walker, which water is drinking water
# and who may use them is decided in normalize-huts, where the reasons are written down and
# tested, not in a filter expression.
HUTS_FILTER="nwr/tourism=alpine_hut,wilderness_hut,camp_site nwr/amenity=shelter,drinking_water,water_point nwr/natural=spring nwr/man_made=water_tap"

filtered_pbfs=()
i=0
for url in $HUTS_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all the OSM stages share (lib.sh), not the whole extract.
  # shellcheck disable=SC2086
  src="$(osm_subset "$src" $HUTS_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  # shellcheck disable=SC2086
  osmium tags-filter "$src" $HUTS_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Exported per extract and concatenated, not `osmium merge`d — the continent-seam trap
# build-terrain-features.sh documents. `--geometry-types=point,polygon`: each is a node or
# an area, and normalize-huts reduces the area to one point. `-a type,id` for the seam
# dedup, as in build-landmarks.sh.
: > "$WORK_DIR/huts.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a type,id \
    --geometry-types=point,polygon
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/huts.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

"$NORMALIZE_HUTS_BIN" "$WORK_DIR/huts.geojsonl" "$WORK_DIR/huts-final.geojsonl"

# Every kind present, every one a point. Thresholds and the Scotland counts they come
# from are in tools/cmd/check-output.
"$CHECK_OUTPUT_BIN" huts "$WORK_DIR/huts-final.geojsonl"

OUT="$DIST_DIR/huts-global.pmtiles"

# Tiled in the work directory and moved into dist/ after: see move_into_dist in lib.sh.
#
# -Z13: the app draws these from z13 (src/overlays/huts-water.ts), as it does landmarks and
# car parks — a bothy is worth seeing while planning, which the basemap's z15 floor ruled
# out.
#
# -z15: the basemap's own ceiling.
#
# -r1: no thinning by zoom, as for car parks: tippecanoe's default would take the one
# bothy in a glen off z13 at random. Collision in the app does the thinning instead, huts
# first; a tile that still overflows (a city's drinking fountains) is cut back by
# --drop-densest-as-needed.
# -t: tippecanoe writes its temp files to /tmp whatever TMPDIR says, which in the
# image is the container's own layer, not /work. See build-paths.sh.
tippecanoe -o "$WORK_DIR/huts-global.pmtiles" -t "$WORK_DIR" -Z13 -z15 -r1 \
  --include=kind --include=name \
  -l huts -n "ratmap huts, shelters and water" \
  --drop-densest-as-needed --progress-interval=10 --force \
  "$WORK_DIR/huts-final.geojsonl"

move_into_dist "$WORK_DIR/huts-global.pmtiles" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-huts-1.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
