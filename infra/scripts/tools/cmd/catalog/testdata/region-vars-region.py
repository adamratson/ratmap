import json, shlex, sys
with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
match = next((r for r in regions if r["id"] == sys.argv[2]), None)
if match is None:
    sys.exit(f"Unknown region '{sys.argv[2]}'. Known: {', '.join(r['id'] for r in regions)}")
west, south, east, north = match["bbox"]
if not (west < east and south < north):
    sys.exit(
        f"Region '{match['id']}' has an invalid bbox {match['bbox']} "
        f"(need west<east, south<north). Fix regions.json before building."
    )
print(f"REGION_NAME={shlex.quote(match['name'])}")
# Opt-out, not opt-in: every region gets terrain unless it says otherwise.
print(f"WANT_TERRAIN={'0' if match.get('terrain') is False else '1'}")
print(f"BBOX={shlex.quote(','.join(str(c) for c in match['bbox']))}")
# Empty unless the catalogue caps this region below the defaults below.
print(f"REGION_BASEMAP_Z={match.get('basemapMaxzoom', '')}")
print(f"REGION_TERRAIN_Z={match.get('terrainMaxzoom', '')}")