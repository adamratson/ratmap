#!/usr/bin/env python3
"""Normalize OSM `sac_scale` into an integer grade 1-6 before tippecanoe.

`sac_scale` is a documented enum and is still free text in practice: taginfo lists 184
distinct values behind the seven official ones (2026-09-06), including "T3", "3",
"T2-T3", "mountain_hiking;demanding_mountain_hiking", "yes" and "?". Cleaning that here
rather than in a MapLibre style expression means the tiles carry a plain number, the
renderer and the route sampler both read one property, and an unparseable value can never
surface on the map as a grade that does not exist. Same division of labour as
normalize-peaks.py.

Two rules decide the ambiguous cases, and both round the same way — *never* report ground
as easier than it was tagged:

  * A range ("T2-T3", "hiking;mountain_hiking") takes the **harder** end.
  * A modifier ("T2+") takes its base grade, because the modifier is not part of the
    scale and inventing T2.5 would be a number the SAC never defined.

`strolling` is dropped rather than mapped to T1: it is not a SAC grade — the scale starts
at T1 — and a path tagged as a stroll is better shown as ungraded than as the easiest
graded thing on the hill.

Reads line-delimited GeoJSON on argv[1], writes line-delimited GeoJSON to argv[2],
streaming — a planet-scale `sac_scale` export is ~920 k features. Features with no usable
grade are dropped entirely: this artifact exists only to say what the grade is.

The three reasons a feature is dropped are counted separately, because they mean very
different things. "Not a line" is expected — `osmium tags-filter w/sac_scale` carries the
ways' own tagged nodes along with them (gates, cairns), and in Montenegro that is 250 of
1 212 exported features. "No sac_scale" likewise. An *unreadable value*, though, is a way
someone graded and we failed to read, so those are the ones printed with their values.

Run with --self-test to check the parser against the values it was written for.
"""
import json
import re
import sys

# The official scale. Order matters below: longest name first, so "mountain_hiking" is not
# matched by the "hiking" rule inside "demanding_mountain_hiking".
NAMED_GRADES = {
    "hiking": 1,
    "mountain_hiking": 2,
    "demanding_mountain_hiking": 3,
    "alpine_hiking": 4,
    "demanding_alpine_hiking": 5,
    "difficult_alpine_hiking": 6,
}

BY_LENGTH = sorted(NAMED_GRADES, key=len, reverse=True)

# "T3", "t3", "3", "T3+", "T3 " — the shorthand people write on the ground.
SHORTHAND = re.compile(r"^t?\s*([1-6])\s*[+-]?$")

# Anything that separates two grades from each other: a list, a range, a slash.
SEPARATORS = re.compile(r"[;,/|]|\s+-\s+|-|–|—|\bto\b|\bor\b")


def parse_grade(raw):
    """The grade a `sac_scale` value means, or None if it means nothing we can use."""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        value = int(raw)
        return value if 1 <= value <= 6 else None
    if not isinstance(raw, str):
        return None

    text = raw.strip().lower().replace(" ", "_")
    if text in NAMED_GRADES:
        return NAMED_GRADES[text]

    grades = []
    for part in SEPARATORS.split(text):
        part = part.strip().strip("()[]").strip("_")
        if not part:
            continue
        if part in NAMED_GRADES:
            grades.append(NAMED_GRADES[part])
            continue
        match = SHORTHAND.match(part.replace("_", ""))
        if match:
            grades.append(int(match.group(1)))
            continue
        # Last resort: an official name embedded in something longer, e.g.
        # "alpine_hiking_(t4)". Longest first so the more specific name wins.
        for name in BY_LENGTH:
            if name in part:
                grades.append(NAMED_GRADES[name])
                break

    # Harder end of a range, per the module docstring.
    return max(grades) if grades else None


LINE_GEOMETRIES = ("LineString", "MultiLineString")


def main(src, dest):
    kept = 0
    not_a_line = 0
    untagged = 0
    duplicated = 0
    unparsed = {}
    # OSM way ids already written. The input is the concatenation of one export per
    # continent extract, and Geofabrik's continents share the ways that cross their
    # seams — pinned a day apart, the same way can arrive twice with two different
    # versions. Keeping the first is right: they differ by an edit made between two
    # snapshots, not by being different paths. ~921 k graded ways worldwide, so this set
    # costs tens of MB; build-paths.sh works at 85 M and cannot do the same.
    seen = set()

    with open(src) as src_f, open(dest, "w") as dest_f:
        for line in src_f:
            # RFC8142 puts an RS (0x1e) before each record; our callers turn it off, but
            # stripping it anyway means this also works on a plain geojsonseq export.
            line = line.lstrip("\x1e").strip()
            if not line:
                continue

            feature = json.loads(line)
            props = feature.get("properties", {})

            # The scale describes a stretch of path. A node tagged with it is either a
            # tagging error or, far more often, just a gate that happened to be on a
            # graded way and came through the filter with it.
            if feature.get("geometry", {}).get("type") not in LINE_GEOMETRIES:
                not_a_line += 1
                continue

            raw = props.get("sac_scale")
            if raw is None:
                untagged += 1
                continue

            # `@id`, not `id`: that is the key `osmium export -a id` writes (verified
            # against a real export, 2026-09-08 — reading `id` silently deduplicated
            # nothing at all). Absent when the caller did not pass the flag, in which
            # case deduplication is skipped rather than half-applied.
            osm_id = props.get("@id")
            if osm_id is not None:
                if osm_id in seen:
                    duplicated += 1
                    continue
                seen.add(osm_id)

            grade = parse_grade(raw)
            if grade is None:
                unparsed[str(raw)] = unparsed.get(str(raw), 0) + 1
                continue

            # `t` and `name` only. Every byte of this artifact is downloaded onto a phone
            # over whatever signal a glen has, and nothing else here is read by the app.
            feature["properties"] = {"t": grade}
            if isinstance(props.get("name"), str):
                feature["properties"]["name"] = props["name"]

            dest_f.write(json.dumps(feature) + "\n")
            kept += 1

    unreadable = sum(unparsed.values())
    print(
        f"  graded {kept} ways; skipped {not_a_line} non-line features, "
        f"{untagged} untagged, {unreadable} unreadable, "
        f"{duplicated} already seen (continent seams)"
    )
    if unparsed:
        # Printed, not silent: a value climbing this list is how we find out the tag's
        # usage has drifted, rather than noticing a thinning map two years later.
        top = sorted(unparsed.items(), key=lambda kv: -kv[1])[:8]
        print("  unreadable values: " + ", ".join(f"{v!r} x{n}" for v, n in top))


def self_test():
    cases = {
        "hiking": 1,
        "mountain_hiking": 2,
        "demanding_mountain_hiking": 3,
        "alpine_hiking": 4,
        "demanding_alpine_hiking": 5,
        "difficult_alpine_hiking": 6,
        "T3": 3,
        "t3": 3,
        "3": 3,
        " T2 ": 2,
        "T2+": 2,
        # Ranges and lists take the harder end.
        "T2-T3": 3,
        "T1 - T2": 2,
        "hiking;mountain_hiking": 2,
        "mountain_hiking - demanding_mountain_hiking": 3,
        "alpine_hiking (T4)": 4,
        # Not a SAC grade, and not T1.
        "strolling": None,
        "yes": None,
        "?": None,
        "": None,
        "T7": None,
        "0": None,
        None: None,
        True: None,
        4: 4,
    }
    failures = [
        f"{value!r} -> {parse_grade(value)!r}, expected {expected!r}"
        for value, expected in cases.items()
        if parse_grade(value) != expected
    ]
    if failures:
        sys.exit("normalize-sac self-test FAILED:\n  " + "\n  ".join(failures))
    print(f"  normalize-sac self-test OK ({len(cases)} values)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]:
        self_test()
    else:
        main(sys.argv[1], sys.argv[2])
