#!/usr/bin/env bash
# Builds landmarks-global.pmtiles: OSM `man_made=mast|tower|survey_point|cairn|lighthouse`
# and wind turbines — the reference points a walker takes a bearing on, the masts on Great
# Dun Fell or a trig pillar on a moorland top. Same reason terrain-features-global.pmtiles
# exists: Protomaps' POI layer keeps no `man_made` or `power` tag, so none of these reach
# the basemap. Checked by
# decoding the Protomaps v4 z15 tiles over Great Dun Fell (2026-10-22): its four
# `man_made=mast` nodes are in OSM and nowhere in the tiles.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-landmarks-1.pmtiles` out of this file with `pmtiles extract`, exactly as it does
# for sac and terrain-features.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-sac.sh: defaults to the union of every region's `osmExtract`.
LANDMARKS_SOURCE_URLS="${LANDMARKS_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# The normalizer and the check below are Go (tools/cmd/normalize-landmarks and
# tools/cmd/check-output), built from this checkout (lib.sh).
echo "==> building normalize-landmarks"
NORMALIZE_LM_BIN="$(go_tool normalize-landmarks "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_LM_BIN" --self-test

# The whole of each family. What is not a landmark — floodlight masts, benchmark bolts,
# survey points that are the summit node itself — is dropped in normalize-landmarks, where
# the reasons are written down and tested, not in a filter expression.
LANDMARKS_FILTER="nwr/man_made=mast,tower,survey_point,cairn,lighthouse nwr/generator:source=wind"

filtered_pbfs=()
i=0
for url in $LANDMARKS_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all the OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $LANDMARKS_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" $LANDMARKS_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Exported per extract and concatenated, not `osmium merge`d — the continent-seam trap
# build-terrain-features.sh documents. `--geometry-types=point,polygon` for the same reason
# as there too: without it a tower drawn as a closed way comes out twice, as its outline
# and as its area. normalize-landmarks reduces the area to one point.
#
# `-a type,id` rather than terrain-features' `-a id`: a tower is a node in one place and a
# building outline in the next, so the seam dedup keys on both.
: > "$WORK_DIR/landmarks.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a type,id \
    --geometry-types=point,polygon
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/landmarks.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

"$NORMALIZE_LM_BIN" "$WORK_DIR/landmarks.geojsonl" "$WORK_DIR/landmarks-final.geojsonl"

# Regression check, terrain-features' shape: every kind present in meaningful numbers,
# and every feature a point. Thresholds are about two orders of magnitude below what
# Scotland alone produced (mast 1,958, tower 1,180, survey_point 351, cairn 643, lighthouse
# 228, wind_turbine 7,293 after normalizing, measured against scotland-latest.osm.pbf,
# 2026-10-27) — loose enough for a narrow test extract, tight enough that a broken filter,
# which produces zero, still fails.
"$CHECK_OUTPUT_BIN" landmarks "$WORK_DIR/landmarks-final.geojsonl"

OUT="$DIST_DIR/landmarks-global.pmtiles"

# Tiled in the work directory and moved into dist/ after: see move_into_dist in lib.sh.
#
# -Z13: the app draws these from z13 (src/overlays/landmarks.ts), where a mast is a
# landmark rather than one of a hundred dots across a county.
#
# -z15: the basemap's own ceiling.
#
# -r1: no thinning by zoom. tippecanoe's default drops 60% of points per zoom below the
# top, which would take a lone mast off a z13 hillside at random. Collision in the app does
# the thinning instead, and keeps named and nearby features over the rest; a tile that
# still overflows (a city's rooftop masts) is cut back by --drop-densest-as-needed.
tippecanoe -o "$WORK_DIR/landmarks-global.pmtiles" -Z13 -z15 -r1 \
  --include=kind --include=name \
  -l landmarks -n "ratmap landmarks (masts, towers, trig pillars, cairns, lighthouses, wind turbines)" \
  --drop-densest-as-needed --progress-interval=10 --force \
  "$WORK_DIR/landmarks-final.geojsonl"

move_into_dist "$WORK_DIR/landmarks-global.pmtiles" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-landmarks-1.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
