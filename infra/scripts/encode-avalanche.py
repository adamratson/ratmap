#!/usr/bin/env python3
"""Slope and aspect from a Web Mercator DEM, as two single-band Byte rasters.

Why this exists
---------------
The avalanche terrain layer (plans/avalanche-terrain.md) needs the *shape* of the ground:
how steep a slope is, and which way it faces. Both are pure derivatives of the DEM, so
they are computed once at build time from Copernicus GLO-30 and shipped as tiles — no
third-party feed, nothing live, nothing computed in the browser (C14).

The projection trap, which is the whole reason this is a script and not one gdaldem call
------------------------------------------------------------------------------------------
`gdaldem slope` on a Web Mercator raster is **wrong, silently, and in the dangerous
direction**. Mercator stretches horizontal distance by 1/cos(latitude); heights are still
in real metres, so every gradient comes out too shallow by that factor. Measured over Ben
Nevis (2026-09-08, 809 km²):

    correct                                11.8% of terrain >= 30 deg, 5.9% >= 35
    gdaldem on the 3857 raster              0.6%                        0.2%
    gdaldem -s 111120 on the 4326 source    6.0%                        2.7%

The first wrong answer erases 95% of Lochaber's avalanche terrain and renders a real 36
deg slope as 21. The second — the form GDAL's own docs suggest for geographic input —
halves it, because a degree of longitude is cos(lat) as long as a degree of latitude. Both
produce a completely plausible-looking map. This is constraint A1, and it is the reason
this file exists.

The fix is exact rather than approximate: Mercator is *conformal*, so its scale distortion
at a point is identical in x and y. The true ground cell size on a raster row is therefore
`pixelSize * cos(lat)` in both axes, and a slope computed with that cell size is right, not
merely closer. Each row in a 3857 raster is a constant latitude, so this is one multiply
per row.

Reading rasters
---------------
Via GDAL's CLI (`gdal_translate -of ENVI` + numpy memmap + `gdalinfo -json`), matching
compute-prominence.py — the osgeo Python bindings are awkward to install beside a venv and
nothing here needs them.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

# Web Mercator sphere radius, as EPSG:3857 defines it.
R_MERCATOR = 6378137.0

# Below this the layer draws nothing, so the raster stores 0 (constraint A7: that means
# "below the threshold", never "measured flat"). Collapsing the gentle 80% of the ground
# to a single value is also the single biggest lever on artifact size — measured 5.5x.
SLOPE_FLOOR_DEG = 25

# Above this, avalanche behaviour stops changing in a way more numbers would capture:
# snow sluffs continuously off very steep ground rather than building slabs. Clamping
# keeps the byte range tight and costs nothing the map would have shown.
SLOPE_CEIL_DEG = 60

# Aspect is only meaningful where the slope layer says something, and masking it to those
# cells is what makes it affordable: measured +18% on the artifact against +102% unmasked.
# Aspect on a 12-degree meadow is noise in both senses.


def dem_to_envi(path, work):
    """Convert the DEM to a flat float32 file numpy can memory-map. Returns (raw, w, h, gt).

    Deliberately not read into an array. Scotland's bbox at this layer's zoom is 1.6
    gigapixels — 12.4 GB as float64 before a single neighbour is taken — so nothing here
    may hold the whole raster. Same ENVI + memmap route as compute-prominence.py, but the
    mapping stays a mapping.
    """
    raw = os.path.join(work, "dem.img")
    subprocess.run(
        ["gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", path, raw], check=True
    )
    info = json.loads(
        subprocess.run(
            ["gdalinfo", "-json", path], check=True, capture_output=True, text=True
        ).stdout
    )
    width, height = info["size"]
    return raw, width, height, info["geoTransform"]


def envi_header(raw, width, height, dtype=1):
    """Write the sidecar header GDAL needs to read a flat array. `dtype` 1 = byte."""
    with open(os.path.splitext(raw)[0] + ".hdr", "w") as hdr:
        hdr.write(
            "ENVI\nsamples = %d\nlines = %d\nbands = 1\n"
            "header offset = 0\nfile type = ENVI Standard\ndata type = %d\n"
            "interleave = bsq\nbyte order = 0\n" % (width, height, dtype)
        )


def envi_to_tif(raw, width, height, gt, path):
    """Georeference a flat byte array as a GeoTIFF, without copying it through memory."""
    envi_header(raw, width, height)
    ulx, xres, _, uly, _, yres = gt
    subprocess.run(
        [
            "gdal_translate", "-q", "-of", "GTiff", "-co", "COMPRESS=DEFLATE",
            "-a_srs", "EPSG:3857",
            "-a_ullr",
            str(ulx), str(uly), str(ulx + width * xres), str(uly + height * yres),
            raw, path,
        ],
        check=True,
    )


def latitudes(gt, height):
    """Latitude of each raster row centre, in radians, from its Mercator northing."""
    uly, yres = gt[3], gt[5]
    y = uly + (np.arange(height) + 0.5) * yres
    return np.arctan(np.sinh(y / R_MERCATOR))


def horn(padded, cell):
    """Slope (deg) and aspect (compass deg) for the interior of an edge-padded block.

    `padded` carries one extra row and column on every side, so the returned arrays are
    `padded[1:-1, 1:-1]`-shaped. `cell` is the true ground cell size for each *output* row.

    Sliced rather than `np.roll`-ed. Two reasons, and the second is the important one:
    roll wraps, so the outermost ring compared the raster's opposite edges; and roll
    materialises a full copy per neighbour — eight of them — which for a region the size
    of Scotland (1.6 gigapixels) is about 100 GB of temporaries. Slices are views.
    """
    a, b, c = padded[0:-2, 0:-2], padded[0:-2, 1:-1], padded[0:-2, 2:]
    d, f = padded[1:-1, 0:-2], padded[1:-1, 2:]
    g, h, i = padded[2:, 0:-2], padded[2:, 1:-1], padded[2:, 2:]

    # Three buffers, reused, instead of letting each expression allocate its own. Same
    # arithmetic, same order, same results — but `(c + 2*f + i) - (a + 2*d + g)` written
    # as an expression is six full-strip temporaries alive at once, and there are two of
    # them plus the trig chain after.
    shape = (padded.shape[0] - 2, padded.shape[1] - 2)
    dt = padded.dtype
    dzdx = np.empty(shape, dt)
    dzdy = np.empty(shape, dt)
    tmp = np.empty(shape, dt)

    scale = 8 * cell

    np.add(c, i, out=dzdx)
    np.add(dzdx, f, out=dzdx)
    np.add(dzdx, f, out=dzdx)
    np.add(a, g, out=tmp)
    np.add(tmp, d, out=tmp)
    np.add(tmp, d, out=tmp)
    np.subtract(dzdx, tmp, out=dzdx)
    np.divide(dzdx, scale, out=dzdx)

    np.add(g, i, out=dzdy)
    np.add(dzdy, h, out=dzdy)
    np.add(dzdy, h, out=dzdy)
    np.add(a, c, out=tmp)
    np.add(tmp, b, out=tmp)
    np.add(tmp, b, out=tmp)
    np.subtract(dzdy, tmp, out=dzdy)
    np.divide(dzdy, scale, out=dzdy)

    np.hypot(dzdx, dzdy, out=tmp)
    np.arctan(tmp, out=tmp)
    np.degrees(tmp, out=tmp)
    slope = tmp

    # dzdx is dead after this negation, so the aspect chain runs entirely in the two
    # gradient buffers.
    np.negative(dzdx, out=dzdx)
    np.arctan2(dzdx, dzdy, out=dzdy)
    np.degrees(dzdy, out=dzdy)
    np.add(dzdy, 360.0, out=dzdy)
    np.mod(dzdy, 360.0, out=dzdy)
    aspect = dzdy
    return slope, aspect


def pad_edges(block, top, bottom):
    """Replicate the outer row/column so the 3x3 window never reads across the raster.

    `top`/`bottom` say whether this block sits at the real top/bottom of the raster; in
    the middle of a striped pass the neighbouring rows are real data and are passed in
    instead, which is what makes striping give bit-identical results to one big pass.
    """
    return np.pad(block, ((1 if top else 0, 1 if bottom else 0), (1, 1)), mode="edge")


def slope_aspect(dem, gt):
    """Whole-array slope and aspect from a 3857 DEM — used by the self-test.

    Horn's 3x3 method, the one `gdaldem` uses, so anyone cross-checking a value against
    gdaldem on a *metric* raster gets the same number and any difference is the projection
    correction rather than a different estimator.
    """
    height = dem.shape[0]
    # Constraint A1. `xres` is in Mercator units; multiplying by cos(lat) gives true
    # ground metres, identically in both axes because Mercator is conformal.
    cell = (abs(gt[1]) * np.cos(latitudes(gt, height)))[:, None]
    return horn(pad_edges(dem, True, True), cell)


def quantise(slope, aspect):
    """Slope and aspect as the bytes the artifact stores.

    Slope: whole degrees, floored, 0 below the draw threshold and clamped at the ceiling.
    1 degree is already finer than the 5-degree classes the map draws and far finer than
    a 30 m DEM can justify; it also makes `max` pyramid reduction exact per channel.

    Aspect: octant 1-8 (N, NE, E, SE, S, SW, W, NW), 0 wherever slope is 0.
    """
    s = np.floor(slope)
    s[s < SLOPE_FLOOR_DEG] = 0
    s[s > SLOPE_CEIL_DEG] = SLOPE_CEIL_DEG

    octant = (np.floor(((aspect + 22.5) % 360.0) / 45.0) + 1).astype(np.uint8)
    octant[s == 0] = 0

    return s.astype(np.uint8), octant


def reduce_pair(slope, aspect):
    """Halve resolution: slope by 2x2 maximum, aspect following the cell that won.

    Constraint A4. Averaging — which is what every default resampler does — dissolves a
    40-degree gully inside a 25-degree hillside, so the layer stops warning about the
    feature it exists for at exactly the zoom where someone is deciding whether to go and
    look. The error is silent and it under-warns, which is the direction that matters.

    Note this is *not* the same as recomputing slope from a coarsened DEM: that measures
    the gradient of a smoothed surface and loses small steep features just as thoroughly.
    The pyramid reduces the finished slope raster, level by level, from the finest.

    Aspect takes the direction of the steepest cell in the block rather than the majority
    direction. The coarse cell then reads "the steepest thing here is 38 degrees, facing
    north-east" — one coherent statement about one real cell, where a mode would pair the
    steepest slope with some other cell's aspect.

    This is done here, in numpy, and not with `gdal_translate -r max`, because GDAL does
    not implement it: it warns "GDAL_RASTERIO_RESAMPLING = max not supported" and quietly
    falls back to nearest. A pyramid built that way looks completely normal.
    """
    height, width = slope.shape
    height -= height % 2
    width -= width % 2

    def blocks(arr):
        return (arr[:height, :width]
                .reshape(height // 2, 2, width // 2, 2)
                .swapaxes(1, 2)
                .reshape(height // 2, width // 2, 4))

    s_blocks = blocks(slope)
    a_blocks = blocks(aspect)
    winner = s_blocks.argmax(axis=2)[..., None]
    return (
        np.take_along_axis(s_blocks, winner, axis=2)[..., 0],
        np.take_along_axis(a_blocks, winner, axis=2)[..., 0],
    )


def self_test():
    """Assert the maths against planes whose slope is known analytically.

    Earns its place for the same reason normalize-sac.py's does: the failure this guards
    against produces a map that looks right and reads low, and nothing downstream can
    detect it. In particular the last case fails loudly if the cos(lat) correction is ever
    dropped — which is the exact regression that would otherwise ship.
    """
    failures = []

    def check(name, got, want, tol):
        if abs(got - want) > tol:
            failures.append(f"{name}: got {got:.3f}, want {want:.3f}")
        else:
            print(f"  OK {name}: {got:.2f} (want {want:.2f})")

    # A plane at 57N. Pick a Mercator pixel size, derive the true ground cell from it, and
    # build a surface that rises by a known amount per *ground* metre — so the expected
    # slope is known without reference to any of the code under test.
    lat = math.radians(57.0)
    y_top = R_MERCATOR * math.asinh(math.tan(lat))
    xres = 38.2185141425881                       # z11 at 512 px
    ground = xres * math.cos(lat)
    height = width = 64
    gt = [0.0, xres, 0.0, y_top, 0.0, -xres]

    for want_deg in (10.0, 30.0, 45.0):
        rise = math.tan(math.radians(want_deg)) * ground
        # Falling towards +x (east), so the downslope direction is due east: octant 3.
        dem = np.tile(np.arange(width, 0, -1, dtype=np.float64) * rise, (height, 1))
        slope, aspect = slope_aspect(dem, gt)
        check(f"plane {want_deg:.0f} deg at 57N", float(slope[height // 2, width // 2]),
              want_deg, 0.05)
        octant = int(quantise(slope, aspect)[1][height // 2, width // 2])
        if want_deg >= SLOPE_FLOOR_DEG and octant != 3:
            failures.append(f"aspect east: got octant {octant}, want 3")

    # Falling towards +y (south, since rows increase southwards): octant 5.
    rise = math.tan(math.radians(35.0)) * ground
    dem = np.tile((np.arange(height, 0, -1, dtype=np.float64) * rise)[:, None], (1, width))
    slope, aspect = slope_aspect(dem, gt)
    octant = int(quantise(slope, aspect)[1][height // 2, width // 2])
    if octant != 5:
        failures.append(f"aspect south: got octant {octant}, want 5")
    else:
        print("  OK aspect south: octant 5")

    # The regression guard. The same physical plane at two latitudes must read the same
    # slope; it only does if the projection correction is applied. Without it the 57N
    # reading collapses to about 21 degrees against 35 — which is the measured Ben Nevis
    # failure in miniature.
    def slope_at(lat_deg, want_deg):
        la = math.radians(lat_deg)
        gt_l = [0.0, xres, 0.0, R_MERCATOR * math.asinh(math.tan(la)), 0.0, -xres]
        rise = math.tan(math.radians(want_deg)) * xres * math.cos(la)
        dem_l = np.tile(np.arange(width, 0, -1, dtype=np.float64) * rise, (height, 1))
        return float(slope_aspect(dem_l, gt_l)[0][height // 2, width // 2])

    check("same plane at 5N", slope_at(5.0, 35.0), 35.0, 0.05)
    check("same plane at 57N", slope_at(57.0, 35.0), 35.0, 0.05)
    check("same plane at 70N", slope_at(70.0, 35.0), 35.0, 0.05)

    # Quantisation boundaries, including the direction each rounds.
    s, o = quantise(np.array([[0.0, 24.99, 25.0, 29.99, 59.4, 61.0, 88.0]]),
                    np.array([[0.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0]]))
    if list(s[0]) != [0, 0, 25, 29, 59, 60, 60]:
        failures.append(f"quantise slope: got {list(s[0])}")
    else:
        print("  OK quantise slope boundaries")
    if list(o[0]) != [0, 0, 1, 1, 1, 1, 1]:
        failures.append(f"quantise aspect mask: got {list(o[0])}")
    else:
        print("  OK quantise aspect masked below the floor")

    # Pyramid reduction. A single steep cell hidden in gentle ground must survive, and
    # must carry its own aspect up with it — the exact case an averaging resampler loses.
    s = np.zeros((4, 4), dtype=np.float64)
    a = np.full((4, 4), 1.0)
    s[1, 1] = 47.0
    a[1, 1] = 6.0
    rs, ra = reduce_pair(s, a)
    if rs.shape != (2, 2) or rs[0, 0] != 47.0:
        failures.append(f"reduce max: got {rs.tolist()}")
    elif ra[0, 0] != 6.0:
        failures.append(f"reduce aspect follows the steepest cell: got {ra[0, 0]}")
    else:
        print("  OK reduce keeps the steepest cell and its aspect")
    if rs[1, 1] != 0.0:
        failures.append("reduce leaked a value into an untouched block")

    if failures:
        for line in failures:
            print(f"  FAIL {line}", file=sys.stderr)
        sys.exit(f"{len(failures)} self-test failure(s)")
    print("  self-test passed")


# Rows per strip. Slope is a local 3x3 operator, so a strip plus a one-row halo gives
# bit-identical results to one big pass — striping here is purely about memory.
#
# Peak RSS measured over a 108 Mpx raster (2026-09-08) fits
#
#     10.5 x STRIP_BYTES  +  6 bytes per pixel
#
# almost exactly, at two raster sizes. The second term is not this process's to spend: it
# is page cache for the DEM (float32, 4 B/px) and the two byte rasters being written, all
# file-backed and evictable. The first term is the real working set — the strip itself
# plus the gradient and trig buffers — and it is what this constant buys.
#
# 16 MB rather than 64: measured 1375 MB peak at 64 MB against 791 MB at 16 MB on that
# raster, for no time cost at all (4.8 s against 4.6 s), because the loop is bound by
# memory bandwidth and page faults rather than by how much it chews at once. Below about
# 8 MB the curve flattens — there is nothing left to win.
STRIP_BYTES = 16 << 20


def compute_levels(dem_raw, width, height, gt, work, zmax, zmin):
    """Slope and aspect at zmax, then the max-reduced pyramid, all through memmaps.

    Returns the per-class histogram at the top zoom. Nothing larger than one strip is ever
    held in memory, so a gigapixel region costs the same RAM as a small one.
    """
    dem = np.memmap(dem_raw, dtype="float32", mode="r", shape=(height, width))
    slope_raw = os.path.join(work, f"slope-{zmax}.img")
    aspect_raw = os.path.join(work, f"aspect-{zmax}.img")
    slope = np.memmap(slope_raw, dtype="uint8", mode="w+", shape=(height, width))
    aspect = np.memmap(aspect_raw, dtype="uint8", mode="w+", shape=(height, width))

    lat_cell = abs(gt[1]) * np.cos(latitudes(gt, height))
    rows = max(1, min(height, STRIP_BYTES // max(1, width * 8)))
    counts = np.zeros(256, dtype=np.int64)

    for r0 in range(0, height, rows):
        r1 = min(height, r0 + rows)
        # One real row of context on each side where it exists; replicate only at the
        # raster's true edges. This is what makes the striped result identical to a
        # single pass rather than seams of invented cliffs every `rows` rows.
        lo, hi = max(0, r0 - 1), min(height, r1 + 1)
        block = np.asarray(dem[lo:hi], dtype=np.float64)
        padded = pad_edges(block, lo == r0, hi == r1)
        s_deg, a_deg = horn(padded, lat_cell[r0:r1][:, None])
        s_b, a_b = quantise(s_deg, a_deg)
        slope[r0:r1] = s_b
        aspect[r0:r1] = a_b
        counts += np.bincount(s_b.ravel(), minlength=256)

    slope.flush()
    aspect.flush()
    del dem

    levels = {zmax: (slope_raw, aspect_raw, width, height)}
    level_gt = list(gt)
    prev_max = int(np.flatnonzero(counts)[-1])

    for z in range(zmax - 1, zmin - 1, -1):
        parent_s, parent_a, pw, ph = levels[z + 1]
        cw, ch = pw // 2, ph // 2
        if cw < 1 or ch < 1:
            break
        ps = np.memmap(parent_s, dtype="uint8", mode="r", shape=(ph, pw))
        pa = np.memmap(parent_a, dtype="uint8", mode="r", shape=(ph, pw))
        child_s = os.path.join(work, f"slope-{z}.img")
        child_a = os.path.join(work, f"aspect-{z}.img")
        cs = np.memmap(child_s, dtype="uint8", mode="w+", shape=(ch, cw))
        ca = np.memmap(child_a, dtype="uint8", mode="w+", shape=(ch, cw))

        chunk = max(1, min(ch, STRIP_BYTES // max(1, pw * 2)))
        level_max = 0
        for r0 in range(0, ch, chunk):
            r1 = min(ch, r0 + chunk)
            rs, ra = reduce_pair(
                np.asarray(ps[2 * r0 : 2 * r1]), np.asarray(pa[2 * r0 : 2 * r1])
            )
            cs[r0:r1] = rs
            ca[r0:r1] = ra
            if rs.size:
                level_max = max(level_max, int(rs.max()))
        cs.flush()
        ca.flush()
        del ps, pa, cs, ca

        # The point of reducing by maximum, asserted rather than assumed: coarsening must
        # never lower the steepest slope on the sheet. This is the check that would have
        # caught `gdal_translate -r max` silently falling back to nearest.
        if level_max != prev_max:
            sys.exit(
                f"FAIL: reducing z{z + 1} -> z{z} changed the maximum slope "
                f"{prev_max} -> {level_max}"
            )
        level_gt[1] *= 2
        level_gt[5] *= 2
        levels[z] = (child_s, child_a, cw, ch)

    return levels, counts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-test", action="store_true",
                    help="check the maths against known planes and exit")
    ap.add_argument("dem", nargs="?", help="DEM GeoTIFF in EPSG:3857, at the top zoom")
    ap.add_argument("out_dir", nargs="?", help="directory for slope-<z>/aspect-<z> rasters")
    ap.add_argument("--zmax", type=int, help="zoom the DEM is gridded at")
    ap.add_argument("--zmin", type=int, help="coarsest zoom to reduce down to")
    ap.add_argument("--stats-json", help="write the class histogram here")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return
    if not (args.dem and args.out_dir and args.zmax is not None and args.zmin is not None):
        ap.error("dem, out_dir, --zmax and --zmin are required unless --self-test")

    dem_raw, width, height, gt = dem_to_envi(args.dem, args.out_dir)
    print(f"  raster: {width} x {height} px ({width * height / 1e6:.1f} Mpx)")

    levels, counts = compute_levels(
        dem_raw, width, height, gt, args.out_dir, args.zmax, args.zmin
    )

    # Reported at the top zoom only. It is what the build asserts against, and every way
    # this can go wrong — the projection correction, the pyramid reduction, a resampling
    # fallback — moves it by a large factor rather than a subtle one.
    total = int(counts.sum())
    stats = {
        "zmax": args.zmax,
        "cells": total,
        "max_slope": int(np.flatnonzero(counts)[-1]),
        "classes": {},
    }
    print(f"  slope at z{args.zmax}: max {stats['max_slope']} deg")
    for lo, hi in ((25, 30), (30, 35), (35, 40), (40, 45), (45, 61)):
        pct = 100.0 * int(counts[lo:hi].sum()) / max(1, total)
        stats["classes"][f"{lo}-{hi - 1}"] = round(pct, 4)
        print(f"    {lo}-{hi - 1} deg: {pct:6.2f}%")

    level_gt = list(gt)
    for z in range(args.zmax, args.zmin - 1, -1):
        if z not in levels:
            break
        slope_raw, aspect_raw, w, h = levels[z]
        envi_to_tif(slope_raw, w, h, level_gt, os.path.join(args.out_dir, f"slope-{z}.tif"))
        envi_to_tif(aspect_raw, w, h, level_gt, os.path.join(args.out_dir, f"aspect-{z}.tif"))
        level_gt[1] *= 2
        level_gt[5] *= 2

    if args.stats_json:
        with open(args.stats_json, "w") as handle:
            json.dump(stats, handle, indent=1)


if __name__ == "__main__":
    main()
