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

# Per-continent tilesets, cached between runs. This is the unit of work, and it is what
# makes a stage that runs for hours survivable: the first planet attempt spent 29 minutes
# filtering and then died in a single global tippecanoe, with nothing to show for it.
#
# Keyed on the *pinned* source basename (europe-260823, not europe-latest), so when the
# pin moves the key moves with it and the tileset is rebuilt — the same invalidation rule
# cached_osm_extract uses for the extracts themselves. Sits next to that cache, which on
# the container is the /work volume rather than the container's own disk.
PATHS_TILE_CACHE="${PATHS_TILE_CACHE:-$(dirname "$OSM_CACHE_DIR")/paths-tiles}"
mkdir -p "$PATHS_TILE_CACHE"

# How many continents to tile at once. One by default: tippecanoe already uses every core
# for its own tiling. What parallelism actually buys here is the *serial* stretches — the
# osmium export and the single-threaded reduce below — during which one continent leaves
# the rest of the box idle.
#
# A worker costs 2-3 GB, measured 2026-09-08: `osmium tags-filter` peaks at ~1.9 GB and
# stays there whatever the extract (1.89 GB on 33 MB of Montenegro, 1.96 GB on 310 MB of
# Scotland — it is an id bitmap over OSM's global id space, not a function of the input),
# the reduce step is 17 MB, and tippecanoe went 172 MB to 227 MB for a 4x larger input
# because its sort is disk-backed. So the default of 3 is ~9 GB and the limit becomes cpu;
# more than 3 buys little, since only europe, asia and north-america are big enough to be
# worth overlapping.
PATHS_PARALLEL="${PATHS_PARALLEL:-3}"

# ...but not on a box that cannot hold them. The preflight admits hosts down to 4 GB, and
# a fixed default of 3 would turn this stage from slow into killed there. Budget 3 GB a
# worker, floor of 1. An explicit PATHS_PARALLEL is still capped by this: it is a
# statement about what the host has, and the host is what it is.
PATHS_MEMORY_GB="$(available_memory_gb)"
if [ "$PATHS_MEMORY_GB" -gt 0 ]; then
  PATHS_AFFORDABLE=$(( PATHS_MEMORY_GB / 3 ))
  [ "$PATHS_AFFORDABLE" -lt 1 ] && PATHS_AFFORDABLE=1
  if [ "$PATHS_PARALLEL" -gt "$PATHS_AFFORDABLE" ]; then
    echo "Limiting to $PATHS_AFFORDABLE worker(s): ${PATHS_MEMORY_GB} GB available," \
         "and a continent costs about 3 GB to tile."
    PATHS_PARALLEL="$PATHS_AFFORDABLE"
  fi
fi
echo "Tiling ${PATHS_PARALLEL} continent(s) at a time"

# The walker's network, matching what the router already treats as travelable on foot
# (ROUTABLE_KINDS in src/routes/path-tiles.ts) minus the roads, which the basemap draws at
# every zoom anyway.
PATHS_FILTER="w/highway=path,footway,bridleway,steps,track"

# --simplification=8 is half a screen pixel at both zooms this archive holds — at z13 a
# tile unit is 0.67 m and a CSS pixel about 11 m of ground, at z12 it is 1.33 m against
# 22 m — so it is invisible and it is not free: measured on Scotland (2026-09-08), 18 MB
# at the default 1, 13 MB at 8, for 372,205 ways.
#
# --drop-densest-as-needed thins a tile that would exceed the size limit, which in
# practice means some urban footways at z12. That is the right place to lose detail on a
# map for hills, and the same mechanism the basemap itself uses.
#
# One progress line per tile writes a 177 MB log on a planet run (measured 2026-09-08) —
# into /work/logs *and* through docker's json-file driver, for a stage whose progress a
# human reads about twice. `--progress-interval` costs no time (12.71 s with full progress
# against 12.74 s with none, on the same input), so this is about the log, not the clock.
tile_one_source() {
  local url="$1" src key out building work
  src="$(cached_osm_extract "$url")"
  key="$(basename "${src%.osm.pbf}")"
  out="$PATHS_TILE_CACHE/$key-paths.pmtiles"
  # Still ends in .pmtiles, deliberately: tippecanoe and tile-join both choose their
  # output *format* from the extension, so the obvious "$out.building" quietly writes an
  # MBTiles file that then fails `pmtiles verify` for a reason that has nothing to do with
  # the data. The leading dot keeps it out of the way instead.
  building="$PATHS_TILE_CACHE/.$key-paths.building.pmtiles"

  if [ -s "$out" ]; then
    echo "  $key: cached tileset ($(du -h "$out" | cut -f1))"
    return 0
  fi

  # Per-source scratch, removed as soon as its tileset exists. The old shape built one
  # concatenated GeoJSON of the entire planet — tens of GB live at once; this never holds
  # more than one continent's worth.
  work="$(mktemp -d)"

  osmium tags-filter "$src" $PATHS_FILTER -o "$work/filtered.osm.pbf" --overwrite
  osmium export "$work/filtered.osm.pbf" -o "$work/raw.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite
  rm -f "$work/filtered.osm.pbf"

  reduce_to_path_properties "$work/raw.geojsonl" "$work/final.geojsonl" "$key"
  rm -f "$work/raw.geojsonl"

  tippecanoe -o "$building" -Z12 -z13 \
    --include=kind --include=kind_detail \
    -l paths -n "ratmap low-zoom paths" \
    --simplification=8 --drop-densest-as-needed --progress-interval=10 --force \
    "$work/final.geojsonl"

  rm -rf "$work"

  # Same rule as build-region.sh: nothing appears under its real name until it has been
  # verified, or an interrupted run leaves a plausibly-sized file with a zeroed header
  # that the next run happily adopts as "cached".
  if ! pmtiles verify "$building" >/dev/null 2>&1; then
    echo "  $key: FAILED verification — not a valid PMTiles archive" >&2
    rm -f "$building"
    return 1
  fi
  mv "$building" "$out"
  echo "  $key: built $(du -h "$out" | cut -f1)"
}

# Reduce to the two properties the style actually reads, under **Protomaps' own names**.
# `kind_detail` rather than something of our own so one set of paint expressions can drive
# both this source and the basemap's `roads` layer (see addPathLayers in
# src/regions/region-layers.ts) — the handoff at z14 has to be invisible, and the surest
# way to make two layers look identical is to give them the same expressions.
reduce_to_path_properties() {
  python3 - "$1" "$2" "$3" <<'PY_REDUCE'
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

print(f"  {sys.argv[3]}: {kept} walkable ways, skipped {skipped} non-line features")
PY_REDUCE
}

LOG_DIR_PATHS="${RATMAP_WORK:-$INFRA_DIR}/logs"
mkdir -p "$LOG_DIR_PATHS"

tilesets=()
running=0
for url in $PATHS_SOURCE_URLS; do
  key="$(basename "${url%.osm.pbf}")"
  tilesets+=("$PATHS_TILE_CACHE/$key-paths.pmtiles")

  if [ "$PATHS_PARALLEL" -le 1 ]; then
    echo "Source: $url"
    tile_one_source "$url" || true
  else
    # Each worker's output to its own log: several at once would interleave line by line
    # into one unreadable stream. Same idiom as the contours stage in build-global.sh.
    echo "Source: $url (log: $LOG_DIR_PATHS/paths-$key.log)"
    tile_one_source "$url" > "$LOG_DIR_PATHS/paths-$key.log" 2>&1 &
    running=$((running + 1))
    if [ "$running" -ge "$PATHS_PARALLEL" ]; then
      wait
      running=0
    fi
  fi
done
wait

# Checked on the artifacts rather than on worker exit codes: with several running in the
# background a lost exit status is easy and a missing continent is not — and this same
# check is what makes a resumed run correct, since a tileset that is present was verified
# before it got its name.
missing=()
for tileset in "${tilesets[@]}"; do
  if [ -s "$tileset" ]; then
    # A one-line result per continent reaches the stage log even when the detail went to
    # a worker log — the same split the contours stage uses. Without it, the parallel
    # default would make a multi-hour stage look like it was doing nothing at all.
    echo "  $(basename "$tileset" .pmtiles): $(du -h "$tileset" | cut -f1)"
  else
    missing+=("$(basename "$tileset")")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo >&2
  echo "FAILED: ${#missing[@]} continent tileset(s) missing: ${missing[*]}" >&2
  echo "  Their logs are in $LOG_DIR_PATHS. Re-running skips the ones already built." >&2
  exit 1
fi

OUT="$DIST_DIR/paths-global.pmtiles"
# Ends in .pmtiles for the same reason as the per-continent temp name above.
OUT_BUILDING="$DIST_DIR/.paths-global.building.pmtiles"

# Join the continents into the artifact the regions are cut from.
#
# tile-join merges the features of tiles that appear in more than one input, which at this
# scale is only the tiles a continent boundary runs through — everywhere else each tile
# comes from exactly one continent and is copied through untouched. -pk because the size
# limit was already applied per continent by --drop-densest-as-needed: re-applying it to a
# joined seam tile would drop features for the second time, and a seam is a bad place to
# thin a map on purpose.
echo
echo "Joining ${#tilesets[@]} continent tilesets"
tile-join -o "$OUT_BUILDING" -pk --force \
  -n "ratmap low-zoom paths" \
  -N "The walkable network at z12-13, where the basemap carries none" \
  "${tilesets[@]}"

if ! pmtiles verify "$OUT_BUILDING" >/dev/null 2>&1; then
  echo "FAILED verification: the joined archive is not valid PMTiles" >&2
  rm -f "$OUT_BUILDING"
  exit 1
fi
mv "$OUT_BUILDING" "$OUT"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-paths.pmtiles out of this"
echo "  python3 ./scripts/build-manifest.py --base-live"
echo "  ./scripts/upload.sh"
