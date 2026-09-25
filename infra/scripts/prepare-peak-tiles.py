#!/usr/bin/env python3
"""Make peaks safe to tile: every one that goes in has to come out drawable.

    prepare-peak-tiles.py IN.geojsonl OUT.geojsonl

MapLibre draws a point only from a tile that holds it, 0 <= x, y < extent in that tile's
own coordinates: points in a tile's buffer are skipped, so none is drawn twice
(`addSymbolAtAnchor` in symbol_layout.ts, and circle_bucket.ts, read at maplibre-gl
5.24.0). A point that tippecanoe leaves outside every tile is on no map at all. Two kinds
of peak end up that way, and build-peaks.sh's tile check failed the planet build over
both (2026-09-25):

- **Beyond Web Mercator.** Tiles stop at +-85.0511 degrees, and tippecanoe drops anything
  beyond without a word: 181 Transantarctic summits. Also left out: anything within
  MARGIN of that line. Close enough to it, a peak snaps onto the bottom edge of the
  bottom row, pixel 4096 of 4096, and is drawn by no tile (half a pixel is 0.0005 degrees
  there at z3 and less deeper). No peak in OSM is that close, the nearest are six at
  exactly -85.05, which stay.

- **On a rounding tie at a tile edge.** tippecanoe rounds a point's position to tile pixels
  with std::round, half away from zero. A peak exactly half a pixel short of an edge
  rounds up to 4096 in its own tile and down to -1 in its neighbour's buffer: outside
  both. Хонголдойский Голец (node 4707311223, lon 101.2496567) sits exactly there, half a
  z7 pixel west of 101.25, in 32-bit world units: 33550336 into tile 99, -4096 from tile
  100 (replayed in C with tippecanoe's own arithmetic). About one peak in the planet's 1.2 M
  should hit this at a given zoom. Each one found is moved STEP west or north, into the tile
  it belongs to, which is OSM's own last digit, ~1 cm.

The tie test replays tippecanoe 2.79.0: lonlat2tile(lon, lat, 32) in projection.cpp for
the world position (same double arithmetic, same rounding), and to_tile_scale in
geometry.cpp for the pixel, at detail 12. That holds because `--extend-zooms-if-still-
dropping` sets geometry_scale to 0 (main.cpp): no coarser rounding before the tile
scale. Zooms 0-14 are covered, whichever one ends up the top zoom. The tile check after
tippecanoe is what proves it: if this replay were ever wrong, that check fails and names
the peak.
"""
import json
import math
import sys

MERCATOR_LIMIT = math.degrees(math.atan(math.sinh(math.pi)))  # 85.0511287798...
MARGIN = 0.001
WORLD = 2 ** 32
DETAIL = 12
ZOOMS = range(0, 15)
STEP = 1e-7


def llround(v):
    """C's llround: halves go away from zero."""
    return math.floor(v + 0.5) if v >= 0 else -math.floor(-v + 0.5)


def world_xy(lon, lat):
    """tippecanoe's lonlat2tile(lon, lat, 32), operation for operation."""
    lat_rad = lat * math.pi / 180
    x = llround(WORLD * ((lon + 180) / 360))
    y = llround(WORLD * (1 - (math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi)) / 2)
    return x, y


def tie_zoom(w):
    """The zoom at which world coordinate `w` is exactly half a pixel short of a tile edge."""
    for z in ZOOMS:
        tile = 1 << (32 - z)
        half = 1 << (32 - z - DETAIL - 1)
        if (w + half) % tile == 0:
            return z
    return None


def untie(lon, lat):
    """(lon, lat) moved off any tie, west and north (y grows southward): into its own tile."""
    for _ in range(10):
        x, y = world_xy(lon, lat)
        tx, ty = tie_zoom(x), tie_zoom(y)
        if tx is None and ty is None:
            return lon, lat
        if tx is not None:
            lon = round(lon - STEP, 7)
        if ty is not None:
            lat = round(lat + STEP, 7)
    raise RuntimeError(f"could not move ({lon}, {lat}) off a tile-edge tie")


def main(src, dest):
    limit = MERCATOR_LIMIT - MARGIN
    kept = 0
    beyond = []
    moved = []
    with open(src) as src_f, open(dest, "w") as out:
        for line in src_f:
            if not line.strip():
                continue
            feature = json.loads(line)
            lon, lat = feature["geometry"]["coordinates"][:2]
            name = feature.get("properties", {}).get("name", "(unnamed)")
            if abs(lat) > limit:
                beyond.append(name)
                continue
            new_lon, new_lat = untie(lon, lat)
            if (new_lon, new_lat) != (lon, lat):
                feature["geometry"]["coordinates"] = [new_lon, new_lat]
                line = json.dumps(feature) + "\n"
                moved.append(f"{name} ({lon}, {lat})")
            out.write(line if line.endswith("\n") else line + "\n")
            kept += 1

    print(f"  {kept} peaks to tile; {len(beyond)} beyond Web Mercator (+-{limit:.4f}) left out"
          + (f", e.g. {', '.join(beyond[:5])}" if beyond else ""))
    print(f"  {len(moved)} moved 1e-7 degrees off a tile-edge rounding tie"
          + (f": {'; '.join(moved[:10])}" if moved else ""))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
