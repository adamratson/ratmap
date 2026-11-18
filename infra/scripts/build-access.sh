#!/usr/bin/env bash
# Builds access-global.pmtiles: the ways tagged `access=private` or `access=no` that are
# open to walkers all the same — rights of way across private estates, walkers-only paths
# closed to everything else. The route planner keeps a restricted way from the basemap only
# where one of these lies along it.
#
# It exists because the basemap's `roads` layer carries `access` and nothing else about who
# may use a way — no `foot`, no `designation` — so the router can only drop every private
# way or keep every one. Dropping them lost the College Valley road, a public bridleway
# tagged private to cars, and sent a 5.9 km walk 15.6 km round the border ridge
# (scotland-basemap.pmtiles, 2026-11-18). Keeping them would route people up farm drives:
# only 10-12% of restricted paths and tracks say a walker may use them (Cumbria, Scotland).
# See tools/cmd/normalize-access for exactly what is kept, and src/routes/walkable-access.ts
# for how the router matches it.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-access-1.pmtiles` out of this file with `pmtiles extract`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-sac.sh: defaults to the union of every region's `osmExtract`.
ACCESS_SOURCE_URLS="${ACCESS_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> building normalize-access"
NORMALIZE_ACCESS_BIN="$(go_tool normalize-access "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_ACCESS_BIN" --self-test

# Every restricted way. Whether it is a highway, and whether `foot` or `designation` opens
# it, is decided in normalize-access, where the reasons are written down and tested — a
# tags-filter expression cannot say "access=private AND foot=yes" anyway.
ACCESS_FILTER="w/access=private,no"

filtered_pbfs=()
i=0
for url in $ACCESS_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all the OSM stages share (lib.sh), not the whole extract.
  # shellcheck disable=SC2086
  src="$(osm_subset "$src" $ACCESS_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  # shellcheck disable=SC2086
  osmium tags-filter "$src" $ACCESS_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Exported per extract and concatenated, not `osmium merge`d — the continent-seam trap
# build-sac.sh documents. Lines only: a way the router walks along. `-a type,id` for the
# seam dedup, as in build-huts.sh.
: > "$WORK_DIR/access.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a type,id \
    --geometry-types=linestring
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/access.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

"$NORMALIZE_ACCESS_BIN" "$WORK_DIR/access.geojsonl" "$WORK_DIR/access-final.geojsonl"

# Enough ways, all lines, every one admitted by foot or designation. Threshold and the
# Scotland count it comes from are in tools/cmd/check-output.
"$CHECK_OUTPUT_BIN" access "$WORK_DIR/access-final.geojsonl"

OUT="$DIST_DIR/access-global.pmtiles"

# Tiled in the work directory and moved into dist/ after: see move_into_dist in lib.sh.
#
# -Z15 -z15: the router reads the network at z15 (ROUTING_ZOOM in src/routes/router.ts)
# and this is read beside it, tile for tile. Nothing draws it, so no other zoom is worth a
# byte.
#
# --no-line-simplification and --no-tile-size-limit: the router matches this against the
# basemap's copy of the same ways within a few metres, so the geometry must stay at full
# z15 detail. tippecanoe's simplification, and the coarser encoding it falls back to for an
# oversized tile, would both move the line by about that much. The data is sparse — Scotland
# has 876 such ways — so neither limit is doing any work here anyway.
# -t: tippecanoe writes its temp files to /tmp whatever TMPDIR says, which in the
# image is the container's own layer, not /work. See build-paths.sh.
tippecanoe -o "$WORK_DIR/access-global.pmtiles" -t "$WORK_DIR" -Z15 -z15 \
  --no-line-simplification --no-tile-size-limit \
  --include=foot --include=designation \
  -l access -n "ratmap restricted ways open on foot" \
  --progress-interval=10 --force \
  "$WORK_DIR/access-final.geojsonl"

move_into_dist "$WORK_DIR/access-global.pmtiles" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-access-1.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
