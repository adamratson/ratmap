#!/usr/bin/env bash
# Builds paths-global.pmtiles: the walkable network at z12-13 only, where the region
# basemap does not have one.
#
# Why it exists. Protomaps tags paths `min_zoom: 14` and thins them out below that.
# Decoded from a real region archive over Ben Nevis (2026-09-08): the z14 tile holds 2
# path features, the z13 tile 1, the z12 tile none. So at the zoom where a walker is
# still deciding which corrie to head for — and where the SAC grade bands were already
# drawing, since those are our own tiles — the map showed no paths at all. No style
# change can draw geometry that is not in the tile.
#
# Deliberately only z12-13. The basemap carries the network from z14 up, with names,
# bridges, tunnels and access tags this does not have; duplicating that would be an order
# of magnitude more bytes to say the same thing. The app draws this below z14 and the
# basemap at z14 and above, with identical paint on both sides of the handoff.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe

# Space-separated .osm.pbf URLs, same convention (and same cache) as build-peaks.sh and
# build-sac.sh. Defaults to the union of every region's `osmExtract`.
PATHS_SOURCE_URLS="${PATHS_SOURCE_URLS:-$(python3 "$(dirname "${BASH_SOURCE[0]}")/region-osm-sources.py")}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

filtered_pbfs=()
i=0
for url in $PATHS_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  # The walker's network, matching what the router already treats as travelable on foot
  # (ROUTABLE_KINDS in src/routes/path-tiles.ts) minus the roads, which the basemap draws
  # at every zoom anyway.
  osmium tags-filter "$src" w/highway=path,footway,bridleway,steps,track \
    -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

if [ "${#filtered_pbfs[@]}" -gt 1 ]; then
  echo "Merging ${#filtered_pbfs[@]} filtered extracts"
  osmium merge "${filtered_pbfs[@]}" -o "$WORK_DIR/paths-raw.osm.pbf" --overwrite
else
  cp "${filtered_pbfs[0]}" "$WORK_DIR/paths-raw.osm.pbf"
fi

osmium export "$WORK_DIR/paths-raw.osm.pbf" -o "$WORK_DIR/paths.geojsonl" \
  -f geojsonseq -x print_record_separator=false --overwrite

# Reduce to the two properties the style actually reads, under **Protomaps' own names**.
# `kind_detail` rather than something of our own so one set of paint expressions can drive
# both this source and the basemap's `roads` layer (see addPathLayers in
# src/regions/region-layers.ts) — the handoff at z14 has to be invisible, and the surest
# way to make two layers look identical is to give them the same expressions.
python3 - "$WORK_DIR/paths.geojsonl" "$WORK_DIR/paths-final.geojsonl" <<'PY_REDUCE'
import json, sys

kept = 0
skipped = 0
with open(sys.argv[1]) as src, open(sys.argv[2], "w") as dest:
    for line in src:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        feature = json.loads(line)
        # Ways only. `osmium tags-filter w/...` carries the ways' own tagged nodes along
        # with them — gates, stiles, crossings — and a point is not a path.
        if feature.get("geometry", {}).get("type") not in ("LineString", "MultiLineString"):
            skipped += 1
            continue
        highway = feature.get("properties", {}).get("highway")
        if not isinstance(highway, str):
            skipped += 1
            continue
        feature["properties"] = {
            "kind": "path",
            # Vehicle-width or not: the one distinction the styling makes, and the only
            # one worth two zoom levels of bytes.
            "kind_detail": "track" if highway == "track" else "path",
        }
        dest.write(json.dumps(feature) + "\n")
        kept += 1

print(f"  {kept} walkable ways, skipped {skipped} non-line features")
PY_REDUCE

OUT="$DIST_DIR/paths-global.pmtiles"

# --simplification=8 is half a screen pixel at both zooms this archive holds — at z13 a
# tile unit is 0.67 m and a CSS pixel about 11 m of ground, at z12 it is 1.33 m against
# 22 m — so it is invisible and it is not free: measured on Scotland (2026-09-08),
# 18 MB at the default 1, 13 MB at 8, for 372,205 ways.
#
# --drop-densest-as-needed thins a tile that would exceed the size limit, which in
# practice means some urban footways at z12. That is the right place to lose detail on a
# map for hills, and the same mechanism the basemap itself uses.
tippecanoe -o "$OUT" -Z12 -z13 \
  --include=kind --include=kind_detail \
  -l paths -n "ratmap low-zoom paths" \
  --simplification=8 --drop-densest-as-needed --force \
  "$WORK_DIR/paths-final.geojsonl"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-paths.pmtiles out of this"
echo "  python3 ./scripts/build-manifest.py --base-live"
echo "  ./scripts/upload.sh"
