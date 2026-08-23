#!/usr/bin/env python3
"""Print the deduplicated OSM extracts covering every defined region, one per line.

peaks-global.pmtiles and places.sqlite are single global artifacts, but they have to cover
whatever regions the catalogue publishes. Deriving their inputs from regions.json instead
of a hardcoded default means adding a region can't silently ship a map with no summits and
no search results — which is exactly what happened when Montenegro was added while both
artifacts were still Scotland-only.
"""
import json
import pathlib
import sys

regions_json = pathlib.Path(__file__).resolve().parent.parent / "regions.json"

with open(regions_json) as f:
    regions = json.load(f)["regions"]

seen = []
for region in regions:
    url = region.get("osmExtract")
    if not url:
        print(f"! {region['id']} has no osmExtract — its peaks/search will be missing",
              file=sys.stderr)
        continue
    if url not in seen:
        seen.append(url)

print("\n".join(seen))
