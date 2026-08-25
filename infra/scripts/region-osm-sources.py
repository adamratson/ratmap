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

# Once the catalogue is global its regions point at continent extracts, and this union is
# Geofabrik's whole planet — 85 GB of source and days of processing. That is the correct
# input for a global peaks/places build and a very expensive accident on a laptop, so say
# which it is going to be before the first byte moves.
if len(seen) > 2:
    print(
        f"! {len(seen)} source extracts — this is a continental or planet-scale build.\n"
        f"  Expect tens of GB of downloads and hours to days of processing.\n"
        f"  Override with PEAKS_SOURCE_URLS / PLACES_SOURCE_URLS for a smaller run.",
        file=sys.stderr,
    )

print("\n".join(seen))
