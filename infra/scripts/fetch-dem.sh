#!/usr/bin/env bash
# Fetch a Copernicus GLO-30 DEM clipped to a bbox.
#
#   fetch-dem.sh <west> <south> <east> <north> <out.tif> [target-degrees-per-pixel]
#
# Shared by build-contours.sh (native 30 m) and the prominence step (coarser). Reads the
# published COGs through GDAL's /vsicurl, so only the bytes covering the bbox move — and
# when a coarser resolution is requested GDAL serves it from the COGs' own overviews
# rather than pulling full resolution and throwing it away. Scotland at 30 m would be a
# 2.7 GB raster; at 90 m it is 0.29 GB.
#
# Only cells containing land are published, so an all-ocean cell 404s. Availability is
# checked up front and reported: a missing *land* tile would leave a silent hole, and that
# must be obvious rather than buried in a GDAL warning.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd gdalbuildvrt
require_cmd gdal_translate

WEST="${1:?usage: fetch-dem.sh W S E N out.tif [res]}"
SOUTH="${2:?}"; EAST="${3:?}"; NORTH="${4:?}"; OUT="${5:?}"
RES="${6:-}"

export CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# URLs only, one per line. An earlier version emitted "label<TAB>url" pairs and split them
# in the worker — xargs collapsed the tab and every tile came back "missing", including
# ones that plainly exist. The label is recoverable from the URL, so there is no reason to
# carry a second field through a word-splitting boundary.
python3 - "$WEST" "$SOUTH" "$EAST" "$NORTH" > "$WORK/candidates.txt" <<'PY'
import math, sys
west, south, east, north = (float(v) for v in sys.argv[1:5])
base = "https://copernicus-dem-30m.s3.amazonaws.com"
for lat in range(math.floor(south), math.ceil(north)):
    for lon in range(math.floor(west), math.ceil(east)):
        ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
        ew = f"{'W' if lon < 0 else 'E'}{abs(lon):03d}"
        name = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
        print(f"{base}/{name}/{name}.tif")
PY

total="$(wc -l < "$WORK/candidates.txt" | tr -d ' ')"
echo "  checking $total candidate DEM tiles" >&2

# Checked in parallel: a large region spans dozens of cells and serial HEAD requests
# dominate the runtime (63 tiles for Scotland).
check_one() {
  local url="$1"
  # Copernicus_DSM_COG_10_N56_00_W005_00_DEM -> N56_W005
  local label
  label="$(basename "$url" | sed -E 's/^Copernicus_DSM_COG_10_([NS][0-9]+)_00_([EW][0-9]+)_00_DEM\.tif$/\1_\2/')"
  if curl -sfI --max-time 20 "$url" >/dev/null 2>&1; then
    printf 'OK %s\n' "$url"
  else
    printf 'MISSING %s\n' "$label"
  fi
}
export -f check_one

xargs -P 16 -I{} bash -c 'check_one "$@"' _ {} < "$WORK/candidates.txt" > "$WORK/checked.txt"

awk '/^OK /{print "/vsicurl/" $2}' "$WORK/checked.txt" > "$WORK/tiles.txt"
missing="$(awk '/^MISSING /{print $2}' "$WORK/checked.txt" | sort | tr '\n' ' ')"
usable="$(wc -l < "$WORK/tiles.txt" | tr -d ' ')"

echo "  usable tiles: $usable of $total" >&2
[ -n "$missing" ] && echo "  not published (expected for all-ocean cells): $missing" >&2
if [ "$usable" -eq 0 ]; then
  echo "No DEM tiles available for this bbox — nothing to do." >&2
  exit 1
fi

gdalbuildvrt -input_file_list "$WORK/tiles.txt" "$WORK/dem.vrt" >/dev/null

# `-r max` when downsampling: averaging would erode summits, which are exactly what both
# consumers care about.
if [ -n "$RES" ]; then
  gdal_translate -q -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
    -tr "$RES" "$RES" -r max -of GTiff "$WORK/dem.vrt" "$OUT"
else
  gdal_translate -q -projwin "$WEST" "$NORTH" "$EAST" "$SOUTH" \
    -of GTiff "$WORK/dem.vrt" "$OUT"
fi
