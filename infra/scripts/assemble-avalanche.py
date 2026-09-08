#!/usr/bin/env python3
"""Assemble per-zoom slope/aspect rasters into one MBTiles pyramid, losslessly.

Why this is not `gdaladdo`
--------------------------
The pyramid for this layer must reduce by **maximum**, not by average (constraint A4):
averaging dissolves a 40-degree gully inside a 25-degree hillside, so the layer quietly
stops warning about exactly the feature it exists for, and it does so in the direction that
under-warns. `gdaladdo -r max` does not exist — GDAL 3.13 answers "Unsupported resampling
method 'max'" for single- and multi-band alike — and `gdal_translate -tr ... -r max`,
which looks like the way round it, only *warns* ("GDAL_RASTERIO_RESAMPLING = max not
supported") and silently falls back to nearest. So encode-avalanche.py does the reduction
itself in numpy and hands the whole stack to this script, which only has to tile and merge.

Aspect is not reduced independently: it follows whichever cell won the slope maximum, so a
coarse cell reads "the steepest thing here is 38 degrees, facing north-east" — one coherent
statement about one real cell, where a separate mode would pair the steepest slope with
some other cell's direction.

Why the encoding is checked rather than trusted
-----------------------------------------------
These RGB bytes are three numbers, not a colour. GDAL's MBTiles driver offers WEBP only
through `QUALITY`, which is lossy at every value including 100 — measured, a channel
written as the constant 128 came back spread over 92-133. Decoded as a DEM that is a
+/-9216-degree error per corrupted byte, scattered as plausible-looking noise across the
map (constraint A3). So tiles are written as PNG, and the optional WebP pass re-encodes
them with `cwebp -lossless -exact` and then **decodes every re-encoded tile back and
compares it byte for byte** with the PNG it came from. A pass that cannot prove itself
does not run.
"""

import argparse
import concurrent.futures
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile


def gdal_translate_mbtiles(src, dst, tile_format="PNG"):
    subprocess.run(
        [
            "gdal_translate", "-q", "-of", "MBTILES",
            "-co", f"TILE_FORMAT={tile_format}",
            "-co", "BLOCKSIZE=512",
            # The input is already at this zoom's exact resolution and snapped to the tile
            # grid, so the driver has nothing to resample. NEAREST makes that explicit:
            # any interpolation here would blend two slope classes into a value that
            # exists in neither cell.
            "-co", "RESAMPLING=NEAREST",
            src, dst,
        ],
        check=True,
    )


def level_tiles(mbtiles):
    """(zoom, [(z, x, y, blob)]) for a single-level MBTiles."""
    con = sqlite3.connect(mbtiles)
    try:
        zooms = [r[0] for r in con.execute("SELECT DISTINCT zoom_level FROM tiles")]
        rows = con.execute(
            "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles"
        ).fetchall()
    finally:
        con.close()
    return zooms, rows


def decode_to_raw(path, work, index=0):
    """Decode an image to a raw band-sequential array via GDAL, returning the bytes.

    `INTERLEAVE=BSQ` is not a detail. Left to itself GDAL picks the interleave that suits
    each source driver — BIP for PNG, BSQ for WebP — so comparing the two raw dumps of
    *identical* pixels reports 65% of bytes differing while every band statistic matches.
    That is exactly what the first run of this check did, and it failed the build on a
    lossless re-encode that was in fact perfect. Pinning the layout compares pixels.
    """
    out = os.path.join(work, f"d{index}.img")
    stem = os.path.splitext(out)[0]
    for stale in (out, out + ".aux.xml", stem + ".hdr"):
        if os.path.exists(stale):
            os.remove(stale)
    subprocess.run(
        ["gdal_translate", "-q", "-of", "ENVI", "-co", "INTERLEAVE=BSQ", path, out],
        check=True,
    )
    with open(out, "rb") as handle:
        return handle.read()


# cwebp compression effort. Measured on a real tile from this pipeline (2026-09-08):
#
#     -z 0    69 728 bytes   0.01 s
#     -z 3    51 594 bytes   0.03 s
#     -z 6    50 986 bytes   0.05 s
#     -z 9    48 508 bytes   2.71 s
#
# `-z 9` costs **54x the CPU of -z 6 for 4.9% smaller files**. That is the whole reason
# this pass used to saturate a laptop: eight threads each holding a core at 100% for
# minutes, to save about 2 MB on a 40 MB region. 6 is the knee of the curve. Raise it with
# AVALANCHE_WEBP_EFFORT on a machine that has time to spare and nothing else to do.
WEBP_EFFORT = os.environ.get("AVALANCHE_WEBP_EFFORT", "6")


def _webp_one(args):
    """Re-encode one tile and prove it decodes identically. Returns (z, x, y, bytes)."""
    z, x, y, blob, work, index = args
    png_path = os.path.join(work, f"t{index}.png")
    webp_path = os.path.join(work, f"t{index}.webp")
    with open(png_path, "wb") as handle:
        handle.write(blob)
    subprocess.run(
        ["cwebp", "-quiet", "-lossless", "-z", WEBP_EFFORT, "-exact",
         png_path, "-o", webp_path],
        check=True,
    )
    if decode_to_raw(png_path, work, index) != decode_to_raw(webp_path, work, index):
        raise ValueError(f"WebP re-encode of tile {z}/{x}/{y} does not decode identically")
    with open(webp_path, "rb") as handle:
        return (z, x, y, handle.read())


def to_lossless_webp(rows, work, jobs=None):
    """Re-encode PNG tiles as lossless WebP, proving each one decodes identically.

    Returns the re-encoded rows, or None if cwebp is unavailable. Any tile that fails to
    round-trip aborts the build rather than being silently kept as PNG — a pyramid that is
    half one format and half another, with no record of which, is worse than a larger one.

    Run across `jobs` threads, half the cores by default. Each tile costs a cwebp plus two
    `gdal_translate` decodes for the proof — about 0.43 s at the default effort, of which
    0.38 s is the two decodes. The work is embarrassingly parallel and the calls spend
    their lives in subprocesses, so threads are enough; there is no GIL contention worth
    the name.

    `jobs` exists because this is not the only thing running: the avalanche stage builds
    several regions at once (RATMAP_AVALANCHE_PARALLEL, 4 by default), and a thread per
    core in each of them is four times the machine's cores in `cwebp` processes. Taking a
    share rather than the lot is what makes the outer number a throughput setting instead
    of a queueing one.
    """
    if not shutil.which("cwebp"):
        print("  cwebp not found — keeping PNG tiles")
        return None

    # Half the cores by default, not all of them. This is a build tool that people run on
    # the laptop they are also using: taking every core (including the efficiency cores
    # macOS runs background work on) makes the machine unusable for the duration, which is
    # exactly what happened on the first Aragón run. A build box can have the lot via
    # --jobs.
    workers = max(1, min(len(rows), jobs or max(1, (os.cpu_count() or 4) // 2)))
    print(f"  re-encoding {len(rows)} tiles as WebP, {workers} at a time")
    tasks = [(z, x, y, blob, work, i) for i, (z, x, y, blob) in enumerate(rows)]
    out = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        try:
            for result in pool.map(_webp_one, tasks):
                out.append(result)
        except ValueError as err:
            sys.exit(f"FAIL: {err}")
    return out


def write_mbtiles(path, rows, name, tile_format, bounds, minzoom, maxzoom):
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    try:
        con.execute("CREATE TABLE metadata (name text, value text)")
        con.execute(
            "CREATE TABLE tiles (zoom_level integer, tile_column integer, "
            "tile_row integer, tile_data blob)"
        )
        con.execute(
            "CREATE UNIQUE INDEX tile_index ON tiles "
            "(zoom_level, tile_column, tile_row)"
        )
        con.executemany("INSERT INTO tiles VALUES (?,?,?,?)", rows)
        con.executemany(
            "INSERT INTO metadata VALUES (?,?)",
            [
                ("name", name),
                ("format", tile_format),
                ("type", "overlay"),
                ("version", "1"),
                ("description", "ratmap avalanche terrain (slope, aspect)"),
                ("bounds", ",".join(f"{v:.6f}" for v in bounds)),
                ("minzoom", str(minzoom)),
                ("maxzoom", str(maxzoom)),
            ],
        )
        con.commit()
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--bounds", required=True, help="w,s,e,n in degrees")
    ap.add_argument("--webp", action="store_true", help="re-encode tiles as lossless WebP")
    ap.add_argument("--jobs", type=int, default=None,
                    help="tiles to re-encode at once (default: one per core). Set this "
                         "below the core count when several regions build in parallel.")
    ap.add_argument("levels", nargs="+", metavar="Z:RASTER",
                    help="one zoom level and its already-reduced RGB raster")
    args = ap.parse_args()

    # Batch work, explicitly deprioritised. Costs nothing when the machine is idle and is
    # the difference between "the build is running" and "the laptop is gone" when it is
    # not. Children inherit it, so this covers every cwebp and gdal_translate below.
    try:
        os.nice(10)
    except (OSError, AttributeError):
        pass

    all_rows = []
    zooms = []
    with tempfile.TemporaryDirectory() as work:
        for spec in args.levels:
            z_text, raster = spec.split(":", 1)
            z = int(z_text)
            level_db = os.path.join(work, f"l{z}.mbtiles")
            gdal_translate_mbtiles(raster, level_db)

            got_zooms, rows = level_tiles(level_db)
            # The driver picks a zoom from the raster's resolution. Every level here is
            # built at exactly one zoom's resolution, so a mismatch means the resolution
            # maths and the tile grid have drifted apart — which would silently stack two
            # levels on top of each other in the merged archive.
            if got_zooms != [z]:
                sys.exit(
                    f"FAIL: raster for z{z} tiled as {got_zooms}; "
                    "resolution and tile grid disagree"
                )
            print(f"  z{z}: {len(rows)} tiles")
            all_rows.extend(rows)
            zooms.append(z)

        tile_format = "png"
        if args.webp:
            converted = to_lossless_webp(all_rows, work, args.jobs)
            if converted is not None:
                png_bytes = sum(len(r[3]) for r in all_rows)
                webp_bytes = sum(len(r[3]) for r in converted)
                print(f"  lossless WebP: {webp_bytes / 1024:.0f} kB "
                      f"({100 * webp_bytes / png_bytes:.0f}% of PNG), "
                      f"all {len(converted)} tiles verified identical after decode")
                all_rows = converted
                tile_format = "webp"

    bounds = [float(v) for v in args.bounds.split(",")]
    write_mbtiles(args.out, all_rows, args.name, tile_format, bounds,
                  min(zooms), max(zooms))
    total = sum(len(r[3]) for r in all_rows)
    print(f"  {len(all_rows)} tiles, {total / 1024:.0f} kB of tile data, "
          f"z{min(zooms)}-z{max(zooms)}, {tile_format}")


if __name__ == "__main__":
    main()
