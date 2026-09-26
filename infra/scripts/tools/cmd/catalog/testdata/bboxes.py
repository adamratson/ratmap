
import json, sys
with open(sys.argv[1]) as f:
    bbox = {r["id"]: r["bbox"] for r in json.load(f)["regions"]}
for rid in sys.argv[2:]:
    print(rid, *bbox[rid])