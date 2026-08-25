#!/usr/bin/env python3
"""Compute topographic prominence for peaks from a DEM, and write it onto each feature.

Why this exists
---------------
Deciding which summits to show at which zoom needs a measure of how much a peak *stands
out*, not how tall it is. Absolute elevation encodes an assumption about local terrain and
does not travel: Scotland has ~4 peaks per square degree above 1000 m, Montenegro has ~674.
A threshold tuned on one produces an unreadable wall of labels on the other (measured
2026-08-23).

Prominence is the cartographically correct measure — the plan names it — but OSM tags it
far too sparsely to rely on (`prominence` is present on a small fraction of peaks), so it
is computed here instead.

Method
------
Level-set / "descending water level":

    for each threshold t, high to low:
        label the connected components of (dem >= t)
        any peak that now shares a component with a *higher* peak has just been connected
        to higher ground, so its key col is at t and its prominence is elev - t

This is the standard definition, discretised to `--step` metres. `scipy.ndimage.label`
does the connected-component work in C, so cost is (number of thresholds) x (raster size)
rather than anything per-peak.

Honest limitations
------------------
* Prominence is quantised to `--step` (default 20 m). Fine for ranking; do not present
  these as surveyed figures.
* Summit heights come from the DEM, not from OSM's `ele`, because prominence is
  summit-minus-col measured on one surface. OSM `ele` is still what the app displays.
* Downsampling requests `-r max` to preserve summits; GDAL warns that max is unsupported
  on the overview read path and falls back. Validated regardless: median error against ten
  published Scottish prominences is 19 m, inside the 20 m quantisation step.
* Prominence is computed within the supplied bbox only. A peak whose true key col lies
  outside the box gets its prominence measured to the box edge, which over-states it.
  Regions are countries or ranges, so this bites only at borders — the alternative is
  loading a continent to rank a valley.
* The highest peak in the box never connects to anything higher, so it has no key col.
  It is assigned elev - (lowest elevation in the box), the usual convention.
* That last case misfires when the box's true high ground belongs to a peak that is *not*
  in the OSM input. Montenegro's bbox clips part of Albania, whose Maja Jezercë (2694 m)
  is the DEM maximum but is absent from a Montenegro-only extract — so the highest
  *Montenegrin* peak near it inherits the no-key-col case and is over-ranked. Only ever
  affects the single top entry per box. Fixing it properly means pulling neighbouring
  countries' peaks for border regions.

Do not read these as published prominences. Zla Kolata is Montenegro's high point but
scores 708 m here, correctly: higher Albanian ground sits inside the same bbox, so it is
not the dominant summit of its range. Its "2535 m" under an earlier version was the
box-summit artifact above, not a better answer.
"""
import argparse
import json
import math
import sys

import numpy as np
from scipy import ndimage


def downsample_max(dem, factor):
    """Block-max downsample. Max, not mean: it preserves summit elevations, which is what
    peaks are matched against."""
    if factor <= 1:
        return dem
    h, w = dem.shape
    h2, w2 = (h // factor) * factor, (w // factor) * factor
    trimmed = dem[:h2, :w2]
    return trimmed.reshape(h2 // factor, factor, w2 // factor, factor).max(axis=(1, 3))


def load_peaks(path):
    peaks = []
    with open(path) as f:
        for line in f:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            feature = json.loads(line)
            peaks.append(feature)
    return peaks


def compute(dem, transform, peaks, step, floor):
    """Return {peak_index: prominence_m} for peaks inside the raster."""
    lon0, dlon, _, lat0, _, dlat = transform
    h, w = dem.shape

    # Map each peak to a raster cell.
    located = []
    for i, feature in enumerate(peaks):
        coords = (feature.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        lon, lat = coords[0], coords[1]
        col = int((lon - lon0) / dlon)
        row = int((lat - lat0) / dlat)
        if not (0 <= row < h and 0 <= col < w):
            continue

        # Summit height for the prominence arithmetic comes from the DEM, never from OSM's
        # `ele`, even when OSM has one.
        #
        # Prominence is a property of a surface: summit height minus key col height, both
        # measured on the same surface. Mixing OSM's tagged elevation with a DEM-derived
        # col produced negative "prominence" for 29% of Montenegro's features — a node
        # tagged `ele=149` sitting on ground the DEM puts far higher merges at a threshold
        # above its tagged height. Negative values are not merely wrong, they fail the
        # app's `>= -1` sentinel check and would hide those peaks at every zoom.
        #
        # OSM `ele` remains what gets *displayed*: it matches the signage on the hill.
        located.append((i, row, col, None))

    if not located:
        return {}

    # Snap each peak to the highest cell in a small neighbourhood. OSM summit coordinates
    # and a 30 m DEM disagree by a cell or two, and landing on a slope instead of the
    # summit would merge the peak into higher ground immediately and report ~0 prominence.
    snap = 2
    for n, (i, row, col, _) in enumerate(located):
        r0, r1 = max(0, row - snap), min(h, row + snap + 1)
        c0, c1 = max(0, col - snap), min(w, col + snap + 1)
        window = dem[r0:r1, c0:c1]
        dr, dc = np.unravel_index(np.argmax(window), window.shape)
        srow, scol = r0 + int(dr), c0 + int(dc)
        located[n] = (i, srow, scol, float(dem[srow, scol]))

    order = sorted(range(len(located)), key=lambda n: located[n][3], reverse=True)
    rank_of = {n: rank for rank, n in enumerate(order)}  # 0 = highest peak

    rows = np.array([p[1] for p in located])
    cols = np.array([p[2] for p in located])

    prominence = {}
    resolved = set()
    dem_max = float(np.nanmax(dem))
    dem_min = float(np.nanmin(dem[dem > -1000])) if np.any(dem > -1000) else 0.0

    thresholds = np.arange(
        math.floor(dem_max / step) * step, max(floor, dem_min) - step, -step
    )

    for t in thresholds:
        if len(resolved) >= len(located) - 1:
            break  # only the summit of the box left; it has no key col by definition

        labels, _ = ndimage.label(dem >= t)
        peak_labels = labels[rows, cols]

        # Group peaks by component; within a component the highest peak "owns" it and
        # every lower peak has just been connected to higher ground.
        best_in_label = {}
        for n, lbl in enumerate(peak_labels):
            if lbl == 0:
                continue  # this peak is not above the current water level yet
            current = best_in_label.get(lbl)
            if current is None or rank_of[n] < rank_of[current]:
                best_in_label[lbl] = n

        for n, lbl in enumerate(peak_labels):
            if lbl == 0 or n in resolved:
                continue
            owner = best_in_label[lbl]
            if owner == n:
                continue
            # max(0, …) is a safety net, not the fix: with the summit height read from
            # the same DEM as the col, a merge cannot happen above the summit. Guards
            # against a future change reintroducing mixed sources.
            prominence[located[n][0]] = round(max(0.0, located[n][3] - float(t)), 1)
            resolved.add(n)

    # Whatever never merged is the high point of the box.
    for n, (i, _, _, ele) in enumerate(located):
        if n not in resolved:
            prominence[i] = round(max(0.0, ele - dem_min), 1)

    return prominence


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dem", help="GeoTIFF clipped to the region bbox")
    ap.add_argument("peaks_in", help="line-delimited GeoJSON")
    ap.add_argument("peaks_out", help="line-delimited GeoJSON with `prom` added")
    ap.add_argument("--step", type=float, default=20.0, help="metres per level set")
    ap.add_argument("--floor", type=float, default=0.0, help="stop descending here")
    ap.add_argument("--downsample", type=int, default=3, help="block-max factor")
    args = ap.parse_args()

    # Read the GeoTIFF via GDAL's CLI rather than Python bindings: gdal_translate to
    # ENVI gives a plain binary array plus a text header, which numpy can memory-map.
    # Avoids requiring the osgeo bindings, which are awkward to install next to a venv.
    import subprocess
    import tempfile
    import os

    factor = max(1, args.downsample)

    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "dem.img")
        subprocess.run(
            ["gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", args.dem, raw],
            check=True,
        )
        info = json.loads(
            subprocess.run(
                ["gdalinfo", "-json", args.dem], check=True, capture_output=True, text=True
            ).stdout
        )
        w, h = info["size"]
        gt = info["geoTransform"]

        # Take the array off the mapping, and drop the mapping, *before* the directory
        # is deleted. Both halves matter:
        #
        # `np.asarray(memmap)` does not copy — it returns a base-class view whose `.base`
        # is still the memmap — so an earlier version left `dem.img` mapped after the
        # block exited and did all of its work against a file the cleanup had just
        # unlinked. On a local filesystem that quietly works: the unlink succeeds, the
        # pages stay valid, nothing complains. On any filesystem that renames a still-open
        # file aside instead of unlinking it — NFS's `.nfsXXXX`, FUSE/VirtioFS's
        # `.fuse_hiddenXXXX`, and /work is a mounted volume — the rename leaves an entry
        # behind and TemporaryDirectory's own rmdir dies with `[Errno 39] Directory not
        # empty` — after the DEM fetch and before a single peak is scored (2026-08-24
        # planet run, lochaber).
        #
        # `del` rather than trusting the end of the block: CPython drops the last
        # reference here and closes the mapping deterministically, which is the point.
        mm = np.memmap(raw, dtype="float32", mode="r", shape=(h, w))
        try:
            # Copy, not view. At 1x this is one in-RAM array the size of the DEM — small
            # against what compute() allocates per threshold anyway (a bool mask plus an
            # int32 label array of the same shape, several hundred times over).
            dem = np.array(downsample_max(mm, factor))
        finally:
            del mm

    if factor > 1:
        gt = [gt[0], gt[1] * factor, gt[2], gt[3], gt[4], gt[5] * factor]

    peaks = load_peaks(args.peaks_in)
    prominence = compute(dem, gt, peaks, args.step, args.floor)

    with open(args.peaks_out, "w") as out:
        for i, feature in enumerate(peaks):
            if i in prominence:
                feature.setdefault("properties", {})["prom"] = prominence[i]
            out.write(json.dumps(feature))
            out.write("\n")

    values = sorted(prominence.values(), reverse=True)
    print(
        f"prominence: {len(prominence)} of {len(peaks)} peaks scored "
        f"(raster {dem.shape[1]}x{dem.shape[0]} @ {factor}x, {args.step:g} m steps)"
    )
    if values:
        print(
            f"  max {values[0]:.0f} m | median {values[len(values) // 2]:.0f} m | "
            f"P90 {values[len(values) // 10]:.0f} m"
        )


if __name__ == "__main__":
    sys.exit(main())
