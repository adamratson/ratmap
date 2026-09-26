
import json, re, sys
flag = sys.argv[2] if len(sys.argv) > 2 else None
pattern = re.compile(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
with open(sys.argv[1]) as f:
    for r in json.load(f)["regions"]:
        if flag and not r.get(flag):
            continue
        if pattern and not pattern.search(r["id"]):
            continue
        # `id<space>wants-terrain`, so the skip check knows which artifacts to expect.
        print(r["id"], 0 if r.get("terrain") is False else 1)