#!/usr/bin/env bash
# Builds sac-global.pmtiles: every OSM way tagged `sac_scale`, carrying the normalized
# grade (t=1..6) and its name. This is the artifact the map colours footpaths from and the
# route planner reports a route's hardest section out of.
#
# It exists because the basemap does not carry the tag: decoding a z15 tile of
# scotland-basemap.pmtiles over the Ben Nevis Mountain Path (2026-09-06) gives exactly
# `kind, kind_detail, min_zoom, name, sort_rank`. Protomaps has no room for a hiking tag in
# a general-purpose road schema, so this is ours — same shape as peaks-global.pmtiles,
# which exists for the same reason (C6).
#
# Global build, per-region delivery: build-region.sh cuts each region's `<id>-sac.pmtiles`
# out of this file with `pmtiles extract`, exactly as it does for the basemap and terrain.
# A grade that only shows up online would be worse than none — the phone that needs it is
# the one with no signal.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd osmium
require_cmd tippecanoe

# Space-separated .osm.pbf URLs, same convention (and same cache) as build-peaks.sh.
# Defaults to the union of every region's `osmExtract`, so a newly published region gets
# grades without anyone remembering to widen this.
SAC_SOURCE_URLS="${SAC_SOURCE_URLS:-$(python3 "$(dirname "${BASH_SOURCE[0]}")/region-osm-sources.py")}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SCRIPT_DIR_SAC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The parser earns a test of its own: `sac_scale` is a documented enum that in practice
# carries 184 distinct values, and the difference between reading "T2-T3" as 3 and
# discarding it is a graded path silently vanishing from the map.
python3 "$SCRIPT_DIR_SAC/normalize-sac.py" --self-test

filtered_pbfs=()
i=0
for url in $SAC_SOURCE_URLS; do
  i=$((i + 1))
  echo "Source: $url"
  src="$(cached_osm_extract "$url")"

  filtered="$WORK_DIR/filtered-$i.osm.pbf"
  # Ways only. `sac_scale` on a node or a relation is a tagging error — the scale
  # describes a stretch of path — and either would export as geometry the app cannot draw
  # as a band or match a route against.
  osmium tags-filter "$src" w/sac_scale -o "$filtered" --overwrite
  filtered_pbfs+=("$filtered")
done

# Export each filtered extract separately and concatenate the line-delimited GeoJSON,
# rather than `osmium merge`-ing the PBFs into one first.
#
# The merge is what killed the first planet run of the sibling paths build (2026-09-08):
# it exits with "Way ID twice in input. Maybe you are using a history or change file?".
# The continents are pinned to *dated* Geofabrik snapshots and those dates are resolved
# per continent — europe-260823 alongside north-america-260824 in that run — because they
# do not all rebuild at the same hour. A way crossing a continent seam therefore appears
# in two files with two different versions, which is a history file, and `osmium merge`
# says so (its own `-H` flag exists to silence exactly that warning). Nothing downstream
# can read it. This build survived the same structure by luck: with ~921 k graded ways
# worldwide, none happened to sit on a seam.
#
# Concatenating the exports sidesteps it, and drops a full extra copy of the merged PBF
# from the working set. `-a id` carries the OSM way id through so normalize-sac.py can
# drop a way it has already seen — a set of ids at this scale is affordable. The paths
# build cannot afford that and does not do it; see build-paths.sh.
#
# Line-delimited so every stage below streams, as in build-peaks.sh. `-x
# print_record_separator=false` drops the RFC8142 RS byte, leaving plain JSON per line.
: > "$WORK_DIR/sac.geojsonl"
for pbf in "${filtered_pbfs[@]}"; do
  osmium export "$pbf" -o "$WORK_DIR/part.geojsonl" \
    -f geojsonseq -x print_record_separator=false --overwrite -a id
  cat "$WORK_DIR/part.geojsonl" >> "$WORK_DIR/sac.geojsonl"
  rm -f "$WORK_DIR/part.geojsonl"
done

# Free text in, integer 1-6 out — see normalize-sac.py. Anything it cannot read is dropped
# and counted, never guessed at.
python3 "$SCRIPT_DIR_SAC/normalize-sac.py" "$WORK_DIR/sac.geojsonl" "$WORK_DIR/sac-final.geojsonl"

# Grade regression check, in the same spirit as build-peaks.sh's elevation assertions: a
# parser or schema change that silently mis-reads `sac_scale` should fail here, not be
# discovered by someone who followed a blue line onto the Aonach Eagach.
#
# Each expected value was read out of a real build's output (Scotland + Montenegro,
# 2026-09-06) rather than from a guidebook — what the pipeline must preserve is what OSM
# says. A named path is usually several ways of differing grade, so the assertion is on
# the *hardest* way carrying that name, which is also the number the app reports.
python3 - "$WORK_DIR/sac-final.geojsonl" <<'PYCHECK'
import json, sys

EXPECTED_HARDEST = {
    "Ben Nevis Mountain Path": 2,   # Scotland — mountain_hiking, in places T1
    "West Highland Way": 1,         # Scotland — the flat end of the scale
    "Aonach Eagach": 5,             # Scotland — demanding_alpine_hiking
}

hardest = {}
histogram = {}
with open(sys.argv[1]) as f:
    for line in f:
        props = json.loads(line)["properties"]
        grade = props["t"]
        histogram[grade] = histogram.get(grade, 0) + 1
        name = props.get("name")
        if isinstance(name, str) and name in EXPECTED_HARDEST:
            hardest[name] = max(hardest.get(name, 0), grade)

checked = 0
for name, expected in EXPECTED_HARDEST.items():
    actual = hardest.get(name)
    if actual is None:
        print(f"  (skip {name}: not in this extract)")
        continue
    if actual != expected:
        sys.exit(f"FAIL: {name} hardest grade {actual}, expected {expected}")
    print(f"  OK {name}: T{expected}")
    checked += 1

# The named checks only fire for extracts containing those paths. This one always fires:
# a build whose output is a single grade means the parser has collapsed the scale, which
# is exactly the failure that would otherwise ship as a uniformly-coloured map.
present = sorted(histogram)
print(f"  grades present: {', '.join(f'T{g} x{histogram[g]}' for g in present)}")
if len(present) < 2:
    sys.exit("FAIL: fewer than two distinct grades in the whole build")
if checked == 0:
    print("  (no known paths in this extract — grade assertions skipped)")
PYCHECK

OUT="$DIST_DIR/sac-global.pmtiles"

# -Z12: the app never draws this below z12 (a region's own layers are suppressed at low
# zoom, and a grade band with no visible path under it annotates nothing), so lower zooms
# would be bytes on a phone for pixels nobody sees.
#
# -z15: the basemap's own ceiling, and the zoom the route sampler reads at. Paths carry
# min_zoom 14 in the Protomaps schema, so below z15 the network the grades are matched
# against is already generalised.
tippecanoe -o "$OUT" -Z12 -z15 \
  --include=t --include=name \
  -l sac -n "ratmap SAC grades" \
  --drop-densest-as-needed --force \
  "$WORK_DIR/sac-final.geojsonl"

pmtiles show "$OUT"
echo "Built $OUT"
echo
echo "Next:"
echo "  ./scripts/build-region.sh <region-id>   # cuts <id>-sac.pmtiles out of this"
echo "  python3 ./scripts/build-manifest.py --base-live"
echo "  ./scripts/upload.sh"
