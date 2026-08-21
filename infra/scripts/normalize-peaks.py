#!/usr/bin/env python3
"""Normalize peak GeoJSON before tippecanoe.

OSM `ele` is free text and always arrives as a string: mostly "1345", but a small tail of
"~340", "1141m", "480~", "1,345", "664.4m". Cleaning it here rather than in a MapLibre
style expression means the tiles carry a real number, the renderer stays trivial, and a
bad value can never surface as "NaN m" at a summit — a wrong elevation on a mountain is
worse than a missing one.

Reads GeoJSON on argv[1], writes normalized GeoJSON to argv[2].
"""
import json
import re
import sys

# Everest 8849 m; Dead Sea shore about -430 m. Outside this is a tagging error (feet
# entered as metres, stray digits), so drop the value rather than render it.
MIN_ELE_M = -500
MAX_ELE_M = 9000

LEADING_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def parse_elevation(raw):
    if isinstance(raw, (int, float)):
        value = float(raw)
    elif isinstance(raw, str):
        match = LEADING_NUMBER.search(raw.replace(",", ""))
        if not match:
            return None
        value = float(match.group(0))
    else:
        return None

    if value != value or value in (float("inf"), float("-inf")):
        return None
    if not (MIN_ELE_M <= value <= MAX_ELE_M):
        return None
    return round(value, 1)


def main(src, dest):
    with open(src) as f:
        data = json.load(f)

    kept_ele = 0
    dropped_ele = 0
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        if "ele" not in props:
            continue
        parsed = parse_elevation(props["ele"])
        if parsed is None:
            del props["ele"]
            dropped_ele += 1
        else:
            props["ele"] = parsed
            kept_ele += 1

    with open(dest, "w") as f:
        json.dump(data, f)

    total = len(data.get("features", []))
    print(
        f"normalize-peaks: {total} features, {kept_ele} with usable ele, "
        f"{dropped_ele} unparseable ele dropped"
    )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
