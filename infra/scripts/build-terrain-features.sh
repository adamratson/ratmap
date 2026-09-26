#!/usr/bin/env bash
# Builds terrain-features-global.pmtiles: OSM `natural=scree|shingle|rock|stone` — ground
# surface detail (scree slopes, boulder fields, rock outcrops) that the basemap has no room
# for. Same reason peaks-global.pmtiles and sac-global.pmtiles exist (C6): Protomaps' OSM
# ingestion drops these four values outright (only reachable via Overture data, which is not
# in our region extracts — checked directly against Protomaps' `Landuse.java`, see
# plans/scree-terrain.md §1). `natural=bare_rock` is the one sibling value Protomaps *does*
# carry; that gap was a styling fix (src/map/landuse.ts), not a pipeline problem, and is
# deliberately excluded here to avoid shipping it twice.
#
# Global build, per-region delivery: build-region.sh cuts each region's
# `<id>-terrain-features.pmtiles` out of this file with `pmtiles extract`, exactly as it
# does for sac and paths.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe
require_cmd go

# Same convention as build-sac.sh: defaults to the union of every region's `osmExtract`.
TERRAIN_FEATURES_SOURCE_URLS="${TERRAIN_FEATURES_SOURCE_URLS:-$(go_run region-osm-sources)}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# The normalizer and the check below are Go (tools/cmd/normalize-terrain-features, a port
# of normalize-terrain-features.py, and tools/cmd/check-output), built from this checkout
# (lib.sh).
echo "==> building normalize-terrain-features"
NORMALIZE_TF_BIN="$(go_tool normalize-terrain-features "$WORK_DIR")"
CHECK_OUTPUT_BIN="$(go_tool check-output "$WORK_DIR")"

"$NORMALIZE_TF_BIN" --self-test

TERRAIN_FEATURES_FILTER="nwr/natural=scree,shingle,rock,stone"

filtered_pbfs=()
i=0
for url in $TERRAIN_FEATURES_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"
  # Filtered from the subset all five OSM stages share (lib.sh), not the whole extract.
  src="$(osm_subset "$src" $TERRAIN_FEATURES_FILTER)"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  osmium tags-filter "$src" $TERRAIN_FEATURES_FILTER -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Export each filtered extract separately and concatenate, same reasoning as build-sac.sh:
# `osmium merge`-ing the PBFs first breaks on ways that cross a continent-extract seam
# (dated snapshots resolved per continent, so a shared way can arrive with two different
# versions — "Way ID twice in input", which osmium reads as a history file and refuses).
# Concatenating the line-delimited exports sidesteps it.
#
# --geometry-types=point,polygon is load-bearing, not an optimisation: by default
# `osmium export` emits a closed way tagged natural=scree as *two* features — a raw
# LineString for the way and a MultiPolygon for the assembled area. Verified against
# scotland-latest.osm.pbf (2026-09-18): 6,059 LineStrings alongside 6,156 MultiPolygons for
# `scree` alone, an almost-exact duplicate pair. Restricting the export to point+polygon
# drops the redundant boundary line at the source, rather than asking normalize-
# terrain-features to deduplicate two differently-shaped features describing one way.
: > "$WORK_DIR/terrain-features.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a id \
    --geometry-types=point,polygon
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/terrain-features.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

"$NORMALIZE_TF_BIN" \
  "$WORK_DIR/terrain-features.geojsonl" "$WORK_DIR/terrain-features-final.geojsonl"

# Regression check, same standard as every other pipeline here — but a different shape
# than build-sac.sh's named-path pins. Checked directly (2026-09-18): none of the 65
# scree/shingle ways in this project's Lochaber reference box carry a `name` tag at all —
# scree polygons are essentially always anonymous, unlike graded paths. So there is no
# "Ben Nevis Mountain Path" equivalent to pin. Instead this follows SAC's own *fallback*
# check, the one its comment says "always fires": all four kinds must be present in
# meaningful numbers, or the filter/normalize step has silently collapsed. Thresholds are
# two orders of magnitude below what a real Scotland+Montenegro extract produced
# (scree 6156, shingle 2099, rock 1499, stone 797, measured 2026-09-18 against
# scotland-latest.osm.pbf alone) — loose enough to survive ordinary OSM edits and a
# narrower test extract, tight enough that a broken filter (which produces zero) still
# fails it.
"$CHECK_OUTPUT_BIN" terrain-features "$WORK_DIR/terrain-features-final.geojsonl"

OUT="$DIST_DIR/terrain-features-global.pmtiles"

# -Z11: matches the basemap's own landuse fade-in (landuse_park reaches full opacity at
# z11 in every Protomaps flavour — see base_layers.ts), and the zoom below which a
# region's own layers are suppressed anyway (regionMinZoom in region-layers.ts).
#
# -z15: the basemap's own ceiling.
tippecanoe -o "$OUT" -Z11 -z15 \
  --include=kind --include=name \
  -l terrain_features -n "ratmap terrain features (scree, shingle, rock, stone)" \
  --drop-densest-as-needed --progress-interval=10 --force \
  "$WORK_DIR/terrain-features-final.geojsonl"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-terrain-features.pmtiles out of this"
echo "  ./scripts/build-manifest.sh --base-live"
echo "  ./scripts/upload.sh"
