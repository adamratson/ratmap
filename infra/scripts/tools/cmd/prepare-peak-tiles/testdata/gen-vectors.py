#!/usr/bin/env python3
"""Regenerates the golden files main_test.go checks cmd/prepare-peak-tiles against, from
the Python it replaced (prepare-peak-tiles.py beside this file):

    python3 testdata/gen-vectors.py

  untie.tsv    lon, lat (as JSON), world_xy and untie's answer. Coordinates aimed at a
               rounding tie on each axis at every zoom 0-14 — the world position of the
               tie turned back into degrees at OSM's 7 decimals, some of which land on it
               exactly — plus random ones. Seeded.
  edge.want.*  prepare-peak-tiles.py's stdout and output for edge.geojsonl.
"""
import importlib.util
import json
import math
import os
import random
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pp", os.path.join(here, "prepare-peak-tiles.py"))
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)

random.seed(20260926)
W = pp.WORLD

def lon_of(x):
    return round(x / W * 360 - 180, 7)

def lat_of(y):
    return round(math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / W)))), 7)

coords = [(101.2496567, 51.5), (101.2496567, 0.0), (0.0, 0.0), (-180.0, 0.0), (179.9999999, 85.05),
          (7, 46), (-5.0036, 56.7969)]
for z in pp.ZOOMS:
    tile = 1 << (32 - z)
    half = 1 << (32 - z - pp.DETAIL - 1)
    for _ in range(300):
        k = random.randint(1, (1 << z) - 1) if z > 0 else 1
        w = k * tile - half
        coords.append((lon_of(w), round(random.uniform(-85, 85), 7)))
        if 0 < w < W:
            lat = lat_of(w)
            if abs(lat) < 85.04:
                coords.append((round(random.uniform(-180, 180), 7), lat))
for _ in range(20000):
    coords.append((round(random.uniform(-180, 180), 7), round(random.uniform(-85.04, 85.04), 7)))

moved = 0
with open(os.path.join(here, "untie.tsv"), "w") as out:
    for lon, lat in coords:
        x, y = pp.world_xy(lon, lat)
        new = pp.untie(lon, lat)
        moved += new != (lon, lat)
        out.write("%s\t%s\t%d\t%d\t%r\t%r\n" % (json.dumps(lon), json.dumps(lat), x, y, new[0], new[1]))
print(f"{len(coords)} coordinates, {moved} moved off a tie")

with open(os.path.join(here, "edge.want.stdout"), "w") as so:
    subprocess.run([sys.executable, os.path.join(here, "prepare-peak-tiles.py"),
                    os.path.join(here, "edge.geojsonl"), os.path.join(here, "edge.want.geojsonl")],
                   check=True, stdout=so)
