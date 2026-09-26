#!/usr/bin/env python3
"""Regenerates the golden files main_test.go checks cmd/normalize-peaks against, from the
Python it replaced (normalize-peaks.py beside this file):

    python3 testdata/gen-vectors.py

  ele.tsv      a JSON `ele` value and repr(parse_elevation(value)). Hand-picked values,
               the tail the docstring names, then random mixtures of digits (ASCII and
               not), signs, points, commas, units and junk. Seeded.
  edge.want.*  normalize-peaks.py's stdout and output for edge.geojsonl.
"""
import importlib.util
import json
import os
import random
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("np", os.path.join(here, "normalize-peaks.py"))
np_ = importlib.util.module_from_spec(spec)
spec.loader.exec_module(np_)

random.seed(20260926)
fixed = ["1345", "~340", "1141m", "480~", "1,345", "664.4m", "1345.05", "1345.15", "1345.25",
         "-430", "-500", "-500.04", "-500.06", "9000", "9000.04", "9000.05", "9000.06", "9001", "-",
         "--5", "5-", "a-5", "1.2.3", "1.", ".5", "-.5", "1,2,3", "12,5", "approx 1 200 m",
         "١٣٤٥", "۱۳۴۵", "१२३४", "１２３４", "𝟙𝟚𝟛𝟜", "1٣4", "٣.٥", "nan", "inf", "1e3", "",
         " ", "ca. 2500", "2500-2600", "−250", "9" * 400, "0", "-0", "-0.0", "0.04", "-0.04",
         "12 345", "​1234"]
values = [json.dumps(v, ensure_ascii=False) for v in fixed]
values += ["1345", "1345.0", "1345.05", "-500", "9000.0", "9000.06", "true", "false", "null",
           '["1345"]', '{"v": 1}', "1e3", "1e400", "-1e400", "-0", "0.25", "0.35"]
pool = "0123456789.,- m~~ab٣٤१𝟙１e+"
for _ in range(5000):
    values.append(json.dumps("".join(random.choice(pool) for _ in range(random.randint(0, 9))),
                             ensure_ascii=False))
for _ in range(1500):
    values.append(json.dumps(round(random.uniform(-600, 9100), random.randint(0, 4))))
with open(os.path.join(here, "ele.tsv"), "w") as out:
    for v in values:
        out.write("%s\t%s\n" % (v, repr(np_.parse_elevation(json.loads(v)))))

with open(os.path.join(here, "edge.want.stdout"), "w") as so:
    subprocess.run([sys.executable, os.path.join(here, "normalize-peaks.py"),
                    os.path.join(here, "edge.geojsonl"), os.path.join(here, "edge.want.geojsonl")],
                   check=True, stdout=so)
