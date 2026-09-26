#!/usr/bin/env python3
"""Regenerates the golden files main_test.go checks cmd/build-places-db against:

    python3 testdata/build-places-db.py testdata/edge.geojsonl testdata/edge.geojsonl \
        /tmp/edge.sqlite > testdata/edge.want.stdout
    python3 testdata/dump-rows.py /tmp/edge.sqlite > testdata/edge.want.rows

(edge.geojsonl twice on purpose: the second pass is all duplicates.) One JSON array per
row of `places`, in id order: each value with its SQLite storage type, and every REAL as
the hex of its IEEE 754 bits, so the comparison is exact.
"""
import json
import sqlite3
import struct
import sys

db = sqlite3.connect(sys.argv[1])
cols = ["id", "name", "kind", "lat", "lon", "ele", "population", "rank"]
select = ", ".join(f"{c}, typeof({c})" for c in cols)
for row in db.execute(f"SELECT {select} FROM places ORDER BY id"):
    out = []
    for value, kind in zip(row[::2], row[1::2]):
        if kind == "real":
            value = struct.pack(">d", value).hex()
        out.append([kind, value])
    print(json.dumps(out, ensure_ascii=False))
