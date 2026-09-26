#!/usr/bin/env bash
# Regenerates *.want.stdout / *.want.stderr from the Python (run from this directory).
for f in real mixed three empty; do
  python3 region-osm-sources.py "$f.json" > "$f.want.stdout" 2> "$f.want.stderr"
done
