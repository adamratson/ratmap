import json, sys

MIN_EXPECTED = {"scree": 20, "shingle": 5, "rock": 5, "stone": 5}

histogram = {}
with open(sys.argv[1]) as f:
    for line in f:
        kind = json.loads(line)["properties"]["kind"]
        histogram[kind] = histogram.get(kind, 0) + 1

print("  by kind: " + ", ".join(f"{k} x{histogram.get(k, 0)}" for k in sorted(MIN_EXPECTED)))

missing = [k for k, minimum in MIN_EXPECTED.items() if histogram.get(k, 0) < minimum]
if missing:
    sys.exit(
        "FAIL: implausibly few features for "
        + ", ".join(f"{k} ({histogram.get(k, 0)} < {MIN_EXPECTED[k]})" for k in missing)
        + " — filter or normalize step likely broken"
    )
if len(histogram) < 2:
    sys.exit("FAIL: fewer than two distinct kinds in the whole build")