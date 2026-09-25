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
neighbouring tile's buffer. A feature counts where MapLibre would draw it: only in the tile
that holds it, 0 <= x, y < extent in that tile's own pixels. MapLibre skips the rest so
nothing is drawn twice (`addSymbolAtAnchor` in symbol_layout.ts, and circle_bucket.ts,
read at maplibre-gl 5.24.0). A peak in no tile by that rule is on no map. See
prepare-peak-tiles.py for the two ways tippecanoe leaves one there.

Tested in pixels, not degrees. tippecanoe-decode prints six decimals, and a point snapped
onto a latitude edge could print on either side of it, so a comparison in degrees counted
a point at pixel 4096, which no tile draws, about half the time (found 2026-09-25).
Printed to 1e-6 degrees, a pixel is recovered to within 1/100 at z7 anywhere, and to
within a quarter up to z11 even at the Mercator limit, where a latitude pixel is shortest. A point that cannot be pinned to a pixel that
well fails the check rather than being guessed.

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


def pixel(value):
    """The whole pixel a decoded coordinate stands for, or None if it is too near a half."""
    whole = round(value)
    return whole if abs(value - whole) <= 0.25 else None


def counted_features(stream, z, unclear=None):
    """(properties, lon, lat, extent) for every feature MapLibre would draw from its tile.

    Features that cannot be pinned to a pixel are appended to `unclear`, and not counted.
    """
    n = 2 ** z
    tile = None
    extent = 4096
    for line in stream:
        match = TILE.search(line)
        if match and '"FeatureCollection"' in line:
            tz, tx, ty = map(int, match.groups())
            # Only the zoom asked for: a tile from any other zoom has no business here.
            tile = (tx, ty) if tz == z else None
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
        tx, ty = tile
        px = pixel(((lon + 180) / 360 * n - tx) * extent)
        py = pixel(((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n - ty) * extent)
        if px is None or py is None:
            if unclear is not None:
                unclear.append((tile, feature))
            continue
        if 0 <= px < extent and 0 <= py < extent:
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
    unclear = []
    for props, _, _, _ in counted_features(sys.stdin, z, unclear):
        count += 1
        if is_munro(props):
            munros += 1

    if count == expected and munros == expected_munros and not unclear:
        print(f"  OK z{z} tiles hold all {count} peaks and {munros} munros")
        return 0

    for (tx, ty), feature in unclear[:MAX_LISTED]:
        name = feature.get("properties", {}).get("name", "(unnamed)")
        lon, lat = feature["geometry"]["coordinates"][:2]
        print(f"FAIL: cannot tell which pixel of tile {z}/{tx}/{ty} holds {name} ({lon}, {lat})")

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
