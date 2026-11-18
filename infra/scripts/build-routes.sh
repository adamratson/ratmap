#!/usr/bin/env bash
# Builds routes-global.pmtiles: named walking routes — the West Highland Way, the GR and
# Wanderland routes, the E-paths, a village's waymarked loop — as the ways they run along,
# each tagged with its route's network level and name.
#
# Neither source the map already has carries them. The Protomaps basemap's `network` is a
# road shield's (`other/A82` over Glencoe, decoded from scotland-basemap.pmtiles,
# 2026-11-18), and our paths artifact holds only z12-13 with no route data. And `osmium
# export` cannot make them: it writes a relation only when it is an area. So the routes'
# member ways are exported, the relations are written out as OPL, and normalize-routes
# joins the two — see that tool for which relations count and how each way is labelled.
#
# Measured (2026-11-18): Scotland 886 walking route relations, Switzerland 26,506 (24,494
# of them local — its whole signposted network). Cut per region, Switzerland's routes come
# to 18 MB against a 1,951 MB download, Scotland's to 4.5 MB.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-routes-1.pmtiles` out of this file with `pmtiles extract`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-huts.sh: defaults to the union of every region's `osmExtract`.
ROUTES_SOURCE_URLS="${ROUTES_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> building normalize-routes"
NORMALIZE_ROUTES_BIN="$(go_tool normalize-routes "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_ROUTES_BIN" --self-test

# Every walking route relation, superroutes and `type=network` collections included:
# normalize-routes needs the parents to name the stages, and decides which to use.
# tags-filter keeps each matched relation's member ways and their nodes too — the
# geometry. A parent's member relations are themselves walking routes, so match on their
# own account.
ROUTES_FILTER="r/route=hiking,foot"

: > "$WORK_DIR/routes.opl"
: > "$WORK_DIR/ways.geojsonl"
i=0
for url in $ROUTES_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all the OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $ROUTES_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" $ROUTES_FILTER -o "$filtered" --overwrite

  # Written per extract and concatenated, not `osmium merge`d — the continent-seam trap
  # build-terrain-features.sh documents; normalize-routes drops the seam duplicates by id.
  # `add_metadata=false`: id, tags and members are all it reads.
  osmium cat "$filtered" -t relation -f opl,add_metadata=false -o "$WORK_DIR/part.opl" --overwrite
  cat "$WORK_DIR/part.opl" >> "$WORK_DIR/routes.opl"
  # `-a type,id` to join on. Lines only: a member way that is an area (a pedestrian
  # square) has no line to draw a route along.
  osmium export "$filtered" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a type,id \
    --geometry-types=linestring
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/ways.geojsonl"
  rm -f "$WORK_DIR/part.opl" "$WORK_DIR/part.geojsonl" "$filtered"
done

"$NORMALIZE_ROUTES_BIN" "$WORK_DIR/routes.opl" "$WORK_DIR/ways.geojsonl" "$WORK_DIR/routes-final.geojsonl"

# Lines on the four networks, each level present, the major ones mostly named. Thresholds
# and the Scotland counts they come from are in tools/cmd/check-output.
"$CHECK_OUTPUT_BIN" routes "$WORK_DIR/routes-final.geojsonl"

OUT="$DIST_DIR/routes-global.pmtiles"

# -Z8: international, national and regional routes are worth seeing while choosing a
# trail, before any path is drawn (z12). Local routes carry their own minzoom, z12, from
# normalize-routes.
#
# -z15: the basemap's own ceiling.
#
# --reorder --coalesce: a way is a few hundred metres, and a label along a line needs the
# line to be long enough to hold it. Joining consecutive ways of the same route and name
# gives the labels room, and the archive fewer, longer features.
#
# --simplification=10: ten times tippecanoe's default tolerance, a little over a pixel.
# At the default, the West Highland Way's z11 tile kept 318 points and 40 turns sharper
# than 45° — sub-pixel zigzags that a line label cannot run along, so the trail went
# unnamed until z13. At 10 it is 60 points and named from z11, and the archives shrink by
# a third (Scotland 5.9 to 4.5 MB, Switzerland 28 to 18 MB). Nothing is lost that the
# tint or a label could show.
#
# --drop-densest-as-needed only as the backstop for a tile that would still overflow: a
# Switzerland build of every level came out the same size with and without it
# (2026-11-18), so on the densest network measured it drops nothing.
#
# -t: tippecanoe writes its temp files to /tmp whatever TMPDIR says, which in the
# image is the container's own layer, not /work. See build-paths.sh.
tippecanoe -o "$WORK_DIR/routes-global.pmtiles" -t "$WORK_DIR" -Z8 -z15 \
  --include=network --include=name \
  -l routes -n "ratmap walking routes" \
  --reorder --coalesce --simplification=10 \
  --drop-densest-as-needed --progress-interval=10 --force \
  "$WORK_DIR/routes-final.geojsonl"

move_into_dist "$WORK_DIR/routes-global.pmtiles" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-routes-1.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
