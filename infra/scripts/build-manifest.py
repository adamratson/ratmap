#!/usr/bin/env python3
"""Generate regions/manifest.json — the download catalogue the app reads.

C16: the schema is versioned and open-ended. A region is "a set of named artifacts", not a
fixed basemap+terrain pair, so contours (and later routing tiles) are an *additive*
artifact rather than a schema migration. The app must therefore iterate whatever artifacts
a region declares instead of hardcoding names.

Artifact sizes are recorded here so the app can check `navigator.storage.estimate()`
against a region *before* starting a multi-hundred-MB download (C1: never let a user
believe they have offline maps they don't).
"""
import hashlib
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = 1

# Filename suffix -> artifact kind. Adding a kind here is all it takes to publish a new
# artifact type; the app renders whatever it finds.
ARTIFACT_KINDS = {
    "-basemap.pmtiles": "basemap",
    "-terrain.pmtiles": "terrain",
    "-contours.pmtiles": "contours",
}


def artifact_kind(filename):
    for suffix, kind in ARTIFACT_KINDS.items():
        if filename.endswith(suffix):
            return kind
    return None


def zoom_range(path):
    """Read an archive's real min/max zoom from its PMTiles header.

    Recorded in the manifest so the app can tell the user what detail they actually have
    rather than assuming. Without it the app has to hardcode a guess, and then claims
    "limited detail" over a region it has fully downloaded — crying wolf, which trains
    people to ignore the warning that matters.
    """
    try:
        out = subprocess.run(
            ["pmtiles", "show", str(path), "--header-json"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        header = json.loads(out)
        return header.get("minzoom"), header.get("maxzoom")
    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError) as err:
        print(f"  ! could not read zoom range from {path.name}: {err}", file=sys.stderr)
        return None, None


def sha256(path, chunk=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def build(dist_dir, regions_json, dest):
    with open(regions_json) as f:
        defined = {r["id"]: r for r in json.load(f)["regions"]}

    regions_dir = pathlib.Path(dist_dir) / "regions"
    regions = []

    for region_dir in sorted(p for p in regions_dir.iterdir() if p.is_dir()):
        region_id = region_dir.name
        meta = defined.get(region_id)
        if meta is None:
            print(f"  ! skipping {region_id}: not in regions.json", file=sys.stderr)
            continue

        artifacts = []
        for path in sorted(region_dir.glob("*.pmtiles")):
            kind = artifact_kind(path.name)
            if kind is None:
                print(f"  ! skipping {path.name}: unrecognised artifact suffix", file=sys.stderr)
                continue
            minzoom, maxzoom = zoom_range(path)
            artifacts.append(
                {
                    "kind": kind,
                    # C3: the filename is also the OPFS/TileSourceRegistry key, so it must
                    # stay globally unique — hence the region-id prefix.
                    "filename": path.name,
                    "path": f"regions/{region_id}/{path.name}",
                    "bytes": path.stat().st_size,
                    "minzoom": minzoom,
                    "maxzoom": maxzoom,
                    # Lets a resumed or re-downloaded artifact be checked for integrity.
                    "sha256": sha256(path),
                }
            )

        if not artifacts:
            print(f"  ! skipping {region_id}: no artifacts built", file=sys.stderr)
            continue

        regions.append(
            {
                "id": region_id,
                "name": meta["name"],
                "bbox": meta["bbox"],
                "totalBytes": sum(a["bytes"] for a in artifacts),
                "artifacts": artifacts,
            }
        )

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "regions": regions,
    }

    dest_path = pathlib.Path(dest)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(dest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"manifest: {len(regions)} region(s) -> {dest_path}")
    for region in regions:
        size_mb = region["totalBytes"] / 1e6
        kinds = ", ".join(a["kind"] for a in region["artifacts"])
        print(f"  {region['id']}: {size_mb:.1f} MB ({kinds})")


if __name__ == "__main__":
    here = pathlib.Path(__file__).resolve().parent
    infra = here.parent
    build(
        dist_dir=sys.argv[1] if len(sys.argv) > 1 else infra / "dist",
        regions_json=infra / "regions.json",
        dest=(pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else infra / "dist")
        / "regions"
        / "manifest.json",
    )
