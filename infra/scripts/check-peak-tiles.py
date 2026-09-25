#!/usr/bin/env python3
"""Check that a peaks archive's top zoom holds every peak it was built from.

    tippecanoe-decode -zZ -ZZ ARCHIVE | check-peak-tiles.py SOURCE ARCHIVE Z

SOURCE is the line-delimited GeoJSON tippecanoe was given, ARCHIVE the .pmtiles it made
and Z its top zoom, the zoom the app overzooms from, so every peak and every Munro has to
be there. build-peaks.sh runs this; the published archive once went two weeks with no
`lists` property at all, every Munro marker and badge silently absent (found 2026-09-24),
because nothing checked what tippecanoe made of its input.

Streamed, a line at a time: decoded in one piece the global archive is hundreds of MB of
JSON. tippecanoe-decode writes each tile's header on a line of its own ("zoom", "x", "y")
and each feature on a line of its own.

Counted, not matched by position: tippecanoe snaps coordinates to its tile grid, so
positions do not match the input's, and a peak near an edge is also copied into the
neighbouring tile's buffer. So a feature counts only in the tile whose bounds hold it.
A peak snapped exactly onto an edge is on the boundary of two tiles and counts in one of
them, the one to the east or south, whose buffer copy is identical. Except at the top and
bottom of the world, where there is no tile beyond: there the edge counts as inside, with
half a unit of slack, because tippecanoe-decode prints six decimals and the edge
(-85.0511287798) prints as -85.051129, past itself. Without that, a peak at -85.05112
is in the tiles and counts nowhere (found 2026-09-25). The antimeridian needs nothing: a
peak snapped to 180° has a wrapped copy at -180° in column 0, which counts.

On failure it names the missing peaks. It decodes the archive a second time and matches
every input peak to a counted one of the same name within a few pixels, greedily. What
is left unmatched is what went missing. A named peak comes out exactly. An unnamed one can
only be matched by position, so in a dense cluster the one listed may be a neighbour of
the one lost (6 of 25 in a test with 3,000 unnamed saddles in a few km², all within
150 m). It checks every peak, not only the tiles that came
up short, since a loss in a tile that also gained a neighbour's edge-snapped peak nets to
zero there. Only on failure: the first pass stays one stream with nothing held.
"""
import json
import math
import re
import subprocess
import sys
from collections import defaultdict

TILE = re.compile(r'"zoom": (\d+), "x": (\d+), "y": (\d+)')
# Half the last printed digit of tippecanoe-decode's coordinates. Nothing lies beyond the
# top or bottom edge of the world, so there is nothing for this much slack to let in twice.
EDGE_SLACK = 0.5e-6
EXTENT = re.compile(r'"extent": (\d+)')
MAX_LISTED = 50


def read_source(path):
    with open(path) as f:
        for line in f:
            line = line.lstrip("\x1e").strip()
            if line:
                yield json.loads(line)


def is_munro(props):
    return "munro" in str(props.get("lists", "")).split(";")


def bounds(z, x, y):
    n = 2 ** z
    lat = lambda row: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * row / n))))
    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def counted_features(stream, z):
    """(properties, lon, lat, extent) for every feature that counts in its own tile."""
    n = 2 ** z
    tile = None
    top_row = bottom_row = False
    extent = 4096
    for line in stream:
        match = TILE.search(line)
        if match and '"FeatureCollection"' in line:
            tz, tx, ty = map(int, match.groups())
            # Only the zoom asked for: a tile from any other zoom has no business here.
            tile = bounds(tz, tx, ty) if tz == z else None
            top_row, bottom_row = ty == 0, ty == n - 1
            continue
        if '"FeatureCollection"' in line:
            found = EXTENT.search(line)
            if found:
                extent = int(found.group(1))
            continue
        text = line.strip().rstrip(",")
        if tile is None or not text.startswith('{ "type": "Feature"'):
            continue
        feature = json.loads(text)
        lon, lat = feature["geometry"]["coordinates"][:2]
        west, south, east, north = tile
        in_south = south < lat or (bottom_row and lat >= south - EDGE_SLACK)
        in_north = lat <= north or (top_row and lat <= north + EDGE_SLACK)
        if west <= lon < east and in_south and in_north:
            yield feature.get("properties", {}), lon, lat, extent


def missing_peaks(source, archive, z):
    """Input peaks with no counted peak of the same name within a few pixels of them."""
    decode = subprocess.Popen(
        ["tippecanoe-decode", f"-z{z}", f"-Z{z}", archive],
        stdout=subprocess.PIPE, text=True,
    )
    tol = None
    cells = None
    index = defaultdict(list)
    for props, lon, lat, extent in counted_features(decode.stdout, z):
        if tol is None:
            # Four pixels of the top zoom, in longitude degrees: tippecanoe rounds more than
            # once, and a latitude degree is never shorter than a longitude degree.
            tol = 4 * 360 / (2 ** z * extent)
            cells = math.ceil(360 / tol)
        cx = math.floor((lon + 180) / tol) % cells
        cy = math.floor((lat + 90) / tol)
        index[(props.get("name"), cx, cy)].append([lon, lat, False])
    decode.wait()
    if tol is None:
        return list(read_source(source))

    missing = []
    for feature in read_source(source):
        props = feature.get("properties", {})
        lon, lat = feature["geometry"]["coordinates"][:2]
        cx = math.floor((lon + 180) / tol) % cells
        cy = math.floor((lat + 90) / tol)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for entry in index.get((props.get("name"), (cx + dx) % cells, cy + dy), ()):
                    if entry[2]:
                        continue
                    dlon = abs(entry[0] - lon)
                    dlon = min(dlon, 360 - dlon)  # 180° and -180° are the same meridian
                    d = max(dlon, abs(entry[1] - lat))
                    if d <= tol and (best is None or d < best[0]):
                        best = (d, entry)
        if best is None:
            missing.append(feature)
        else:
            best[1][2] = True
    return missing


def main():
    source, archive, z = sys.argv[1], sys.argv[2], int(sys.argv[3])

    expected = expected_munros = 0
    for feature in read_source(source):
        expected += 1
        if is_munro(feature.get("properties", {})):
            expected_munros += 1

    count = munros = 0
    for props, _, _, _ in counted_features(sys.stdin, z):
        count += 1
        if is_munro(props):
            munros += 1

    if count == expected and munros == expected_munros:
        print(f"  OK z{z} tiles hold all {count} peaks and {munros} munros")
        return 0

    if count != expected:
        print(f"FAIL: {count} peaks in the z{z} tiles, {expected} in the input")
    if munros != expected_munros:
        print(f"FAIL: {munros} munros in the z{z} tiles, {expected_munros} in the input")
    missing = missing_peaks(source, archive, z)
    print(f"  {len(missing)} input peaks have no match in the tiles"
          + (f" (first {MAX_LISTED}):" if len(missing) > MAX_LISTED else ":"))
    for feature in missing[:MAX_LISTED]:
        props = feature.get("properties", {})
        lon, lat = feature["geometry"]["coordinates"][:2]
        name = props.get("name", "(unnamed)")
        print(f"    node {props.get('@id', '?')}  {name}  {lon:.6f}, {lat:.6f}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
