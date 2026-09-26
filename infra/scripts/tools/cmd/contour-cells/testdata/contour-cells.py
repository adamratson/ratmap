import json, math, subprocess, sys

info = json.loads(subprocess.run(["gdalinfo", "-json", sys.argv[1]],
                                 check=True, capture_output=True, text=True).stdout)
width, height = info["size"]
gt = info["geoTransform"]
if gt[2] != 0 or gt[4] != 0:
    sys.exit("build-contours.sh: rotated DEM geotransform, cells assume north-up")
cell = int(sys.argv[2])

def seams(size):
    # Even cells, so none is a sliver: n cells, seams at pixel indices between them.
    n = max(1, math.ceil(size / cell))
    return [round(k * size / n) for k in range(1, n)]

def spans(size, cuts):
    # (first pixel, last pixel, low bound, high bound), bounds in pixel-centre coordinates
    # (pixel i's centre is i + 0.5), None for the region's own edge.
    edges = [None] + cuts + [None]
    for lo, hi in zip(edges, edges[1:]):
        first = 0 if lo is None else lo - 1
        last = size - 1 if hi is None else hi + 1
        yield first, last, (None if lo is None else lo + 0.5), (None if hi is None else hi + 0.5)

n = 0
for r0, r1, top, bottom in spans(height, seams(height)):
    for c0, c1, left, right in spans(width, seams(width)):
        n += 1
        x = lambda px: "-inf" if px is None else repr(gt[0] + px * gt[1])
        # Rows run south as y grows: gt[5] < 0, so the bottom seam is the smaller latitude.
        ymin = "-inf" if bottom is None else repr(gt[3] + bottom * gt[5])
        ymax = "inf" if top is None else repr(gt[3] + top * gt[5])
        xmax = "inf" if right is None else x(right)
        print(n, c0, r0, c1 - c0 + 1, r1 - r0 + 1, x(left), xmax, ymin, ymax)