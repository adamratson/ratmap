# The reduce step as build-paths.sh ran it in Python, before cmd/reduce-paths replaced it
# (copied verbatim from its PY_REDUCE heredoc). Kept only to regenerate the golden files:
#
#   python3 testdata/reduce-paths.py testdata/edge.geojsonl testdata/edge.want.geojsonl edge \
#     > testdata/edge.want.stdout
import json, sys

kept = 0
skipped = 0
with open(sys.argv[1]) as src, open(sys.argv[2], "w") as dest:
    for line in src:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        feature = json.loads(line)
        # Ways only. The export already asks osmium for lines alone; this stays as the
        # guard, since a point or an area slipping through would be drawn as a path.
        if feature.get("geometry", {}).get("type") not in ("LineString", "MultiLineString"):
            skipped += 1
            continue
        highway = feature.get("properties", {}).get("highway")
        if not isinstance(highway, str):
            skipped += 1
            continue
        feature["properties"] = {
            "kind": "path",
            # Vehicle-width or not: the one distinction the styling makes, and the only
            # one worth two zoom levels of bytes.
            "kind_detail": "track" if highway == "track" else "path",
        }
        dest.write(json.dumps(feature) + "\n")
        kept += 1

print(f"  {sys.argv[3]}: {kept} walkable ways, skipped {skipped} non-line features")
