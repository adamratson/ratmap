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

Running it
----------
build-peaks.sh runs this once for the whole catalogue (`--regions`). It reads the peaks'
coordinates once, fetches each region's DEM with fetch-dem.sh, scores the regions one
after another smallest bbox first, and writes the output once at the end. Until
2026-09-23 build-peaks.sh ran it once per region instead, and every run parsed and rewrote
every peak in the file: 3.3 s and 1.1 GB per region at Europe scale (658 k features),
184 times over. The result is byte-identical: same order, same overwrites, same JSON.

Given a single DEM instead of `--regions`, it scores that one raster, as it always did.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

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


def iter_features(path):
    """Features of a line-delimited GeoJSON file, in order, one at a time."""
    with open(path) as f:
        for line in f:
            line = line.lstrip("\x1e").strip()
            if line:
                yield json.loads(line)


def load_coords(path):
    """Every feature's point as two float64 arrays indexed like the file — 16 bytes a peak,
    where holding the parsed features cost 1.1 GB at Europe scale (658 k of them). NaN for
    a feature with no coordinates: compute() skips those, and NaN fails every bounds test."""
    lons, lats = [], []
    for feature in iter_features(path):
        coords = (feature.get("geometry") or {}).get("coordinates")
        lons.append(coords[0] if coords else math.nan)
        lats.append(coords[1] if coords else math.nan)
    return np.array(lons, dtype=np.float64), np.array(lats, dtype=np.float64)


def read_dem(path, factor):
    """The DEM as a float32 array plus its geotransform, block-max downsampled by `factor`.

    Through GDAL's CLI rather than Python bindings: gdal_translate to ENVI gives a plain
    binary array plus a text header, which numpy reads directly. Avoids requiring the
    osgeo bindings, which are awkward to install next to a venv.

    Read with np.fromfile rather than memory-mapped. The mapping used to outlive the
    temporary directory — `np.asarray(memmap)` does not copy, its `.base` is still the
    memmap — and on a filesystem that renames a still-open file aside instead of unlinking
    it (NFS's `.nfsXXXX`, FUSE/VirtioFS's `.fuse_hiddenXXXX`; /work is a mounted volume)
    the cleanup then died with `[Errno 39] Directory not empty`, after the DEM fetch and
    before a single peak was scored (2026-08-24 planet run, lochaber). A plain read holds
    no mapping at all, and makes one copy of the raster where memmap plus np.array made
    two resident at once.
    """
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "dem.img")
        subprocess.run(
            ["gdal_translate", "-q", "-of", "ENVI", "-ot", "Float32", path, raw],
            check=True,
        )
        info = json.loads(
            subprocess.run(
                ["gdalinfo", "-json", path], check=True, capture_output=True, text=True
            ).stdout
        )
        w, h = info["size"]
        gt = info["geoTransform"]
        dem = downsample_max(np.fromfile(raw, dtype="float32").reshape(h, w), factor)

    if factor > 1:
        gt = [gt[0], gt[1] * factor, gt[2], gt[3], gt[4], gt[5] * factor]
    return dem, gt


def score_region(dem, gt, lons, lats, step, floor):
    """compute() over the peaks that can fall inside this raster, keyed by feature index.

    Returns ({feature_index: prominence_m}, number_of_candidates).

    Only a pre-filter: compute() still makes the exact in-raster decision itself. The box
    is the raster's own extent padded by two pixels, a strict superset of what compute()
    accepts — its `int()` truncates toward zero, so it takes peaks up to one pixel past the
    west and north edges. Candidates keep file order, so compute() sees the same peaks in
    the same order as when it was handed the whole file, and its ranking and tie-breaks
    come out identical.
    """
    h, w = dem.shape
    lon0, dlon, _, lat0, _, dlat = gt
    pad_x, pad_y = 2 * abs(dlon), 2 * abs(dlat)
    x_lo, x_hi = sorted((lon0, lon0 + w * dlon))
    y_lo, y_hi = sorted((lat0, lat0 + h * dlat))
    sel = np.flatnonzero(
        (lons >= x_lo - pad_x) & (lons <= x_hi + pad_x)
        & (lats >= y_lo - pad_y) & (lats <= y_hi + pad_y)
    )
    candidates = [
        {"geometry": {"coordinates": [float(lons[j]), float(lats[j])]}} for j in sel
    ]
    local = compute(dem, gt, candidates, step, floor)
    return {int(sel[pos]): value for pos, value in local.items()}, len(sel)


def write_output(peaks_in, peaks_out, prom):
    """Stream the input to the output, adding `prom` where scored. Every feature goes back
    through json.dumps, exactly as each per-region pass used to write the whole file."""
    with open(peaks_out, "w") as out:
        for i, feature in enumerate(iter_features(peaks_in)):
            if i in prom:
                feature.setdefault("properties", {})["prom"] = prom[i]
            out.write(json.dumps(feature))
            out.write("\n")


def report(scored, candidates, total, shape, factor, step):
    values = sorted(scored.values(), reverse=True)
    print(
        f"prominence: {len(scored)} of {candidates} candidate peaks scored, {total} in all "
        f"(raster {shape[1]}x{shape[0]} @ {factor}x, {step:g} m steps)"
    )
    if values:
        print(
            f"  max {values[0]:.0f} m | median {values[len(values) // 2]:.0f} m | "
            f"P90 {values[len(values) // 10]:.0f} m"
        )
    sys.stdout.flush()


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
    # The minimum over cells above -1000 m, without materialising them: indexing with the
    # mask would copy every valid cell, 4 bytes a pixel on top of the DEM itself. Same
    # value — NaN is not > -1000, so the mask already leaves out what nanmin skipped.
    valid = dem > -1000
    dem_min = float(dem.min(where=valid, initial=np.inf)) if valid.any() else 0.0
    del valid

    thresholds = np.arange(
        math.floor(dem_max / step) * step, max(floor, dem_min) - step, -step
    )

    # Allocated once and refilled at every threshold. `labels, _ = ndimage.label(dem >= t)`
    # allocated both afresh each time and held the previous labels until the call returned,
    # which is what put the peak at ~13.5 bytes a pixel (1.94 GB on Scotland's 143 Mpx,
    # 2026-09-23); reusing them holds it to the DEM plus one mask plus one label array.
    # Identical labels either way — checked against the allocating call on a test array.
    mask = np.empty(dem.shape, dtype=bool)
    labels = np.empty(dem.shape, dtype=np.int32)

    for t in thresholds:
        if len(resolved) >= len(located) - 1:
            break  # only the summit of the box left; it has no key col by definition

        np.greater_equal(dem, t, out=mask)
        ndimage.label(mask, output=labels)
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


def run_regions(args, lons, lats, factor):
    """Score every region in the catalogue. Returns {feature_index: prominence_m}."""
    with open(args.regions) as f:
        regions = json.load(f)["regions"]

    # Smallest bbox first, so a larger region's pass overwrites a smaller overlapping one.
    # Lochaber and Cairngorms sit inside Scotland; prominence measured in the bigger box is
    # the better value, because a key col near the edge of a small box gets clipped to the
    # box and the peak's prominence is over-stated. Sorting makes that independent of the
    # order regions happen to appear in regions.json — and sorted() is stable, so equal
    # areas keep regions.json order, as they did when build-peaks.sh did this sort.
    order = sorted(
        regions,
        key=lambda r: (r["bbox"][2] - r["bbox"][0]) * (r["bbox"][3] - r["bbox"][1]),
    )

    def fetch(region):
        # str() of the JSON values, byte for byte what build-peaks.sh used to pass — and
        # what fetch-dem.sh's cache key is built from.
        w, s, e, n = (str(v) for v in region["bbox"])
        dem = os.path.join(args.work_dir, f"dem-{region['id']}.tif")
        proc = subprocess.run(
            ["bash", args.fetch_dem, w, s, e, n, dem, args.res],
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout + proc.stderr, dem

    # Fetches run ahead of the scoring, a few at a time. The fetch is the slow half and it
    # is network-bound: three similar regions took 70 s at once against 146 s one after
    # another (2026-09-23), with identical DEMs — each fetch is deterministic on its own
    # (fetch-dem.sh). Scoring stays sequential and in `order`, so the overwrite rule above
    # holds however the fetches finish, and only one DEM is ever in memory.
    workers = max(1, args.fetch_workers)
    prom = {}
    no_dem = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {k: pool.submit(fetch, order[k]) for k in range(min(workers, len(order)))}
        for k, region in enumerate(order):
            code, log, dem_path = pending.pop(k).result()
            if k + workers < len(order):
                pending[k + workers] = pool.submit(fetch, order[k + workers])

            print(f"==> prominence: {region['id']}", flush=True)
            sys.stderr.write(log)
            sys.stderr.flush()
            if code != 0:
                print(
                    f"  ! no DEM for {region['id']} — its peaks keep no prominence",
                    file=sys.stderr, flush=True,
                )
                no_dem.append(region["id"])
                continue

            dem, gt = read_dem(dem_path, factor)
            os.remove(dem_path)
            scored, candidates = score_region(dem, gt, lons, lats, args.step, args.floor)
            shape = dem.shape
            del dem  # before the next region's is read
            prom.update(scored)
            report(scored, candidates, len(lons), shape, factor, args.step)

    # Said once at the end as well as per region: one line per region is easy to lose in a
    # log this long, and a region with no `prom` falls back to elevation in the app.
    if no_dem:
        print(
            f"prominence: {len(no_dem)} of {len(order)} regions had no DEM, so their peaks "
            f"keep no prominence: {' '.join(no_dem)}",
            file=sys.stderr, flush=True,
        )
    return prom


def main():
    ap = argparse.ArgumentParser(
        description="Topographic prominence for peaks, from Copernicus DEM clips.",
        epilog="With --regions: PEAKS_IN PEAKS_OUT, fetching every region's DEM. "
        "Without: DEM PEAKS_IN PEAKS_OUT, scoring one raster (spot checks).",
    )
    ap.add_argument("paths", nargs="+", metavar="PATH",
                    help="[DEM] PEAKS_IN PEAKS_OUT — line-delimited GeoJSON in and out")
    ap.add_argument("--regions", help="regions.json — score every region in it")
    ap.add_argument("--fetch-dem", help="fetch-dem.sh, with --regions")
    ap.add_argument("--res", help="DEM degrees per pixel for fetch-dem.sh, with --regions")
    ap.add_argument("--work-dir", help="where fetched DEMs land, with --regions")
    ap.add_argument("--fetch-workers", type=int, default=3,
                    help="DEM fetches in flight at once, with --regions (default 3)")
    ap.add_argument("--step", type=float, default=20.0, help="metres per level set")
    ap.add_argument("--floor", type=float, default=0.0, help="stop descending here")
    ap.add_argument("--downsample", type=int, default=3, help="block-max factor")
    args = ap.parse_args()

    if args.regions:
        if len(args.paths) != 2:
            ap.error("with --regions, give PEAKS_IN PEAKS_OUT")
        if not (args.fetch_dem and args.res and args.work_dir):
            ap.error("--regions needs --fetch-dem, --res and --work-dir")
        peaks_in, peaks_out = args.paths
    else:
        if len(args.paths) != 3:
            ap.error("give DEM PEAKS_IN PEAKS_OUT, or --regions with PEAKS_IN PEAKS_OUT")
        dem_path, peaks_in, peaks_out = args.paths

    factor = max(1, args.downsample)
    lons, lats = load_coords(peaks_in)

    if args.regions:
        prom = run_regions(args, lons, lats, factor)
    else:
        dem, gt = read_dem(dem_path, factor)
        prom, candidates = score_region(dem, gt, lons, lats, args.step, args.floor)
        report(prom, candidates, len(lons), dem.shape, factor, args.step)

    write_output(peaks_in, peaks_out, prom)


if __name__ == "__main__":
    sys.exit(main())
