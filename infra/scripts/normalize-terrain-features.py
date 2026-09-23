#!/usr/bin/env python3
"""Normalize OSM `natural=scree|shingle|rock|stone` before tippecanoe.

Unlike `sac_scale` (normalize-sac.py) these are clean enum values in practice — no free
text to parse. This script exists for three things that still need doing before
tippecanoe, not for parsing:

  * Rename `natural` to `kind` on the way out, so the tile property matches what
    src/overlays/terrain-features.ts and every other artifact's convention expect (`kind`, not the
    OSM key it came from — same choice build-sac.sh made with `t`).
  * Drop the `natural` values this artifact does not cover — and this is load-bearing,
    not just defence in depth. Filtering `scotland-latest.osm.pbf` to
    `nwr/natural=scree,shingle,rock,stone` and exporting it (2026-09-18) still yielded
    1,176 features tagged `coastline`, `heath`, `wood`, `grassland`, `bare_rock` and
    others alongside the 10,551 genuinely wanted ones. `osmium tags-filter`'s relation
    handling keeps every member of a matched multipolygon relation to make its geometry
    buildable, regardless of that member way's own tags — and OSM landcover polygons
    routinely share boundary ways with their neighbours, so a scree relation's own
    boundary can double as a heath relation's boundary elsewhere. `osmium export` then
    assembles an area for *every* recognized tag it finds, independently per object. The
    filter step narrows the input; this script is what actually enforces the four kinds.
  * Deduplicate by `(kind, @id)` across concatenated continent extracts — same seam
    problem `normalize-sac.py` documents, though far less likely to bite here: these are
    small, local features (a scree slope, a single boulder), not the long paths that
    actually cross a continent-extract boundary. Kept anyway because it is cheap and this
    script would otherwise be the one artifact in the pipeline that assumes away a
    problem its siblings both guard against.

**The geometry duplication this script does *not* have to handle, because the export
step already avoids it:** `osmium export` emits a closed way tagged `natural=scree` as
*two* separate features by default — a raw `LineString` for the way itself and a
`MultiPolygon` for the assembled area — verified against a real extract
(`scotland-latest.osm.pbf`, 2026-09-18): 6,059 LineStrings alongside 6,156 MultiPolygons
for `scree` alone, an almost-exact duplicate pair. `build-terrain-features.sh` calls
`osmium export --geometry-types=point,polygon`, which drops the redundant LineString at
the source rather than asking this script to notice two differently-shaped features
describing the same way.

Reads line-delimited GeoJSON on argv[1], writes line-delimited GeoJSON to argv[2],
streaming, same convention as normalize-sac.py and normalize-peaks.py.
"""
import json
import sys

KINDS = {"scree", "shingle", "rock", "stone"}


def main(src, dest):
    kept = 0
    unrecognized = 0
    duplicated = 0
    by_kind = {}
    # (kind, @id) rather than @id alone: a node and a way can share a numeric id (OSM's
    # node and way id spaces are independent), and `rock`/`stone` are the two kinds that
    # actually carry both geometry types, so scoping by kind too costs nothing and closes
    # that off rather than trusting it can't happen.
    seen = set()

    with open(src) as src_f, open(dest, "w") as dest_f:
        for line in src_f:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue

            feature = json.loads(line)
            props = feature.get("properties", {})

            kind = props.get("natural")
            if kind not in KINDS:
                unrecognized += 1
                continue

            osm_id = props.get("@id")
            key = (kind, osm_id)
            if osm_id is not None:
                if key in seen:
                    duplicated += 1
                    continue
                seen.add(key)

            new_props = {"kind": kind}
            if isinstance(props.get("name"), str):
                new_props["name"] = props["name"]
            feature["properties"] = new_props

            dest_f.write(json.dumps(feature) + "\n")
            kept += 1
            by_kind[kind] = by_kind.get(kind, 0) + 1

    print(
        f"  kept {kept} features; skipped {unrecognized} with an unrecognized natural= "
        f"value, {duplicated} already seen (continent seams)"
    )
    if by_kind:
        print("  by kind: " + ", ".join(f"{k} x{by_kind[k]}" for k in sorted(by_kind)))


def self_test():
    # Thin on purpose — there is no free-text parsing here to stress. This exists so a
    # future change to the kind/dedup/rename logic above still has something to break
    # against, the same standard every other normalize script in this pipeline holds to.
    cases = [
        ({"natural": "scree", "@id": 1}, {"kind": "scree"}),
        ({"natural": "shingle", "@id": 2, "name": "Cùil Bay shingle"},
         {"kind": "shingle", "name": "Cùil Bay shingle"}),
        ({"natural": "rock", "@id": 3, "name": None}, {"kind": "rock"}),
        # Not one of ours — should be dropped, not passed through with a stray kind.
        ({"natural": "wood", "@id": 4}, None),
        ({"natural": "bare_rock", "@id": 5}, None),
    ]

    import tempfile
    import os

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.geojsonl")
        dest = os.path.join(tmp, "out.geojsonl")
        with open(src, "w") as f:
            for props, _ in cases:
                feature = {
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "Point", "coordinates": [0, 0]},
                }
                f.write(json.dumps(feature) + "\n")

        main(src, dest)

        with open(dest) as f:
            outputs = [json.loads(line)["properties"] for line in f]

        expected = [exp for _, exp in cases if exp is not None]
        if outputs != expected:
            sys.exit(
                f"FAIL: normalize-terrain-features self-test\n"
                f"  expected {expected}\n  got {outputs}"
            )
    print(f"  normalize-terrain-features self-test OK ({len(cases)} cases)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]:
        self_test()
    else:
        main(sys.argv[1], sys.argv[2])
