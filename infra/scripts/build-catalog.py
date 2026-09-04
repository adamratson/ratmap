#!/usr/bin/env python3
"""Generate regions.json — a globe-covering download catalogue — from Geofabrik's index.

    ./build-catalog.py                 # full run: measures every candidate (slow, cached)
    ./build-catalog.py --no-estimate   # rough pass off bbox area, for a quick look
    ./build-catalog.py --print         # summarise without writing regions.json

Why this exists: the catalogue *is* regions.json. Nothing in the pipeline discovers
regions — `ratmap global regions` loops over whatever ids this file defines — so "cover
the whole globe" means "write ~700 region definitions", which is not a hand job.

Source: https://download.geofabrik.de/index-v1.json, the same hierarchy the extracts
themselves come from (555 regions, each with a polygon and a .osm.pbf URL). Taking the
catalogue from there rather than inventing a grid means every region has a name a human
recognises and an OSM source that already exists.

Three things this does that a naive dump of that file does not:

1. **Sizes every candidate for real** (`pmtiles extract --dry-run` against the upstream
   archives) rather than guessing from bbox area. Area is a poor proxy — measured, a
   square degree of Switzerland is 108 MB of basemap and a square degree of Montenegro is
   31 MB. A region over the cap is subdivided into its Geofabrik children; one with no
   children left to split gets a lower zoom ceiling instead. Estimates are cached, so a
   re-run costs nothing and an interrupted run resumes.

2. **Splits regions whose bbox is nonsense.** Deriving a bbox from a country polygon gives
   [-180, …, 180, …] for the US, Russia, New Zealand, Fiji, Kiribati and Alaska — they
   cross the antimeridian, and `pmtiles extract --bbox` would cut a planet-width strip.
   Far-flung parts are split into separate regions (Hawaii is not a corner of Alaska's
   bounding box) and a genuine antimeridian crossing is emitted as two regions.

3. **Keeps hand-written regions.** Lochaber and the Cairngorms are curated areas
   Geofabrik has no equivalent for, and they are already published — dropping them from
   regions.json would delist them (upload.sh refuses, for good reason). Anything already
   in regions.json that this script did not generate is preserved verbatim.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import urllib.request

INFRA_DIR = pathlib.Path(__file__).resolve().parent.parent
# RATMAP_CACHE is set by the Docker image and points at the /work volume. Without honouring
# it, a containerised run writes its measurement cache to the container's own layer and
# throws away hours of dry runs the moment the container exits.
CACHE_DIR = pathlib.Path(os.environ.get("RATMAP_CACHE") or INFRA_DIR / ".cache")
INDEX_URL = "https://download.geofabrik.de/index-v1.json"
INDEX_CACHE = CACHE_DIR / "geofabrik-index.json"
ESTIMATE_CACHE = CACHE_DIR / "catalog-estimates.json"
REGIONS_JSON = INFRA_DIR / "regions.json"

# Same upstream archives, and the same pinning, as build-region.sh — the estimate has to
# be of the thing that will actually be extracted.
BASEMAP_SOURCE = "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles"
TERRAIN_SOURCE = "https://download.mapterhorn.com/planet.pmtiles"

# Zoom ceilings, best first. build-region.sh's defaults are the first of each; a region
# too big to split drops down this list rather than shipping a 40 GB download.
#
# Dropping a basemap level costs roughly 4x the detail and is not free: paths carry
# min_zoom 14 in the Protomaps schema, so z13 is where a walking map stops being one.
# That is why subdivision is tried first and this is the fallback.
BASEMAP_ZOOMS = [15, 14, 13]
TERRAIN_ZOOMS = [11, 10, 9]

# Per-artifact cap. Both artifacts download together, so the real ceiling a user sees is
# about twice this. 900 MB is already a long download on hill signal; it exists to stop a
# region being impossible, not to make it comfortable.
DEFAULT_MAX_BYTES = 900_000_000

# Two polygon parts further apart than this become separate regions. Hawaii sits 4000 km
# off the US mainland: one bbox around both is 20,000 square degrees of empty Pacific.
# Below this, a longitude span is not a region — it is a framing artefact.
DEGENERATE_DEGREES = 0.01

PART_GAP_DEGREES = 5.0

UNITS = {"B": 1, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}

# Regions deliberately left out of the catalogue, with everything beneath them. Not a
# technical exclusion — the pipeline handles them — but a decision about what is worth
# building and hosting. They are also the three most expensive things in the catalogue:
# Russia's ten federal districts alone measured 176 cells and 115.6 GB once split to full
# detail. `summarise` prints what this omitted, so a hole in world coverage is a line in
# the output rather than something you notice on a hill.
# Ids that were published and then withdrawn. Never reuse one: the filename is the OPFS
# key (C3), nothing on the client verifies the sha256 the manifest records, and
# `regionStatus` is "is a file with this name present". So a new region reusing a retired
# id is served from whatever the old archive was, forever, on every device that had it —
# the wrong-tiles failure C3 exists to prevent, arriving through time instead of through a
# name collision. A generated region wanting one of these gets the `-region` suffix.
RETIRED_IDS = {
    "lochaber",
    "cairngorms",
    "scotland",
    "montenegro",
}

EXCLUDED_IDS = {
    "russia",         # 10 federal districts -> 176 cells
    "us",             # 53 state extracts
    "south-america",  # 12 countries
    "england",        # 47 counties -> hand-grouped into 9 official regions instead
                      # (england-north-east, ..., england-south-west in regions.json);
                      # Geofabrik has no tier between the whole country and county level.
    "scotland",       # childless leaf, but already a manual (no-geofabrikId) entry in
                      # regions.json — excluded so a regen doesn't generate a second,
                      # `-region`-suffixed copy of the same ground. See the montenegro
                      # incident this same rename mechanism produced (2026-09).
    "wales",          # same reasoning as scotland, also a manual entry
}

# Geofabrik publishes convenience extracts that are unions of regions it also publishes
# separately. Listing both would offer the same ground twice — a user downloading `alps`
# and then `switzerland` pays for Switzerland twice and gets two archives fighting over
# the same map. Each of these is fully covered by its constituents, which stay in.
#
# This list is deliberately explicit rather than inferred: bbox containment cannot tell an
# aggregate from a neighbour, and India's bbox contains Nepal, Bhutan, Bangladesh and Sri
# Lanka without being an aggregate of any of them. `summarise` prints an overlap report so
# a new aggregate in a future index shows up for review rather than passing silently.
AGGREGATE_IDS = {
    "alps",                  # = at + ch + de-south + fr-east + it-north + li + si
    "britain-and-ireland",   # = great-britain + ireland-and-northern-ireland
    "dach",                  # = germany + austria + switzerland
    "great-britain",        # = great-britain + the NI part of ireland-and-northern-ireland
    "south-africa-and-lesotho",  # = south-africa + lesotho
    "sea",                   # South-East Asia: = indonesia + malaysia-... + thailand + ...
    "us-midwest", "us-northeast", "us-pacific", "us-south", "us-west",  # = us/<state> sets
}


# --------------------------------------------------------------------------- index


def check_aggregates(children):
    """An aggregate with children is a parent, and dropping it drops the subtree.

    `united-kingdom` sat in AGGREGATE_IDS on the reasoning that `great-britain` covers the
    same ground. It does — but great-britain is the childless union, and united-kingdom is
    where England, Scotland and Wales hang. Listing the parent deleted all three from the
    catalogue and left a single 1.1 GB Great Britain capped at basemap z13, which is the
    zoom that generalises away nearly every path. Ben Nevis lost its paths to a one-line
    mistake in a set literal, and nothing said a word.
    """
    parents = {a: sorted(children[a]) for a in AGGREGATE_IDS if children.get(a)}
    if parents:
        detail = "\n".join(f"      {a} -> {', '.join(k)}" for a, k in parents.items())
        raise SystemExit(
            "FAIL: these AGGREGATE_IDS have children, so dropping them drops the "
            f"children too:\n{detail}\n"
            "      List the childless union instead, or move it to EXCLUDED_IDS if the "
            "omission is deliberate."
        )


def load_index(refresh: bool) -> dict:
    if refresh or not INDEX_CACHE.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        print(f"fetching {INDEX_URL}", file=sys.stderr)
        with urllib.request.urlopen(INDEX_URL, timeout=120) as response:
            INDEX_CACHE.write_bytes(response.read())
    with open(INDEX_CACHE) as f:
        index = json.load(f)

    features = {f["properties"]["id"]: f for f in index["features"]}
    children: dict[str, list[str]] = {}
    for feature in index["features"]:
        region_id = feature["properties"]["id"]
        if region_id in AGGREGATE_IDS or region_id in EXCLUDED_IDS:
            continue
        children.setdefault(effective_parent(region_id, feature["properties"], features), []).append(
            region_id
        )
    check_aggregates(children)
    return {"features": features, "children": children}


def effective_parent(region_id: str, props, features) -> str | None:
    """Geofabrik's `parent` field is not always the containing region.

    The 53 US state extracts are ids of the form `us/alabama` but carry
    `parent: north-america` — as siblings of `us`, not children of it. Taken at face
    value the catalogue would list the whole United States *and* every state, publishing
    the same ground twice at two zoom levels. The id path is the real hierarchy wherever
    it exists, so prefer it."""
    if "/" in region_id:
        parent = region_id.rsplit("/", 1)[0]
        if parent in features:
            return parent
    return props.get("parent")


def polygon_parts(feature: dict) -> list:
    geometry = feature["geometry"]
    if geometry["type"] == "MultiPolygon":
        return list(geometry["coordinates"])
    return [geometry["coordinates"]]


def part_bbox(part) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []

    def walk(node):
        if isinstance(node[0], (int, float)):
            xs.append(node[0])
            ys.append(node[1])
            return
        for child in node:
            walk(child)

    walk(part)
    return (min(xs), min(ys), max(xs), max(ys))


def union(boxes):
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def bbox_area(bbox) -> float:
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])


# ------------------------------------------------------------------- bbox splitting


def cluster(values, gap):
    """Group (low, high) intervals, starting a new group on a gap wider than `gap`."""
    groups: list[list] = []
    for item in sorted(values, key=lambda v: v[0]):
        if groups and item[0] - max(g[1] for g in groups[-1]) <= gap:
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups


def region_boxes(feature) -> list[tuple[float, float, float, float]]:
    """Bounding boxes to extract for one Geofabrik region, largest first.

    Usually one. More when the region has parts an ocean apart, or crosses the
    antimeridian — `pmtiles extract` takes west < east and cannot wrap, so a crossing has
    to become two extracts rather than one box spanning the entire planet the wrong way
    round.
    """
    boxes = [part_bbox(p) for p in polygon_parts(feature)]

    # Re-express longitudes as 0..360 and keep whichever framing is narrower. A country
    # sitting either side of the antimeridian is compact in the shifted frame and
    # planet-wide in the normal one; everything else is the reverse.
    shifted = [(b[0] + 360 if b[0] < 0 else b[0], b[1], b[2] + 360 if b[2] < 0 else b[2], b[3])
               for b in boxes]
    # A part that itself straddles the prime meridian comes out inverted when shifted;
    # such a part can't be crossing the antimeridian, so leave the frame alone.
    inverted = any(s[0] > s[2] for s in shifted)
    shifted_width = union(shifted)[2] - union(shifted)[0]
    # A ring that goes all the way round the globe — Antarctica — has longitudes spanning
    # exactly -180..180, which the shifted frame collapses to zero width. That reads as the
    # narrowest possible framing and wins, producing `180,-90,180,-60`: a box with no
    # width at all, which extracts a handful of tiles into an archive that fails
    # verification an hour into a build. A circumpolar region covers every longitude and
    # must keep the full-width frame.
    use_shifted = (
        not inverted
        and shifted_width > DEGENERATE_DEGREES
        and shifted_width < union(boxes)[2] - union(boxes)[0]
    )
    frame = shifted if use_shifted else boxes

    split: list[tuple[float, float, float, float]] = []
    for lon_group in cluster([(b[0], b[2], b) for b in frame], PART_GAP_DEGREES):
        members = [item[2] for item in lon_group]
        for lat_group in cluster([(b[1], b[3], b) for b in members], PART_GAP_DEGREES):
            split.append(union([item[2] for item in lat_group]))

    out = []
    for west, south, east, north in split:
        if use_shifted and west < 180 < east:
            # Genuinely crosses the antimeridian: two extracts, meeting at the line.
            out.append((west - 360 if west > 180 else west, south, 180.0, north))
            out.append((-180.0, south, east - 360, north))
        elif use_shifted:
            out.append((west - 360 if west > 180 else west, south,
                        east - 360 if east > 180 else east, north))
        else:
            out.append((west, south, east, north))

    boxes_out = sorted((tuple(round(v, 4) for v in b) for b in out),
                       key=bbox_area, reverse=True)

    # Checked here rather than trusted downstream. An invalid box costs a download and an
    # `ls`-plausible archive before `pmtiles verify` rejects it — and that is the good
    # case, hours into a run. The generator is where it is cheap to notice.
    for box in boxes_out:
        west, south, east, north = box
        if not (west < east and south < north
                and -180 <= west and east <= 180 and -90 <= south and north <= 90):
            raise SystemExit(
                f"FAIL: {feature['properties']['id']} produced an invalid bbox {box}.\n"
                f"      west<east, south<north, and within [-180,180]/[-90,90]."
            )
    return boxes_out


COMPASS = [
    ((0, 1), "north"), ((0, -1), "south"), ((1, 0), "east"), ((-1, 0), "west"),
    ((1, 1), "north-east"), ((-1, 1), "north-west"),
    ((1, -1), "south-east"), ((-1, -1), "south-west"),
]


def compass_label(box, primary) -> tuple[str, str]:
    """Where `box` sits relative to the region's main body, as a name and an id suffix."""
    dx = ((box[0] + box[2]) / 2) - ((primary[0] + primary[2]) / 2)
    dy = ((box[1] + box[3]) / 2) - ((primary[1] + primary[3]) / 2)
    span = max(abs(dx), abs(dy)) or 1
    sx = 0 if abs(dx) < span / 2 else (1 if dx > 0 else -1)
    sy = 0 if abs(dy) < span / 2 else (1 if dy > 0 else -1)
    name = next((n for (v, n) in COMPASS if v == (sx, sy)), "outlying")
    return name, "".join(word[0] for word in name.split("-"))


# ---------------------------------------------------------------------- estimating


def parse_size(text: str) -> int | None:
    """Bytes from `pmtiles extract --dry-run`'s closing line, or None if it said nothing."""
    match = re.search(r"archive size of ([\d.]+)\s*(TB|GB|MB|kB|B)\b", text)
    if not match:
        return None
    return int(float(match.group(1)) * UNITS[match.group(2)])


class Estimator:
    """Measured extract sizes, cached on disk.

    A dry run is two to twenty seconds of range requests against a 135 GB archive, and
    the walk asks for hundreds of them. Caching by (source, bbox, zoom) makes a re-run
    free and lets an interrupted one resume — which matters, because the first full pass
    takes an hour or two.
    """

    def __init__(self, workers: int, enabled: bool):
        self.enabled = enabled
        self.workers = workers
        self.cache: dict[str, int] = {}
        self.lock = threading.Lock()
        if ESTIMATE_CACHE.exists():
            with open(ESTIMATE_CACHE) as f:
                self.cache = json.load(f)
        self.misses = 0

    @staticmethod
    def key(source: str, bbox, maxzoom: int) -> str:
        kind = "basemap" if source == BASEMAP_SOURCE else "terrain"
        return f"{kind}|{','.join(f'{c:g}' for c in bbox)}|z{maxzoom}"

    def measure(self, source: str, bbox, maxzoom: int) -> int:
        """Guessed from bbox area when estimation is off, measured otherwise."""
        if not self.enabled:
            per_sq_degree = 40e6 if source == BASEMAP_SOURCE else 12e6
            shrink = 4 ** ((BASEMAP_ZOOMS if source == BASEMAP_SOURCE else TERRAIN_ZOOMS)[0] - maxzoom)
            return int(bbox_area(bbox) * per_sq_degree / shrink)

        key = self.key(source, bbox, maxzoom)
        if key in self.cache:
            return self.cache[key]

        # Retried, because a single failure must not end a run of thousands of
        # measurements. Four concurrent extracts over a 135 GB archive occasionally have
        # one die with no output at all — rerun by hand and it succeeds — and losing an
        # hour of measurement to that would be absurd.
        size = None
        for attempt in range(3):
            result = subprocess.run(
                ["pmtiles", "extract", source, "/dev/null",
                 f"--bbox={','.join(f'{c:g}' for c in bbox)}", f"--maxzoom={maxzoom}",
                 "--dry-run"],
                capture_output=True, text=True,
            )
            size = parse_size(result.stdout + result.stderr)
            if size is not None:
                break
            if result.returncode == 0:
                # An all-ocean bbox has nothing to extract and says so.
                size = 0
                break
            time.sleep(2 * (attempt + 1))

        if size is None:
            raise SystemExit(
                f"FAIL: pmtiles extract could not size {key} in 3 attempts:\n"
                f"{(result.stderr or result.stdout).strip() or '(no output)'}"
            )
        with self.lock:
            self.cache[key] = size
            self.misses += 1
            # Checkpoint as we go. The first full pass is an hour of range requests
            # against two archives; losing it to a Ctrl-C or a dropped connection would
            # mean starting from nothing.
            if self.misses % 25 == 0:
                self.save(locked=True)
        return size

    def warm(self, requests) -> None:
        """Measure a batch in parallel, so the walk's per-level work isn't serialised."""
        pending = [r for r in requests if self.key(*r) not in self.cache]
        if not pending or not self.enabled:
            return
        print(f"  measuring {len(pending)} candidate(s)...", file=sys.stderr)
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as pool:
            list(pool.map(lambda r: self.measure(*r), pending))
        self.save()

    def save(self, locked: bool = False) -> None:
        if not self.enabled:
            return
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        if not locked:
            self.lock.acquire()
        try:
            with open(ESTIMATE_CACHE, "w") as f:
                json.dump(self.cache, f, indent=0, sort_keys=True)
        finally:
            if not locked:
                self.lock.release()


# --------------------------------------------------------------------------- walking


def top_level(index, region_id: str) -> dict:
    """The continent-level ancestor — the group a region is listed under, and the OSM
    extract its peaks and search come from.

    Note Geofabrik has *nine* of these, not eight: Russia is its own top-level file, not
    part of europe or asia."""
    props = index["features"][region_id]["properties"]
    while props.get("parent"):
        props = index["features"][props["parent"]]["properties"]
    return props


def walk(index, estimator, max_bytes: int, only: str | None, caps: dict[str, int]):
    """Descend the hierarchy, subdividing anything too big to be one download.

    Breadth-first by level, so every candidate at a level can be measured in parallel;
    depth-first would serialise the slowest part of the run behind itself.
    """
    children = index["children"]
    tops = [t for t in children[None] if only is None or t == only]
    # Antarctica has no children, so it stands as its own candidate.
    frontier = [child for t in tops for child in children.get(t, [t])]
    accepted: list[str] = []

    level = 1
    while frontier:
        boxes = {region_id: region_boxes(index["features"][region_id]) for region_id in frontier}
        print(f"level {level}: {len(frontier)} candidate(s)", file=sys.stderr)
        estimator.warm(
            [(BASEMAP_SOURCE, box, BASEMAP_ZOOMS[0]) for region_id in frontier for box in boxes[region_id]]
        )

        next_frontier: list[str] = []
        for region_id in frontier:
            largest = max(
                estimator.measure(BASEMAP_SOURCE, box, BASEMAP_ZOOMS[0]) for box in boxes[region_id]
            )
            kids = children.get(region_id)
            if largest > caps.get(safe_id(region_id), max_bytes) and kids:
                next_frontier.extend(kids)
            else:
                accepted.append(region_id)
        frontier = next_frontier
        level += 1

    return accepted


def choose_zoom(estimator, source, zooms, bbox, max_bytes: int):
    """Highest zoom that keeps this artifact under the cap.

    Only reached for a region with nothing left to subdivide into — Antarctica, or a
    state that is simply large. Shipping it at a lower zoom is better than shipping a
    download nobody can complete, and the manifest records the real zoom range, so the
    app already tells the user what detail they actually have."""
    size = 0
    for zoom in zooms:
        size = estimator.measure(source, bbox, zoom)
        if size <= max_bytes:
            return zoom, size
    return zooms[-1], size


def clean_name(props) -> str:
    """Geofabrik names carry markup and sometimes just repeat the id."""
    name = re.sub(r"<br\s*/?>", " ", props["name"]).strip()
    name = re.sub(r"\s+", " ", name)
    if name == props["id"] or "/" in name:
        name = name.rsplit("/", 1)[-1].replace("-", " ").title()
    return name


def safe_id(geofabrik_id: str) -> str:
    """C3: this becomes a filename, an OPFS key and a TileSourceRegistry key."""
    return re.sub(r"[^a-z0-9-]+", "-", geofabrik_id.lower()).strip("-")


# ---------------------------------------------------------------------- assembling


def quadrants(box):
    """A box halved in both axes."""
    west, south, east, north = box
    mid_x, mid_y = (west + east) / 2, (south + north) / 2
    return [
        (west, mid_y, mid_x, north),
        (mid_x, mid_y, east, north),
        (west, south, mid_x, mid_y),
        (mid_x, south, east, mid_y),
    ]


def cell_label(box) -> tuple[str, str]:
    """A cell's name and id suffix, from where its centre is.

    Coordinates rather than a sequence number, because these are filenames (C3): numbering
    cells means a region that gains one cell renumbers all the ones after it, and every
    already-downloaded archive after that point silently becomes the wrong region.
    """
    lng = (box[0] + box[2]) / 2
    lat = (box[1] + box[3]) / 2
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lng >= 0 else "W")
    return (
        f"{abs(lat):.0f}\u00b0{ns} {abs(lng):.0f}\u00b0{ew}",
        f"{ns.lower()}{abs(lat):02.0f}{ew.lower()}{abs(lng):03.0f}",
    )


def split_to_fit(boxes, estimator, cap: int, max_depth: int, with_terrain: bool = True):
    """Cut boxes down to cells that fit the cap at full detail.

    The hierarchy runs out long before the size problem does: Geofabrik has nothing below
    the Siberian Federal District, Greenland or Nunavut's Qikiqtaaluk region, and each of
    those is several GB even after the zoom ladder has taken a level of detail away twice.
    A grid split is the only tool left, and it is the better one — it keeps full zoom and
    hands someone the part of Siberia they are actually walking in.

    Cells with nothing in them are dropped, which is most of what a quadtree over Greenland
    or the Arctic archipelago produces. That is also why this splits on measurements rather
    than on area: an empty quadrant costs nothing and disappears, so the cells that survive
    are the inhabited ones.

    Returns (cells, split) — `split` is False when the boxes were already fine, so a region
    that never needed cutting keeps its plain name and id.
    """
    level = list(boxes)
    done: list = []
    split = False
    sources = [(BASEMAP_SOURCE, BASEMAP_ZOOMS)]
    if with_terrain:
        sources.append((TERRAIN_SOURCE, TERRAIN_ZOOMS))

    for depth in range(max_depth + 1):
        estimator.warm(
            [(source, box, zooms[0]) for box in level for source, zooms in sources]
        )

        nxt = []
        for box in level:
            size = max(estimator.measure(source, box, zooms[0]) for source, zooms in sources)
            if depth > 0 and size == 0:
                continue  # an empty quadrant: ocean, ice, or off the edge of the data
            if size > cap and depth < max_depth:
                nxt.extend(quadrants(box))
                split = True
            else:
                done.append(box)
        level = nxt
        if not level:
            break

    # Anything still over the cap at max depth stays, and takes the zoom ladder instead.
    return sorted(done + level, key=bbox_area, reverse=True), split


def build_regions(index, accepted, estimator, max_bytes: int, caps: dict[str, int],
                  max_depth: int):
    boxes_by_region = {gid: region_boxes(index["features"][gid]) for gid in accepted}
    # Terrain has not been measured for anything yet — the walk only needed basemap sizes.
    # Warmed as one parallel batch, because the passes below would otherwise ask for
    # several hundred dry runs one at a time.
    estimator.warm(
        [(TERRAIN_SOURCE, box, TERRAIN_ZOOMS[0])
         for gid in accepted for box in boxes_by_region[gid]
         if safe_id(gid) not in {rid for rid, o in overrides().items()
                                 if o.get("terrain") is False}]
    )

    # Then cut anything still too big into cells. This is where the regions Geofabrik has
    # no children for stop being 5 GB downloads.
    sticky = overrides()
    skips_terrain = {rid for rid, over in sticky.items() if over.get("terrain") is False}

    cells_by_region = {}
    for geofabrik_id in accepted:
        cap = caps.get(safe_id(geofabrik_id), max_bytes)
        cells_by_region[geofabrik_id] = split_to_fit(
            boxes_by_region[geofabrik_id], estimator, cap, max_depth,
            with_terrain=safe_id(geofabrik_id) not in skips_terrain,
        )

    every_box = [box for cells, _ in cells_by_region.values() for box in cells]

    # Finally the fallback ladder, one rung at a time, measuring only the boxes still over
    # the cap at the rung above — the cells that a grid split could not rescue, either
    # because they hit the depth limit or because the data really is that dense.
    for source, zooms in ((BASEMAP_SOURCE, BASEMAP_ZOOMS), (TERRAIN_SOURCE, TERRAIN_ZOOMS)):
        # Measured against the smallest cap in play, so a region with its own lower cap
        # still has the rungs below it available. A raised cap simply stops using them.
        over = every_box
        for above, zoom in zip(zooms, zooms[1:]):
            over = [box for box in over
                    if estimator.measure(source, box, above) > min([max_bytes, *caps.values()])]
            if not over:
                break
            estimator.warm([(source, box, zoom) for box in over])

    records = []
    for geofabrik_id in accepted:
        feature = index["features"][geofabrik_id]
        props = feature["properties"]
        continent = top_level(index, geofabrik_id)
        cells, was_split = cells_by_region[geofabrik_id]
        primary = boxes_by_region[geofabrik_id][0]
        base_id = safe_id(geofabrik_id)
        name = clean_name(props)

        used: set[str] = set()
        for box in cells:
            if was_split:
                # Cells are named for where they are. A region that was cut up has no
                # "main" part to be north-west of.
                label, suffix = cell_label(box)
            elif box != primary:
                label, suffix = compass_label(box, primary)
            else:
                label, suffix = None, None

            region_id, region_name = base_id, name
            if suffix is not None:
                # Two cells can round to the same centre, and two outlying parts can land
                # in the same direction (American Oceania has three clusters, two of them
                # east). Keep ids unique without renumbering the ones already published.
                if suffix in used:
                    suffix = f"{suffix}-{sum(1 for u in used if u.startswith(suffix)) + 1}"
                    label = f"{label} {suffix[-1]}"
                used.add(suffix)
                region_id, region_name = f"{base_id}-{suffix}", f"{name} ({label})"

            cap = caps.get(region_id, caps.get(base_id, max_bytes))
            basemap_zoom, basemap_bytes = choose_zoom(
                estimator, BASEMAP_SOURCE, BASEMAP_ZOOMS, box, cap
            )
            if base_id in skips_terrain:
                terrain_zoom, terrain_bytes = TERRAIN_ZOOMS[0], 0
            else:
                terrain_zoom, terrain_bytes = choose_zoom(
                    estimator, TERRAIN_SOURCE, TERRAIN_ZOOMS, box, cap
                )

            record = {
                "id": region_id,
                "name": region_name,
                "bbox": [float(c) for c in box],
                # The *continent* extract, not this region's own. peaks and places are
                # single global artifacts built from the union of these
                # (region-osm-sources.py); pointing 700 regions at 700 country extracts
                # would make that union a 700-file download instead of a nine-file one,
                # for exactly the same coverage.
                "osmExtract": continent["urls"]["pbf"],
                "group": clean_name(continent),
                "geofabrikId": geofabrik_id,
                # Advisory: what `pmtiles extract --dry-run` says this will weigh. The
                # manifest carries the real byte counts once built; this is for deciding
                # what to build and in what order.
                "estimatedBytes": basemap_bytes + terrain_bytes,
            }
            if basemap_zoom != BASEMAP_ZOOMS[0]:
                record["basemapMaxzoom"] = basemap_zoom
            if terrain_zoom != TERRAIN_ZOOMS[0]:
                record["terrainMaxzoom"] = terrain_zoom
            records.append(record)

    records.sort(key=lambda r: (r["group"], r["name"]))
    return records


def overrides():
    """Per-region decisions in regions.json that a regeneration must not overwrite.

    All three are human calls the generator has no way to make. `contours` says a region
    is worth the most expensive artifact in the pipeline; `terrain: false` says the
    opposite about hillshade (Antarctica's is 101 GB at z11, spanning every longitude);
    `maxBytes` says a region is worth more than the default cap — Switzerland's basemap is 980 MB at z15, and dropping it to z14
    to stay under 900 MB trades away detail over the Alps to save 20% of a download people
    take on wifi before a trip.
    """
    if not REGIONS_JSON.exists():
        return {}
    with open(REGIONS_JSON) as f:
        return {
            r["id"]: {k: r[k] for k in ("contours", "maxBytes", "terrain") if k in r}
            for r in json.load(f)["regions"]
        }


def merge_with_manual(generated):
    """Keep every hand-written region, and never reuse one of their ids — or a retired one.

    Lochaber and the Cairngorms are curated areas with no Geofabrik equivalent, and they
    are published — a regions.json without them would delist them on the next upload.
    Generated regions are identified by `geofabrikId`; anything without one is manual and
    survives a regeneration untouched."""
    manual = []
    if REGIONS_JSON.exists():
        with open(REGIONS_JSON) as f:
            manual = [r for r in json.load(f)["regions"] if "geofabrikId" not in r]

    # Human decisions survive a regeneration rather than being silently reset on the next
    # run — see overrides().
    sticky = overrides()
    taken = {r["id"] for r in manual} | RETIRED_IDS
    for record in generated:
        record.update(sticky.get(record["id"], {}))
    for record in generated:
        if record["id"] in taken:
            record["id"] = f"{record['id']}-region"
        taken.add(record["id"])

    return manual + generated, manual


def overlaps(a, b) -> float:
    """Fraction of `a` covered by `b`, for flagging a generated duplicate of a manual region."""
    width = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return (width * height) / bbox_area(a) if bbox_area(a) else 0.0


def human(size: float) -> str:
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if abs(size) < 1000 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1000
    return ""


CATALOGUE_COMMENT = (
    "Region definitions for the offline download catalogue. bbox is [west, south, east, "
    "north]. Ids are URL-safe, stable, and become part of artifact filenames, which are "
    "also TileSourceRegistry keys (C3) — never rename a published one. Entries carrying "
    "`geofabrikId` are generated by scripts/build-catalog.py from Geofabrik's index and "
    "may be regenerated; entries without one are hand-written and are preserved across "
    "regenerations. `osmExtract` is the continent extract feeding the global peaks and "
    "places builds (region-osm-sources.py). `basemapMaxzoom`/`terrainMaxzoom` appear only "
    "where a region is too large to ship at the default ceiling; `estimatedBytes` is "
    "advisory, measured by pmtiles extract --dry-run at generation time. `maxBytes` raises "
    "(or lowers) the per-artifact cap for one region, so a region worth full detail keeps "
    "it — Switzerland's basemap is 980 MB at z15 and would otherwise drop to z14. "
    "`contours: true` "
    "opts a region into the contour build, which is otherwise skipped — it costs roughly "
    "300 MB of intermediate GeoJSON per square degree and does not scale to a global "
    "catalogue."
)


def summarise(records, manual, estimator):
    generated = [r for r in records if "geofabrikId" in r]
    total = sum(r.get("estimatedBytes", 0) for r in generated)

    print()
    print(f"catalogue: {len(records)} regions ({len(manual)} hand-written, {len(generated)} generated)")
    print(f"  projected bucket size: {human(total)} (basemap + terrain, contours excluded)")
    if generated:
        print(f"  median region: {human(sorted(r['estimatedBytes'] for r in generated)[len(generated) // 2])}")
    if EXCLUDED_IDS:
        # Said out loud every run. These are holes in world coverage, and a catalogue that
        # quietly stops at a border is worse than one that never claimed the ground.
        print(f"  excluded by decision: {', '.join(sorted(EXCLUDED_IDS))} (and everything under them)")

    cells: dict[str, list] = {}
    for record in generated:
        if re.search(r"\(\d+\u00b0[NS] \d+\u00b0[EW]", record["name"]):
            cells.setdefault(record["geofabrikId"], []).append(record)
    if cells:
        print(f"\n  {len(cells)} region(s) too big for their smallest Geofabrik subdivision, "
              f"cut into {sum(len(c) for c in cells.values())} cells at full zoom:")
        for gid, group in sorted(cells.items(), key=lambda kv: -len(kv[1]))[:10]:
            total = sum(r["estimatedBytes"] for r in group)
            largest = max(r["estimatedBytes"] for r in group)
            print(f"    {gid:32} {len(group):3} cells, {human(total):>9} total, "
                  f"largest {human(largest)}")

    degraded = [r for r in generated if "basemapMaxzoom" in r or "terrainMaxzoom" in r]
    if degraded:
        print(f"\n  {len(degraded)} region(s) capped below the default zoom (too large to split further):")
        for record in sorted(degraded, key=lambda r: -r["estimatedBytes"])[:10]:
            zooms = f"basemap z{record.get('basemapMaxzoom', BASEMAP_ZOOMS[0])}, terrain z{record.get('terrainMaxzoom', TERRAIN_ZOOMS[0])}"
            print(f"    {record['id']:32} {human(record['estimatedBytes']):>9}  ({zooms})")

    split = [r for r in generated if re.search(r"\((north|south|east|west|outlying)", r["name"])]
    if split:
        print(f"\n  {len(split)} region(s) split off a distant or antimeridian-crossing part:")
        for record in split[:12]:
            print(f"    {record['id']:32} {record['name']}")

    duplicates = [
        (m["id"], g["id"])
        for m in manual
        for g in generated
        if overlaps(m["bbox"], g["bbox"]) > 0.95 and overlaps(g["bbox"], m["bbox"]) > 0.95
    ]
    for manual_id, generated_id in duplicates:
        print(f"\n  ! {manual_id} and {generated_id} cover the same ground — consider dropping one")

    swallowed: list[tuple[str, list[str]]] = []
    for outer in generated:
        inside = [
            inner["id"] for inner in generated
            if inner is not outer and overlaps(inner["bbox"], outer["bbox"]) > 0.9
        ]
        if len(inside) >= 3:
            swallowed.append((outer["id"], inside))
    if swallowed:
        # Advisory, not automatic. This is the signature of a Geofabrik convenience
        # extract that AGGREGATE_IDS does not yet know about — but it is also the
        # signature of a large country with small neighbours, so it is a prompt to look,
        # not a rule. India's bbox swallows Nepal, Bhutan, Bangladesh and Sri Lanka.
        print(f"\n  {len(swallowed)} region(s) whose box contains 3+ others — check for a new aggregate:")
        for outer_id, inside in sorted(swallowed, key=lambda s: -len(s[1]))[:8]:
            print(f"    {outer_id:32} contains {len(inside)}: {', '.join(inside[:5])}"
                  + (" ..." if len(inside) > 5 else ""))

    print(f"\n  largest 10:")
    for record in sorted(generated, key=lambda r: -r["estimatedBytes"])[:10]:
        print(f"    {record['id']:32} {human(record['estimatedBytes']):>9}  {record['name']}")
    if estimator.enabled:
        print(f"\n  {estimator.misses} new measurement(s); cache: {ESTIMATE_CACHE}")
    else:
        print("\n  ! sizes are guessed from bbox area, not measured — re-run without --no-estimate")


def dumps(records) -> str:
    """Indented JSON, but with each bbox on one line.

    Four hundred regions is a file people still have to read and diff; a bbox split across
    four lines turns every one of them into a five-line block for no gain."""
    text = json.dumps({"comment": CATALOGUE_COMMENT, "regions": records}, indent=2,
                      ensure_ascii=False)
    return re.sub(
        r"\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]",
        r"[\1, \2, \3, \4]",
        text,
    ) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max-bytes", type=float, default=DEFAULT_MAX_BYTES,
                        help="per-artifact cap; a region over it is subdivided (default 900 MB)")
    parser.add_argument("--no-estimate", action="store_true",
                        help="guess sizes from bbox area instead of measuring — fast, and wrong by 3x")
    parser.add_argument("--max-depth", type=int, default=3,
                        help="how many times a region with no children may be quartered "
                             "to fit the cap (default 3, i.e. up to 64 cells)")
    parser.add_argument("--workers", type=int, default=4, help="parallel dry runs (default 4)")
    parser.add_argument("--refresh-index", action="store_true", help="re-download Geofabrik's index")
    parser.add_argument("--only", help="one continent id, for a quick look (implies --print)")
    parser.add_argument("--print", dest="print_only", action="store_true",
                        help="summarise without writing regions.json")
    args = parser.parse_args()

    index = load_index(args.refresh_index)
    estimator = Estimator(workers=args.workers, enabled=not args.no_estimate)
    try:
        caps = {rid: int(over["maxBytes"]) for rid, over in overrides().items()
                if "maxBytes" in over}
        accepted = walk(index, estimator, int(args.max_bytes), args.only, caps)
        generated = build_regions(index, accepted, estimator, int(args.max_bytes), caps,
                                  args.max_depth)
    finally:
        estimator.save()

    records, manual = merge_with_manual(generated)
    summarise(records, manual, estimator)

    if args.print_only or args.only:
        print("\n(--print: regions.json not written)")
        return

    # Written in place, deliberately. compose.yml bind-mounts this single file into the
    # container, and a write-to-temp-then-rename would replace the inode the mount is
    # pinned to — the container would see its own new file and the host's copy would never
    # change, which is the whole point of running the generator there.
    REGIONS_JSON.write_text(dumps(records))
    print(f"\nwrote {REGIONS_JSON}")


if __name__ == "__main__":
    main()
