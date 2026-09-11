#!/usr/bin/env python3
"""Normalize peak GeoJSON before tippecanoe.

OSM `ele` is free text and always arrives as a string: mostly "1345", but a small tail of
"~340", "1141m", "480~", "1,345", "664.4m". Cleaning it here rather than in a MapLibre
style expression means the tiles carry a real number, the renderer stays trivial, and a
bad value can never surface as "NaN m" at a summit — a wrong elevation on a mountain is
worse than a missing one.

Also derives `lists`, a semicolon-delimited summit-list membership string (docs/
IMPLEMENTATION.md Phase 3.5, C19 — never transcribe an editorial table; only join from a
CC0/ODbL source). Today that's just `munro`, straight off OSM's own `munro=yes` tag:
taginfo shows exactly 282 uses, matching the SMC's current published Munro count, so no
separate editorial join is needed. Wainwrights are deliberately not derived here — no OSM
tag exists for them and Wikidata carries no structured list membership either (verified
2026-09-11); the one dataset that has it (DoBIH) is CC BY, not CC0/ODbL, so there is no
compliant source yet.

Reads **line-delimited** GeoJSON on argv[1], writes line-delimited GeoJSON to argv[2] —
one feature per line, streamed, never the whole document at once. A planet-scale peaks
export is ~1.2 M features and `json.load` of that costs ~1.4 GB of Python objects
(measured: ~1.16 kB per feature, 5x the JSON text); streaming it is flat in memory
instead. Callers pass `osmium export -f geojsonseq -x print_record_separator=false`.
Same reasoning as build-contours.sh, which already exports GeoJSONSeq so tippecanoe can
stream — tippecanoe reads line-delimited input natively.
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


def derive_lists(props):
    """Semicolon-delimited list membership, or None. See module docstring for sourcing."""
    lists = []
    if props.get("munro") == "yes":
        lists.append("munro")
    return ";".join(lists) if lists else None


def main(src, dest):
    kept_ele = 0
    dropped_ele = 0
    munro_count = 0
    total = 0

    with open(src) as src_f, open(dest, "w") as dest_f:
        for line in src_f:
            # RFC8142 puts an RS (0x1e) before each record. Our callers turn that off
            # (`-x print_record_separator=false`), but stripping it anyway means the
            # script also works on a plain `osmium export -f geojsonseq` file.
            line = line.lstrip("\x1e").strip()
            if not line:
                continue

            feature = json.loads(line)
            total += 1

            props = feature.get("properties", {})
            if "ele" in props:
                parsed = parse_elevation(props["ele"])
                if parsed is None:
                    del props["ele"]
                    dropped_ele += 1
                else:
                    props["ele"] = parsed
                    kept_ele += 1

            lists = derive_lists(props)
            if lists:
                props["lists"] = lists
                if "munro" in lists.split(";"):
                    munro_count += 1

            dest_f.write(json.dumps(feature))
            dest_f.write("\n")

    print(
        f"normalize-peaks: {total} features, {kept_ele} with usable ele, "
        f"{dropped_ele} unparseable ele dropped, {munro_count} munros"
    )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
