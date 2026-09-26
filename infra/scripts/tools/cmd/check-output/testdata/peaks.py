import json, sys

# Each value read out of a real build's output before being asserted here, not taken from
# a guidebook — OSM's `ele` is what the pipeline must preserve, and it does not always
# match the published height. Zla Kolata is tagged 2535 (commonly cited as 2534), and its
# OSM name carries the Albanian form too, so it is matched on prefix.
EXPECTED = {
    "Ben Nevis": 1345,       # Scotland — highest in the UK
    "Mont Blanc": 4808,      # only present in an Alpine build
    "Bobotov Kuk": 2523,     # Montenegro — Durmitor
    "Zla Kolata": 2535,      # Montenegro — highest point
}
TOLERANCE_M = 2

# Streamed for the same reason normalize-peaks is: this only ever needs the handful of
# named summits in EXPECTED, so there is no reason to materialise a planet's worth of
# features to find them.
by_name = {}
with open(sys.argv[1]) as f:
    for line in f:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        props = json.loads(line).get("properties", {})
        name, ele = props.get("name"), props.get("ele")
        if not isinstance(name, str) or not isinstance(ele, (int, float)):
            continue
        # Prefix, not equality: OSM often carries a multilingual name for a summit —
        # Zla Kolata is tagged "Zla Kolata / Kollate e Keqe". Exact matching would skip it
        # silently and the assertion would quietly stop testing anything.
        for expected_name in EXPECTED:
            if name.startswith(expected_name):
                by_name.setdefault(expected_name, ele)

checked = 0
for name, expected in EXPECTED.items():
    actual = by_name.get(name)
    if actual is None:
        print(f"  (skip {name}: not in this extract)")
        continue
    if abs(actual - expected) > TOLERANCE_M:
        sys.exit(f"FAIL: {name} ele={actual}, expected ~{expected}")
    print(f"  OK {name}: {actual} m")
    checked += 1

if checked == 0:
    print("  (no known summits in this extract — elevation assertions skipped)")