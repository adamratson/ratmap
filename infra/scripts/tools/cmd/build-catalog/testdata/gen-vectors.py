#!/usr/bin/env python3
"""Regenerates vectors.json, which main_test.go checks cmd/build-catalog's building
blocks against, from the Python it replaced (build-catalog.py beside this file):

    python3 testdata/gen-vectors.py GEOFABRIK_INDEX.json

  features.json  fifteen Geofabrik features with the awkward shapes: antimeridian
                 crossings (Fiji, Kiribati, Alaska, New Zealand, Tonga), far-flung parts
                 (American Oceania, Norway, France, Chile), a circumpolar ring (Antarctica)
  vectors.json   region_boxes for each; clean_name, safe_id, cell_label, compass_label and
                 parse_size on real and made-up inputs. Seeded.
"""
import importlib.util
import json
import os
import random
import sys

sys.dont_write_bytecode = True

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bc", os.path.join(here, "build-catalog.py"))
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
random.seed(20260926)

ids = ['fiji', 'kiribati', 'antarctica', 'us/alaska', 'new-zealand', 'norway', 'monaco',
       'american-oceania', 'us/hawaii', 'chile', 'france', 'spain', 'netherlands', 'tonga', 'samoa']
index = json.load(open(sys.argv[1]))
feats = {f['properties']['id']: f for f in index['features']}
chosen = [feats[i] for i in ids]
json.dump(chosen, open(os.path.join(here, "features.json"), "w"), ensure_ascii=False)

out = {"region_boxes": {}, "clean_name": [], "safe_id": [], "cell_label": [], "compass_label": [],
       "parse_size": []}
for f in chosen:
    out["region_boxes"][f['properties']['id']] = [list(b) for b in bc.region_boxes(f)]
names = [f['properties'] for f in index['features']] + [
    {"id": "x", "name": "Line<br>break"}, {"id": "x", "name": "Line<br />two  spaces nbsp"},
    {"id": "us/new-york", "name": "us/new-york"}, {"id": "a-b", "name": "a-b"},
    {"id": "x", "name": "  o'neil-3d / ÉCOLE  "}, {"id": "x", "name": "<br/>"}]
for p in names:
    out["clean_name"].append([p, bc.clean_name(p)])
for s in [f['properties']['id'] for f in index['features']] + ["US/New York", "--a__b--", "Ünïcödé", "İstanbul", "a/b/c"]:
    out["safe_id"].append([s, bc.safe_id(s)])
for _ in range(400):
    w = random.uniform(-180, 179); s = random.uniform(-90, 89)
    b = (w, s, min(180, w + random.choice([0.5, 1, 2.5, 7.25, 45])), min(90, s + random.choice([0.5, 1, 2.5, 7.25, 45])))
    out["cell_label"].append([b, list(bc.cell_label(b))])
    p = (random.uniform(-180, 170), random.uniform(-90, 80), 0, 0)
    p = (p[0], p[1], p[0] + 5, p[1] + 5)
    out["compass_label"].append([b, p, list(bc.compass_label(b, p))])
for b in [(-0.5, -0.5, 0.5, 0.5), (0.25, 0.5, 0.75, 1.5), (-2.5, 1.5, -1.5, 3.5)]:
    out["cell_label"].append([b, list(bc.cell_label(b))])
out["compass_label"].append([(0, 0, 1, 1), (0, 0, 1, 1), list(bc.compass_label((0, 0, 1, 1), (0, 0, 1, 1)))])
for text in ["... archive size of 12.5 MB", "archive size of 3 GB\n", "archive size of 999 B", "archive size of 1.25 kB",
             "archive size of 0.5 TB", "nothing here", "archive size of 12 MBps", "archive size of 7\tGB"]:
    out["parse_size"].append([text, bc.parse_size(text)])
json.dump(out, open(os.path.join(here, "vectors.json"), "w"), ensure_ascii=False)
print({k: len(v) for k, v in out.items()})
