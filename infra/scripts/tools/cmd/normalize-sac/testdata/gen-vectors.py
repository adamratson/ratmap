#!/usr/bin/env python3
"""Regenerates the golden files main_test.go checks cmd/normalize-sac against, from the
Python it replaced (normalize-sac.py beside this file):

    python3 testdata/gen-vectors.py

  grades.tsv    a JSON sac_scale value, parse_grade's answer (or None), and
                repr(str(value)) as the report would print it. Hand-picked values, the
                ones taginfo lists, then random mixtures of every token and separator the
                parser treats specially. Seeded.
  edge.want.*   normalize-sac.py's stdout and output for edge.geojsonl.
"""
import importlib.util
import json
import os
import random
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ns", os.path.join(here, "normalize-sac.py"))
ns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ns)

random.seed(20260926)
fixed = [
    "hiking", "mountain_hiking", "demanding_mountain_hiking", "alpine_hiking",
    "demanding_alpine_hiking", "difficult_alpine_hiking", "T3", "t3", "3", " T2 ", "T2+",
    "T2-T3", "T1 - T2", "hiking;mountain_hiking", "mountain_hiking - demanding_mountain_hiking",
    "alpine_hiking (T4)", "strolling", "yes", "?", "", "T7", "0", "demanding_mountain_hiking]",
    "Mountain Hiking", "MOUNTAIN_HIKING", "T2 to T3", "t2 or t3", "T2/T3", "T2|T3", "T2,T3",
    "T2–T3", "T2—T3", "T2 -T3", "T2- T3", "T2  -  T3", "T2\t-\tT3", "T2 - T3",
    "hİking", "hiKing", "Kiking", "t 3", "T3\n", "3+\n", "T3++", "T 3 +", "(T3)", "[T4]",
    "__T2__", "alpine_hiking_(t4)", "demanding_alpine_hiking/difficult_alpine_hiking",
    "hikingtoalpine_hiking", "étoé", "t2éorét3", "T2 ou T3", "T١", "٣", "T2 – T3", "T3 T4",
    "it's", 'a"b', "it's \"q\"", "tab\there", "nl\nx", "\x00\x1f\x7f", "​", " ",
    "é", "\U0001F600", "퟿", "",
    # Rules no random mixture reliably reaches: $ before a final newline (only reachable
    # when a bracket or underscore follows it, since parts are stripped), the \x1c-\x1f
    # separators Python counts as whitespace, embedded names that contain other names,
    # and the dotted capital I that Python lowers to two characters.
    "3+\n)", "T2+\n_", "(t4-\n)", "T2\x1c-\x1cT3", "\x1fT3\x1c", "T\x1d3",
    "mountain_hiking_difficult_alpine_hiking", "xdemanding_mountain_hikingx",
    "alpine_hiking_demanding_alpine_hiking", "hiking_mountain_hiking",
    chr(0x130), "h" + chr(0x130) + "king", "H" + chr(0x130) + "K" + chr(0x130) + "NG",
]
tokens = ["hiking", "mountain", "demanding", "alpine", "difficult", "_", " ", "t", "T", "1",
          "3", "6", "7", "0", "+", "-", "–", "—", ";", ",", "/", "|", "to", "or", "(", ")",
          "[", "]", "\t", " ", "é", "İ", "K", "٣", "yes", "?", "\n"]
values = [json.dumps(v, ensure_ascii=False) for v in fixed]
values += ["4", "2.5", "6.99", "7", "0.5", "-1", "1e0", "6e0", "true", "false", "null",
           '["T3"]', '{"a": 1, "a": 2, "b": [1, "x"]}', "123456789012345678901234567890",
           "-0", "1e-7", "3.0"]
for _ in range(6000):
    values.append(json.dumps("".join(random.choice(tokens) for _ in range(random.randint(1, 9))),
                             ensure_ascii=False))
with open(os.path.join(here, "grades.tsv"), "w") as out:
    for v in values:
        value = json.loads(v)
        if value is None:
            continue  # "untagged" before parse_grade is ever asked
        g = ns.parse_grade(value)
        out.write("%s\t%s\t%s\n" % (v, "None" if g is None else g, json.dumps(repr(str(value)))))

with open(os.path.join(here, "edge.want.stdout"), "w") as so:
    subprocess.run([sys.executable, os.path.join(here, "normalize-sac.py"),
                    os.path.join(here, "edge.geojsonl"), os.path.join(here, "edge.want.geojsonl")],
                   check=True, stdout=so)
