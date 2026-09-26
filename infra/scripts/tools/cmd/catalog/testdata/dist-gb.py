
import json, pathlib, sys
dist = pathlib.Path(sys.argv[2]) / "regions"
total = 0
with open(sys.argv[1]) as f:
    for r in json.load(f)["regions"]:
        rid = r["id"]
        if (dist / rid / (rid + "-basemap.pmtiles")).exists():
            continue
        total += r.get("estimatedBytes", 0)
# 10% headroom: the estimates are two significant figures, and contours are not in them.
print(int(total * 1.1 / 1e9))