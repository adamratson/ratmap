import json, shlex, sys
with open(sys.argv[1]) as f:
    regions = json.load(f)["regions"]
match = next((r for r in regions if r["id"] == sys.argv[2]), None)
if match is None:
    sys.exit(f"Unknown region '{sys.argv[2]}'. Known: {', '.join(r['id'] for r in regions)}")
w, s, e, n = match["bbox"]
print(f"REGION_NAME={shlex.quote(match['name'])}")
print(f"WEST={w}"); print(f"SOUTH={s}"); print(f"EAST={e}"); print(f"NORTH={n}")