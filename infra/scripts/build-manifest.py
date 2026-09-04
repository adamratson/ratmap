#!/usr/bin/env python3
"""Generate regions/manifest.json — the download catalogue the app reads.

C16: the schema is versioned and open-ended. A region is "a set of named artifacts", not a
fixed basemap+terrain pair, so contours (and later routing tiles) are an *additive*
artifact rather than a schema migration. The app must therefore iterate whatever artifacts
a region declares instead of hardcoding names.

Artifact sizes are recorded here so the app can check `navigator.storage.estimate()`
against a region *before* starting a multi-hundred-MB download (C1: never let a user
believe they have offline maps they don't).

Two modes:

  build-manifest.py [dist_dir]
      Full rebuild, strictly from dist_dir/regions/*. This is what the Docker global
      build uses — dist_dir there genuinely holds (or is building towards holding) every
      region in regions.json, so a from-scratch manifest is correct.

  build-manifest.py [dist_dir] --base-live [--prune]
  build-manifest.py [dist_dir] --base <manifest.json path or URL> [--prune]
      Incremental update. No single machine has ever held every region's archives at
      once — regions get built a handful at a time, often in different sessions on
      different hosts, against a catalogue of 180+ entries. Requiring the full set
      locally before publishing anything meant every partial build either had to be
      hand-spliced into a copy of the live manifest (fragile, ad hoc, done at least
      twice — Montenegro's contours artifact and the England/Scotland/Wales split,
      2026-09), or a `curl .../regions/manifest.json` copy-pasted separately into every
      doc and script that needed one — which is its own reliability problem, so fetching
      it is built in here instead: --base-live reads PUBLIC_BASE_URL (from the
      environment, falling back to infra/.env) and fetches straight from there. --base
      also still takes a plain http(s) URL or a local path, for a base manifest that
      isn't the live one. Either way, only region ids actually present in
      dist_dir/regions/ are (re)computed and overwrite the base entry (merged by
      artifact kind, not by whole region — see the comment at the merge below);
      everything else in the base carries over untouched. --prune additionally drops
      base regions whose id is no longer in regions.json — an explicit, opt-in
      unpublish, not an implicit side effect of a partial build.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request
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
        # Hard failure, not a warning. An unreadable header is how a corrupt archive
        # presents itself — an interrupted `pmtiles extract` leaves a plausibly-sized file
        # whose header is all zeros. Publishing it would put a broken download in the
        # catalogue, so refuse to write a manifest describing it at all.
        raise SystemExit(
            f"FAIL: {path.name} is not a readable PMTiles archive ({err}).\n"
            f"      Rebuild it; do not publish this manifest."
        )


def sha256(path, chunk=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def public_base_url(infra_dir):
    """PUBLIC_BASE_URL from the environment, falling back to infra/.env.

    A bash caller that went through lib.sh already has this exported; a bare
    `python3 build-manifest.py --base-live` invocation has not. Re-reading infra/.env
    here (rather than requiring callers to source it first) is what makes --base-live
    work the same way regardless of how this script was reached — matching the .env
    fallback lib.sh already gives every shell script in this directory.
    """
    value = os.environ.get("PUBLIC_BASE_URL")
    if value:
        return value

    env_file = pathlib.Path(infra_dir) / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key.strip() == "PUBLIC_BASE_URL":
                return val.strip().strip('"').strip("'")

    return None


def load_base_manifest(source):
    """The base manifest's parsed JSON, from a URL or a local path.

    A plain http(s):// prefix is treated as a URL (urllib, stdlib only — no new
    dependency for what is otherwise a pure local-file script); anything else is opened
    as a path, same as before this existed.
    """
    if source.startswith(("http://", "https://")):
        try:
            with urllib.request.urlopen(source, timeout=30) as response:
                return json.load(response)
        except urllib.error.URLError as err:
            raise SystemExit(f"FAIL: could not fetch base manifest from {source}: {err}")

    with open(source) as f:
        return json.load(f)


def build_local_regions(dist_dir, defined):
    """Region entries computed fresh from whatever is actually present under dist_dir.

    A region directory that exists but yields nothing usable (unknown region id, no
    recognised artifacts) is simply absent from the returned dict — callers merging
    against a base manifest must leave such an id's existing entry untouched rather than
    treat the empty/broken local directory as "delete this from the catalogue".
    """
    regions_dir = pathlib.Path(dist_dir) / "regions"
    by_id = {}

    if not regions_dir.is_dir():
        return by_id

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

        by_id[region_id] = {
            "id": region_id,
            "name": meta["name"],
            # Absent on hand-written regions; the app treats it as optional.
            **({"group": meta["group"]} if meta.get("group") else {}),
            "bbox": meta["bbox"],
            "totalBytes": sum(a["bytes"] for a in artifacts),
            "artifacts": artifacts,
        }

    return by_id


def build(dist_dir, regions_json, dest, base_source=None, prune=False):
    with open(regions_json) as f:
        defined = {r["id"]: r for r in json.load(f)["regions"]}

    fresh = build_local_regions(dist_dir, defined)

    if base_source is None:
        regions_by_id = dict(fresh)
    else:
        base = load_base_manifest(base_source)

        if base.get("schemaVersion", 0) > SCHEMA_VERSION:
            raise SystemExit(
                f"FAIL: base manifest schemaVersion {base['schemaVersion']} is newer than "
                f"this script understands ({SCHEMA_VERSION}). Refusing to merge blind — "
                f"update this script first."
            )

        regions_by_id = {r["id"]: r for r in base.get("regions", [])}

        # Merge *by artifact kind*, not by whole region — a region already in the base
        # manifest is very often only partly rebuilt (e.g. contours added to a region
        # whose basemap/terrain were already live). Replacing the whole entry with what
        # was rebuilt here would silently drop every artifact kind not present in this
        # run's dist_dir, which is a real regression, not a hypothetical one: the first
        # version of this merge did exactly that to Montenegro's basemap and terrain in
        # testing (2026-09-04) before this fix.
        for region_id, fresh_region in fresh.items():
            existing = regions_by_id.get(region_id)
            if existing is None:
                regions_by_id[region_id] = fresh_region
                continue

            by_kind = {a["kind"]: a for a in existing.get("artifacts", [])}
            by_kind.update({a["kind"]: a for a in fresh_region["artifacts"]})
            artifacts = sorted(by_kind.values(), key=lambda a: a["kind"])

            merged = dict(fresh_region)  # name/group/bbox from regions.json — current
            merged["artifacts"] = artifacts
            merged["totalBytes"] = sum(a["bytes"] for a in artifacts)
            regions_by_id[region_id] = merged

        if prune:
            before = len(regions_by_id)
            regions_by_id = {rid: r for rid, r in regions_by_id.items() if rid in defined}
            dropped = before - len(regions_by_id)
            if dropped:
                print(f"  pruned {dropped} region(s) no longer in regions.json", file=sys.stderr)

    regions = sorted(regions_by_id.values(), key=lambda r: (r.get("group", ""), r["name"]))

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

    # Full rebuild: every region was just computed, so the original behaviour (list
    # everything) still applies. Merge: only the touched ids are news; the rest is
    # exactly what the base manifest already said, so summarise instead of repeating it.
    if base_source is None:
        report_ids = sorted(regions_by_id)
    else:
        report_ids = sorted(fresh)

    for region_id in report_ids:
        region = regions_by_id.get(region_id)
        if region is None:
            continue
        size_mb = region["totalBytes"] / 1e6
        kinds = ", ".join(a["kind"] for a in region["artifacts"])
        print(f"  {region_id}: {size_mb:.1f} MB ({kinds})")

    if base_source is not None:
        unchanged = len(regions) - len(report_ids)
        print(f"  ({unchanged} region(s) unchanged, carried over from base manifest)")


def main():
    parser = argparse.ArgumentParser(
        description="Generate or incrementally update regions/manifest.json.",
    )
    parser.add_argument(
        "dist_dir",
        nargs="?",
        type=pathlib.Path,
        default=None,
        help="Defaults to infra/dist.",
    )
    parser.add_argument(
        "--base",
        type=str,
        default=None,
        metavar="MANIFEST_JSON_OR_URL",
        help=(
            "Existing manifest.json to merge into — a local path, or a plain http(s) "
            "URL. Only regions present in dist_dir/regions/ are recomputed; everything "
            "else in the base is carried over unchanged. Without this (or --base-live), "
            "dist_dir/regions/ must hold every region in the catalogue."
        ),
    )
    parser.add_argument(
        "--base-live",
        action="store_true",
        help=(
            "Shorthand for --base $PUBLIC_BASE_URL/regions/manifest.json — fetches the "
            "currently-published manifest as the merge base. PUBLIC_BASE_URL is read "
            "from the environment, falling back to infra/.env."
        ),
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help=(
            "With --base/--base-live: also drop base regions whose id is no longer in "
            "regions.json. An explicit unpublish, off by default."
        ),
    )
    args = parser.parse_args()

    if args.base and args.base_live:
        parser.error("--base and --base-live are mutually exclusive")

    if args.prune and args.base is None and not args.base_live:
        parser.error("--prune only makes sense together with --base or --base-live")

    here = pathlib.Path(__file__).resolve().parent
    infra = here.parent
    dist_dir = args.dist_dir or (infra / "dist")

    base_source = args.base
    if args.base_live:
        base_url = public_base_url(infra)
        if not base_url:
            parser.error(
                "--base-live needs PUBLIC_BASE_URL — set it in the environment or in "
                f"{infra / '.env'}"
            )
        base_source = f"{base_url.rstrip('/')}/regions/manifest.json"

    build(
        dist_dir=dist_dir,
        regions_json=infra / "regions.json",
        dest=dist_dir / "regions" / "manifest.json",
        base_source=base_source,
        prune=args.prune,
    )


if __name__ == "__main__":
    main()
