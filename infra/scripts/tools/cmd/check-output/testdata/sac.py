import json, sys

EXPECTED_HARDEST = {
    "Ben Nevis Mountain Path": 2,   # Scotland — mountain_hiking, in places T1
    "West Highland Way": 1,         # Scotland — the flat end of the scale
    "Aonach Eagach": 5,             # Scotland — demanding_alpine_hiking
}

hardest = {}
histogram = {}
with open(sys.argv[1]) as f:
    for line in f:
        props = json.loads(line)["properties"]
        grade = props["t"]
        histogram[grade] = histogram.get(grade, 0) + 1
        name = props.get("name")
        if isinstance(name, str) and name in EXPECTED_HARDEST:
            hardest[name] = max(hardest.get(name, 0), grade)

checked = 0
for name, expected in EXPECTED_HARDEST.items():
    actual = hardest.get(name)
    if actual is None:
        print(f"  (skip {name}: not in this extract)")
        continue
    if actual != expected:
        sys.exit(f"FAIL: {name} hardest grade {actual}, expected {expected}")
    print(f"  OK {name}: T{expected}")
    checked += 1

# The named checks only fire for extracts containing those paths. This one always fires:
# a build whose output is a single grade means the parser has collapsed the scale, which
# is exactly the failure that would otherwise ship as a uniformly-coloured map.
present = sorted(histogram)
print(f"  grades present: {', '.join(f'T{g} x{histogram[g]}' for g in present)}")
if len(present) < 2:
    sys.exit("FAIL: fewer than two distinct grades in the whole build")
if checked == 0:
    print("  (no known paths in this extract — grade assertions skipped)")