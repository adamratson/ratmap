#!/usr/bin/env python3
"""Regenerates the fixtures main_test.go checks cmd/check-peak-tiles against, from the
Python it replaced (check-peak-tiles.py beside this file). Needs tippecanoe on PATH.

    python3 testdata/gen-fixtures.py SCOTLAND_PEAKS.geojsonl

  peaks.geojsonl, peaks.pmtiles  300 Scottish peaks (every Munro among the first taken)
                                 and the archive tippecanoe makes of them with
                                 build-peaks.sh's own flags
  decode.txt                     tippecanoe-decode of its top zoom
  case-*.args, case-*.want       for each case: source, decode file, and the Python's
                                 stdout and exit code
"""
import json
import math
import os
import random
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
random.seed(20260926)

feats = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
munros = [f for f in feats if "munro" in f["properties"].get("lists", "").split(";")][:40]
rest = [f for f in feats if f not in munros]
chosen = munros + random.sample(rest, 300 - len(munros))
with open(os.path.join(here, "peaks.geojsonl"), "w") as out:
    for f in chosen:
        out.write(json.dumps(f, ensure_ascii=False) + "\n")

archive = os.path.join(here, "peaks.pmtiles")
subprocess.run(["tippecanoe", "-q", "-o", archive, "-zg", "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping", "--include=name", "--include=ele",
                "--include=prom", "--include=prominence", "--include=wikidata", "--include=lists",
                "-l", "peaks", "-n", "ratmap peaks", "--force",
                os.path.join(here, "peaks.geojsonl")], check=True)
header = json.loads(subprocess.run(["pmtiles", "show", "--header-json", archive],
                                   check=True, capture_output=True, text=True).stdout)
z = header["maxzoom"]
decode = subprocess.run(["tippecanoe-decode", f"-z{z}", f"-Z{z}", archive],
                        check=True, capture_output=True, text=True).stdout
open(os.path.join(here, "decode.txt"), "w").write(decode)

# Missing peaks: the input has some the archive does not.
extra = [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-4.1, 57.3]},
     "properties": {"@id": 900001, "name": "Not in the archive", "lists": "munro"}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-4.2, 57.1]},
     "properties": {"@id": 900002}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [179.99999, 10.0]},
     "properties": {"name": "Antimeridian"}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [7, 46]},
     "properties": {"@id": 900003, "name": None}},
    # Not a Munro: "munro" has to be a whole entry of the list.
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-4.3, 57.2]},
     "properties": {"@id": 900004, "name": "Munro top", "lists": "munro_top"}},
    # A second copy of a peak the archive holds once: one match between them, not two.
    chosen[0],
]
with open(os.path.join(here, "peaks-missing.geojsonl"), "w") as out:
    for f in chosen + extra:
        out.write(json.dumps(f, ensure_ascii=False) + "\n")
with open(os.path.join(here, "peaks-many-missing.geojsonl"), "w") as out:
    for f in chosen:
        out.write(json.dumps(f, ensure_ascii=False) + "\n")
    for i in range(60):
        out.write(json.dumps({"type": "Feature", "geometry": {"type": "Point", "coordinates":
              [round(-6 + i * 0.01, 6), 56.0]}, "properties": {"@id": 910000 + i}}) + "\n")

# A decoded coordinate moved onto a half pixel: which pixel holds it cannot be told.
lines = decode.split("\n")
tile = None
for i, line in enumerate(lines):
    if '"zoom":' in line and '"FeatureCollection"' in line:
        p = json.loads(line[line.index('{ "type"'):].split(', "features"')[0] + "}")
        tile = (p["properties"]["x"], p["properties"]["y"])
    text = line.strip().rstrip(",")
    if tile and text.startswith('{ "type": "Feature"'):
        f = json.loads(text)
        n = 2 ** z
        lon = ((tile[0] + 1000.5 / 4096) / n) * 360 - 180
        f["geometry"]["coordinates"][0] = round(lon, 6)
        lines[i] = line.replace(text, json.dumps(f, ensure_ascii=False).replace("{", "{ ", 1))
        break
open(os.path.join(here, "decode-unclear.txt"), "w").write("\n".join(lines))

# A decoded coordinate moved exactly onto its tile's bottom edge: pixel 4096 of 4096,
# drawn by no tile, so not counted.
lines = decode.split("\n")
tile = None
for i, line in enumerate(lines):
    if '"zoom":' in line and '"FeatureCollection"' in line:
        p = json.loads(line[line.index('{ "type"'):].split(', "features"')[0] + "}")
        tile = (p["properties"]["x"], p["properties"]["y"])
    text = line.strip().rstrip(",")
    if tile and text.startswith('{ "type": "Feature"'):
        f = json.loads(text)
        n = 2 ** z
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (tile[1] + 1) / n))))
        f["geometry"]["coordinates"][1] = round(lat, 6)
        lines[i] = line.replace(text, json.dumps(f, ensure_ascii=False).replace("{", "{ ", 1))
        break
open(os.path.join(here, "decode-edge.txt"), "w").write("\n".join(lines))

cases = {
    "ok": ("peaks.geojsonl", "decode.txt"),
    "missing": ("peaks-missing.geojsonl", "decode.txt"),
    "many-missing": ("peaks-many-missing.geojsonl", "decode.txt"),
    "unclear": ("peaks.geojsonl", "decode-unclear.txt"),
    "edge": ("peaks.geojsonl", "decode-edge.txt"),
}
for name, (src, dec) in cases.items():
    r = subprocess.run([sys.executable, os.path.join(here, "check-peak-tiles.py"),
                        os.path.join(here, src), archive, str(z)],
                       stdin=open(os.path.join(here, dec)), capture_output=True, text=True, cwd=here)
    open(os.path.join(here, f"case-{name}.args"), "w").write(f"{src}\n{dec}\n{z}\n")
    open(os.path.join(here, f"case-{name}.want"), "w").write(f"exit {r.returncode}\n{r.stdout}")
    print(name, "exit", r.returncode, "|", r.stdout.splitlines()[0] if r.stdout else r.stderr[-300:])
