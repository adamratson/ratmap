# Docker: running the infra pipeline for the whole planet

The scripts in `infra/scripts` run fine on a laptop against `regions.json`-derived inputs
— a few hundred MB of Scotland and Montenegro. This image exists for the other job the
README describes and nobody has run yet: **peaks and places built from Geofabrik's
continent extracts, i.e. the entire globe.** That is ~85 GB of source data, days of
wall-clock time, and a set of tool versions you want pinned rather than whatever `brew`
installed last Tuesday.

Nothing about the pipeline's decisions changes in here. Same scripts, same zoom ceilings,
same contour intervals, same environment-variable overrides. The image supplies the
toolchain; `build-global.sh` supplies the source caching, preflight and logging that a
multi-day unattended run needs and a laptop run doesn't.

## What's in the image

| Tool | Version | Why pinned there |
|---|---|---|
| tippecanoe | 2.79.0, built from source | Debian trixie ships 2.53.0; 2.79.0 is what the recorded 2026-08-21/22 runs used, and feature-dropping behaviour is version-sensitive |
| pmtiles (go-pmtiles) | 1.31.2, release binary, SHA256-verified | Same posture as C13 — pinned, never `latest` |
| osmium-tool | Debian trixie (1.18.0) | `tags-filter` / `merge` / `export` |
| GDAL | Debian trixie (3.10.3) | `gdal_contour`, `ogr2ogr` with the GeoJSONSeq driver |
| python3 + sqlite3 | Debian trixie | The image build **fails** if FTS5 with `unicode61 remove_diacritics 2` doesn't work — C9's whole search index depends on it, and it's a distro build flag, not a guarantee |
| awscli | Debian trixie (v2) | uploads (`upload.sh` uses `aws s3 cp`, not `pmtiles upload` — see its header comment); request checksums forced to `when_required` so an aws-cli-v2 checksum disagreement with a non-AWS S3 gateway (hit against both R2 and Krystal) can't fail the last step of a multi-day run |
| Go | 1.27.1, release tarball, SHA256-verified | Compiles `scripts/contour-cell` and `scripts/tools` (prominence, avalanche slope, the paths reduce step) from the working copy on every run; the image build runs both modules' tests. Replaced the numpy + scipy venv the prominence and slope scripts needed (2026-09-25) |

Build args move any version without editing the Dockerfile:
`--build-arg TIPPECANOE_VERSION=2.80.0`. Bumping `PMTILES_VERSION` also requires bumping
`PMTILES_SHA256_*`; the build fails closed rather than installing an unverified binary.

Builds natively for `linux/amd64` and `linux/arm64`. On Apple Silicon make sure you get
arm64 — osmium and tippecanoe under QEMU are several times slower, and this pipeline is
already measured in days.

## Requirements — read before starting

```
/work                     >= 150 GB free    OSM cache + scratch
/opt/ratmap/infra/dist    >=  20 GB free    output
memory                    >=   4 GB, 8 GB comfortable
```

The disk figure: 85 GB of continent extracts held in the cache, plus a working copy of
the largest one (europe is ~35 GB) while it is being filtered, plus the GeoJSON
exports. The cache is worth keeping between runs — re-running the places stage after the
peaks stage then costs no download at all.

Two more caches live beside it, both worth keeping and both growing as stages run:

- `/work/cache/osm/subsets`: the OSM stages' shared subset, about a tenth of the extracts
  (~9 GB for the planet).
- `/work/cache/dem`: every Copernicus clip fetched, compressed. Land stays at 50–70% of raw
  (~3.3 MB/sq° at 90 m). The whole catalogue's prominence clips are roughly 3–14 GB. The
  30 m clips for every contours and avalanche region would be ~55 GB more, as those
  stages run.

Neither is in the 150 GB floor. A run that is going to build contours and avalanche
everywhere wants `RATMAP_MIN_WORK_GB` raised to match, or `DEM_CACHE_DIR=` to not keep
the 30 m clips.

**Disk is the binding constraint here, not memory.** That is a deliberate result: the
GeoJSON intermediates are line-delimited (`osmium export -f geojsonseq`) and every
consumer streams them a feature at a time, so nothing in the pipeline scales its memory
with the size of the planet except one thing — `build-places-db.py` holds one row tuple
plus one dedupe key per surviving feature. Measured at ~319 B per row, that is ~1.6 GB
for the planet's ~5.1 M places+peaks.

What scales with the largest *region* is the peaks stage's prominence pass, which holds
one region's 90 m DEM at a time: ~9.5 bytes a pixel, so svalbard-janmayen's 712 Mpx is
~6.3 GB. Up to `PROM_FETCH_WORKERS` DEM fetches run ahead of it, each capped at ~1.25 GB.
The preflight works out the worst pairing from the catalogue whenever `peaks` is a stage:
8 GB for today's with three fetches, 7 GB with one. It fails at minute one on a box that
is too small.

For reference, the numbers behind those figures, measured rather than estimated. A parsed
GeoJSON feature costs ~1,162 B of Python objects, **5.0×** its JSON text (real OSM data).
Running `normalize-peaks.py` over a Europe-sized 2 M-feature export, whole-document load
versus streaming:

| | peak RSS | wall |
|---|---|---|
| `json.load()` whole document | 2,475 MB | 17.0 s |
| streamed, one feature at a time | **17 MB** | **7.7 s** |

Identical output either way — same 2 M features, same digest. Streaming is also the
faster path, since nothing builds a second copy of the document to serialise.

If you are tight on memory, run peaks/places a few continents at a time by setting
`PLACES_SOURCE_URLS` yourself — the scripts take an explicit list, and
`build-places-db.py` accepts multiple sources. `build-global.sh` checks the cgroup limit
up front, so a too-small VM fails at minute one rather than hour thirty. On Docker
Desktop the limit that matters is the VM's (Settings → Resources), not the host's.

Docker Desktop's disk image also needs raising (Settings → Resources → Disk image size) if
`/work` is a named volume, since named volumes live inside it.

## Use

On the machine that will actually run the planet build, pull rather than build — CI
publishes an amd64 image on every change to `infra/`:

```sh
cd infra/docker
docker compose pull
docker compose run --rm infra doctor          # versions + a resource preflight
```

The GHCR package is **private on first publish**. Either make it public
(Packages → the package → Package settings → Change visibility) or `docker login ghcr.io`
on the run host with a token carrying `read:packages` — otherwise the pull 404s, which
reads like a wrong image name rather than an auth problem.

To build locally instead (arm64 Macs included):

```sh
docker compose build
docker compose run --rm infra doctor
```

`doctor` prints the toolchain versions and the same preflight `build-global.sh` runs, so
you find out about a small VM before committing to a run rather than after.

```sh
docker compose run --rm infra global all
```

Long runs should be detached — a closed terminal shouldn't kill day two:

```sh
docker compose run -d --name ratmap-global infra global all
docker logs -f ratmap-global
```

Per-stage logs also land in `/work/logs/<run-id>-<stage>.log` inside the volume.

### Stages

`global` takes any subset, in any order, or `all`:

| Stage | What it does | Rough cost |
|---|---|---|
| `prefetch` | One resumable, md5-verified copy of each continent into `/work/cache/osm`, pinned to a dated snapshot | ~85 GB download, once |
| `world` | `build-world-catalog.sh` — z0–5 planet basemap extract | minutes, ~15 MB out |
| `terrain` | `build-terrain.sh` — coarse global hillshade | minutes, ~62 MB out at z4 |
| `peaks` | `build-peaks.sh` over all 8 continents → `peaks-global.pmtiles`, then one prominence pass over the catalogue | hours, mostly DEM fetches on a first run (`PROM_FETCH_WORKERS` at a time, up to 3, sized to the host). They are cached under `/work/cache/dem`, so a rebuild fetches none. As the first OSM stage in `all`, it also builds the shared subset — see [below](#one-tags-filter-pass-shared-by-the-osm-stages) |
| `sac` | `build-sac.sh` over all 8 continents → `sac-global.pmtiles` (SAC hiking grades) | minutes: its `tags-filter` reads the shared subset, about a tenth of the 85 GB source. The tiling itself is minutes too (~921 k ways planet-wide, ~400 MB out) |
| `paths` | `build-paths.sh` — tiles each continent separately, caches the tilesets under `/work/cache/paths-tiles`, `tile-join`s them → `paths-global.pmtiles`, the walkable network at z12-13 where the basemap has none | hours. 82 M ways planet-wide; the filter pass alone was 29 min on 12 cpus against the full source, which it now reads from the shared subset instead. **Resumable**: a re-run skips continents already tiled, so an interrupted stage costs one continent, not the planet. `RATMAP_PATHS_PARALLEL` tiles several at once, up to 3, sized to the host |
| `terrain-features` | `build-terrain-features.sh` over all 8 continents → `terrain-features-global.pmtiles` (scree, shingle, rock, boulders — `natural=` values Protomaps' OSM ingestion drops) | like `sac`, a `tags-filter` over the shared subset; tiling is minutes (~826 k features planet-wide by taginfo's count, ~5 MB out for Scotland+Montenegro alone in local testing) |
| `places` | `build-places.sh` over all 8 continents → `places.sqlite` | hours, the memory-hungry one |
| `regions` | `build-region.sh` for every id in `regions.json` (filter with `RATMAP_REGION_FILTER`) | hours — days for a global catalogue. 16 range requests per extract (`REGION_DOWNLOAD_THREADS`), terrain downloading alongside the basemap. `RATMAP_REGIONS_PARALLEL` builds several regions at once, up to 4, sized to the host |
| `contours` | `build-contours.sh` for the ids opting in with `"contours": true` — each region traced in 1° cells at ~1 GB a cell, whatever its size; two regions at a time, the box's cells split between them (`RATMAP_CONTOURS_PARALLEL`, `RATMAP_CONTOURS_CELL_WORKERS`) | the slowest by far. Its 30 m DEMs are fetched ahead of the builds (`RATMAP_CONTOURS_FETCH_AHEAD`, default 2) and cached, and `avalanche` reuses them for every region that has both |
| `manifest` | `build-manifest.py` — always regenerated, always last. Merges onto the live catalogue when `PUBLIC_BASE_URL` is set, so regions this disk does not hold stay published; a full rebuild from `dist/` only when it isn't | seconds when little changed: sha256s are cached by size, mtime and inode in `dist/.manifest-sha256-cache.json`, so only new or rebuilt archives are hashed. A first run hashes everything, 2 threads (`MANIFEST_HASH_WORKERS`, 1 for a spinning disk) |

`sac`, `paths` and `terrain-features` sit before `regions` in `all` for a reason:
`build-region.sh` cuts each region's `<id>-sac.pmtiles`, `<id>-paths.pmtiles` and
`<id>-terrain-features.pmtiles` out of those global archives, so a `regions` run that
precedes them builds the whole catalogue without any of the three. Naming stages by hand,
keep that order.

Stages skip work that already exists; `--force` redoes it. `--dry-run` passes through to
`build-region.sh` so you can size the region extracts first. `--skip-preflight` overrides
the resource check if you know better. `--repin` throws away the pinned snapshot dates
and resolves current ones — see below.

```sh
docker compose run --rm infra global prefetch peaks places
docker compose run --rm infra global regions --dry-run
docker compose run --rm infra global manifest --force
```

Adding an artifact kind to a catalogue that is already built is the one case where
`regions` does *not* mean "rebuild": a region whose basemap and terrain are present but
that is missing an artifact kind gets `build-region.sh <id> --only=<kinds>` — a cutout
from the local global archive for exactly the kinds it lacks. Measured on the first real
run (2026-09-06): ~20 ms per extract, **22 seconds for the whole catalogue**. So grades
and the low-zoom path network reach an existing 213 GB catalogue with:

```sh
docker compose run --rm infra global sac paths regions manifest
```

and no basemap or terrain is re-fetched. `--force` would re-extract everything, which for
a global catalogue is days — don't reach for it here. Bringing `terrain-features`
(scree/shingle/rock/boulders) to an existing catalogue the same way:

```sh
docker compose run --rm infra global terrain-features regions manifest
```

— or combine all three new-since-launch kinds in one pass:

```sh
docker compose run --rm infra global sac paths terrain-features regions manifest
```

### Why these stages export per continent instead of merging

`build-sac.sh`, `build-paths.sh` and `build-terrain-features.sh` export each filtered
continent extract separately and concatenate the line-delimited GeoJSON. They do **not**
`osmium merge` the PBFs first, and reintroducing that would break them:

```
Way ID twice in input. Maybe you are using a history or change file?
```

The continents are pinned to *dated* snapshots resolved per continent, because they do not
all rebuild at the same hour — `europe-260823` alongside `north-america-260824` in the run
that hit this. A way crossing a continent seam then appears in two files with two
different versions, which is a history file. `osmium merge`'s own `-H` flag exists to
silence that warning, and silencing it does not help: the next command cannot read the
result either.

The cost of concatenating is that a seam way is exported twice. `build-sac.sh` undoes that
(`osmium export -a id`, and normalize-sac.py drops ids it has already written — the
property is `@id`, not `id`); `build-paths.sh` deliberately does not, because holding
~85 M way ids in memory to remove a few thousand duplicates is not a trade worth making
for lines drawn at z12-13. `build-terrain-features.sh` follows `build-sac.sh`'s choice —
scree/rock/boulder features are a small fraction of `paths`' way count, so the same
dedup is affordable — but keys on `(kind, @id)` rather than `@id` alone, since a node and
a way can share a numeric id and `rock`/`stone` are the two kinds that carry both
geometries (see normalize-terrain-features.py).

### One tags-filter pass shared by the OSM stages

`peaks`, `sac`, `paths`, `terrain-features` and `places` all filter the same eight
continent extracts. Each used to stream the whole 85 GB through its own `osmium
tags-filter` — nine or ten full passes across the five, since a node-only filter reads its
input once, a way filter twice and `nwr/` up to four times. The first of them to run now
builds one subset per continent for the union of all five filters (`osm_subset` in
`lib.sh`), cached in `/work/cache/osm/subsets/`. Every stage then runs its own unchanged
filter over that instead: the same bytes out, a tenth of the input.

That is exact rather than approximately right. `tags-filter` keeps every matching object
and everything it references, and a stage's filter can only match and reference what the
union already kept. Checked byte for byte for all five stages on Scotland (2026-09-23).
Budget about a tenth of the extracts' size for the subsets, ~9 GB for the planet.
`RATMAP_NO_OSM_SUBSET=1` goes back to filtering the extracts directly.

### When the manifest stage fails on someone else's artifact

`build-manifest.py` fails closed on an archive whose PMTiles header will not read:

```
FAIL: austria-contours.pmtiles is not a readable PMTiles archive (...).
      Rebuild it; do not publish this manifest.
```

That is the right refusal — an interrupted `pmtiles extract` leaves a plausibly-sized file
with a zeroed header, and publishing it puts a broken download in the catalogue. But the
scan covers all of `dist/regions/`, so one stray file from an unrelated older build blocks
every region's publish, including the ones this run just built.

Fix the file, in preference to working around it:

```sh
docker compose run --rm infra pmtiles show /opt/ratmap/infra/dist/regions/austria/austria-contours.pmtiles
mv ../dist/regions/austria/austria-contours.pmtiles{,.broken}   # .broken is not *.pmtiles
docker compose run --rm infra global manifest
```

With `--base-live` (the default when `PUBLIC_BASE_URL` is set) the merge is per artifact
kind, so moving a local file aside does **not** unpublish that kind — austria keeps
whatever contours the live manifest already lists, and everything else in this run
publishes. Rebuild the bad artifact when convenient.

`RATMAP_MANIFEST_ONLY` is the blunter option, scoping the scan by region id regex. Note
what it costs: a region excluded from the scan is not recomputed at all, so artifacts this
run built for it stay unpublished until a later manifest run includes it.

```sh
RATMAP_MANIFEST_ONLY='^(?!austria$)' docker compose run --rm infra global manifest
```

### Iterating without rebuilding

`compose.yml` bind-mounts `infra/scripts` and `infra/regions.json` read-only, so edits to
the pipeline take effect on the next `run` with no image rebuild. The `global` driver
itself is installed at `/usr/local/bin/ratmap-global`, deliberately *outside* the infra
tree — installed into `scripts/` it would disappear behind that same bind mount. Rebuild
the image only when a tool version changes.

Any single script still runs directly, with its normal arguments:

```sh
docker compose run --rm infra build-region.sh scotland --dry-run
docker compose run --rm infra pmtiles show /opt/ratmap/infra/dist/peaks-global.pmtiles
```

### Why the source cache exists

The caching itself lives in the pipeline, not here: `lib.sh`'s `cached_osm_extract` keeps
each extract in `OSM_CACHE_DIR` and shares it between the peaks and places builds, and
`fetch_to` resumes and retries. The image contributes two things to that.

First, it sets `OSM_CACHE_DIR=/work/cache/osm` so the cache lands on the volume. Left at
its default the extracts would land in `infra/.cache/osm` **inside** the container — on
the writable layer, and gone when the container exits, so every run re-downloads 85 GB.

Second, `prefetch` warms that same directory up front and checks each file against
Geofabrik's published `.md5`. `fetch_to` resumes and retries but never verifies, and a
silently truncated europe extract would surface as mysteriously missing summits rather
than as an error. Because `prefetch` writes the exact paths `cached_osm_extract` looks
for, the build scripts then find everything present and download nothing — no second
copy. `RATMAP_NO_CACHE=1` skips the verification pass and lets the scripts fetch lazily.

### Why the sources are pinned to a date

`prefetch` does not download `europe-latest.osm.pbf`. It resolves each continent to the
newest *dated* snapshot — `europe-260823.osm.pbf` — records the choice in
`/work/cache/osm/pinned-sources.tsv`, and every later stage reads its source URLs from
there.

The reason is that `-latest` is a moving target and a planet run is not a quick job.
Geofabrik regenerates each continent daily; a full run takes days. Checking a file
downloaded on Tuesday against the digest published on Thursday is a guaranteed mismatch,
and the pipeline's only available response to a mismatch is to throw away 35 GB and
fetch it again — a file that was never corrupt. Pinning also means the finished planet
is one coherent snapshot rather than a smear across however many days the run spanned.

Two details worth knowing:

* **Pins are per continent, not one global date.** The daily rebuilds do not land
  simultaneously, so during the rollover window some continents have today's file and
  some only yesterday's. A day of skew between disjoint continent extracts is
  meaningless; a run that dies because one continent had not rebuilt yet is not.
* **Pins expire.** Geofabrik keeps roughly a week of daily snapshots (first-of-month
  ones stick around as archives). Resume a run after longer than that and the pinned
  file is a 404 — `prefetch` says so and tells you to re-run with `--repin`, which
  resolves fresh dates and refetches whatever is not already cached.

A `<continent>-latest.osm.pbf` left in the cache by an older run is not wasted: if its
bytes hash to the pinned snapshot's digest then it *is* that snapshot, and `prefetch`
adopts it under the dated name instead of re-downloading it.

The dated URLs have a useful side effect. `download.geofabrik.de` 302-redirects the
larger continents' `-latest` files to a mirror, and the mirror's `.md5` names the file
it actually holds on disk (`europe-260823.osm.pbf`) while the origin's names it
`europe-latest.osm.pbf`. That inconsistency is why the verification compares digests
directly and never uses `md5sum -c`, which matches on the recorded filename. The dated
URLs are served from the origin and skip the mirror entirely.

A global peaks build is also the first time `build-peaks.sh`'s elevation assertions carry
their full weight: with every continent present, both Ben Nevis **and** Mont Blanc are in
the extract, so both assertions actually run instead of printing "not in this extract".

### Contours are deliberately not global

`contours` runs per region, and only for regions that opt in with `"contours": true` in
`regions.json` — there is no planet contour build and this image doesn't pretend
otherwise. The intermediate GeoJSON is ~300 MB per square degree and the planet's land
surface is on the order of 15,000 square degrees. That is exactly the scratch-space
problem C14 is about; contours ship per downloaded region.

The opt-in became load-bearing when the catalogue went global: iterating every region in
`regions.json` used to mean four of them and now means several hundred, so the stage would
have walked into the planet contour build without anyone deciding to.

Memory no longer depends on the region. `build-contours.sh` traces each region in cells of
at most 3600 DEM pixels a side (1° of GLO-30), several at once, and joins them; each cell
is budgeted 1 GB. Two findings made that possible, both measured 2026-09-25:

- **The old ~6.4 GB for Corsica was GDAL's GeoJSON writer, not the tracing.** GDAL's
  GeoJSON and GeoJSONSeq writers hold ~17 bytes for every byte they write, for the life
  of the process: one 3602-pixel cell took 2967 MB writing GeoJSONSeq and 206 MB writing
  CSV. Corsica's 6.4 GB for 365 MB of output is the same ratio. `gdal_contour` now writes
  CSV with WKT geometry, and `scripts/contour-cell` (Go, compiled from the working copy
  on each build) writes the GeoJSON.
- **What the tracing does hold still grows with the region.** The sweep keeps every line it
  has not finished, so its memory rises with height as well as width. A cell bounds it: a
  52-Mpx DEM took 564 MB in one pass and 281 MB in cells. Morocco is 3,488 Mpx; the old
  estimate for it, Corsica's figure scaled by the square root of area, was 70 GB.

Cells overlap by a pixel and are cut on pixel-centre lines, where both neighbours compute
the same squares, so lines carry on across a seam from the same point (see
`build-contours.sh`). A region of one cell is not cut at all.

The stage runs two regions at a time, so one region's serial tail (joining its cells,
tippecanoe) overlaps the next one's tracing, and splits the cells the box can hold between
them. Each region's full output still goes to its own log under `/work/logs`; only a
one-line OK/FAILED per region reaches the main `contours` stage log. Both numbers can be
set, and are held to what the box can hold:

```sh
RATMAP_CONTOURS_PARALLEL=1 RATMAP_CONTOURS_CELL_WORKERS=16 docker compose run --rm infra global contours manifest
```

Not measured on a large region yet: tippecanoe on the joined output. It sorts on disk, and
the paths stage's tippecanoe stayed under 250 MB at a million features, but contours for
the largest regions will be far more than that.

What does *not* need to wait for tracing is the DEM. Each region's build is a fetch
(network-bound) and then `gdal_contour` (cpu-bound), and in sequence every region paid for
both. The stage now fetches ahead: a background fetcher walks the same list,
`RATMAP_CONTOURS_FETCH_AHEAD` regions at a time (default 2; 0 turns it off), filling the
DEM cache while earlier regions trace. Each build waits for its own DEM rather than
downloading it a second time, and fetches for itself only if the fetch-ahead failed. A
fetch holds ~1.25 GB at most, and the stage counts the fetches against the memory it
gives the cells. It needs the DEM cache: with
`DEM_CACHE_DIR` set empty the stage says so and builds as before.

### Parallelism and memory

Every knob below defaults to the value that is safe on the smallest box the preflight
allows, not the fastest on a large one. These are the measured per-worker costs
(2026-09-08, macOS/arm64 with the same tool versions) for deciding how far to raise them.

| Stage | What dominates memory | Peak RSS per worker | Scales with |
|---|---|---|---|
| `paths`, `sac` — `osmium tags-filter` | id bitmap over OSM's *global* id space | **1.89 GB** on a 33 MB extract, **1.96 GB** on a 310 MB one | nothing — it is flat, which is why 33 GB europe passes on a box this size |
| `paths` — reduce step (`tools/cmd/reduce-paths`) | streams a line at a time | 10 MB (the Python it replaced, 17 MB) | nothing |
| `paths` — `tippecanoe` | disk-backed sort | 172 MB at 259 k features, 227 MB at 1.04 M | sublinearly |
| `contours` — `gdal_contour`, one cell | lines open in the sweep, within one 3600-pixel cell | **281 MB** worst measured (synthetic mountains denser than Corsica); budgeted 1 GB | nothing: every region is cells. It was ~6.4 GB (Corsica) and grew with the region, when it wrote GeoJSON in one pass |
| `places` — `build-places-db.py` | rows + dedupe set held whole | ~1.6 GB for the planet | feature count |
| `peaks` — prominence scoring (`tools/cmd/compute-prominence`) | one region's 90 m DEM and an int32 union-find of the same shape | **9.1 bytes/px**: 1.30 GB on Scotland's 143 Mpx, budgeted at 9.5 (the Python it replaced was 1.35 GB, 1.94 GB before its buffers were reused) | the region's bbox — svalbard-janmayen's 712 Mpx is ~6.3 GB |
| `peaks` — DEM fetch (`fetch-dem.sh`), `PROM_FETCH_WORKERS` of them | `gdal_translate`'s block cache (capped at 512 MB) + the VSI cache | **229 MB** for Bosnia at 90 m; ~1.25 GB at most | region size, up to the cap |
| `avalanche` — `gdalwarp`, then `tools/cmd/encode-avalanche` | the warp's block cache; then three DEM rows | **694 MB** warping; the encode **15 MB** on Aragón's 113 Mpx (2026-09-25) — the Python it replaced was 792 MB at 108 Mpx and 1459 MB at 216, most of it evictable page cache | the warp; the encode only with raster width |

**Defaults, and what they assume.** There are no fixed defaults any more: each stage
takes the per-worker cost measured above, divides it into the memory this box can
actually see (the preflight's figure, less 1 GB left for the page cache and the kernel —
`RATMAP_MEM_RESERVE_GB`), and clamps the result to the cores and to whatever cap it has
its own reason for. `workers_for_budget` in `scripts/lib.sh` does the arithmetic, and
`docker/build-global.sh` carries its own copy for the same reason it carries its own
`mem_limit_gb`. The preflight prints what each stage of *this* run will use, before it
starts. Every number is still overridable, and an explicit one is capped the same way —
a number you type is a statement about the work, not about the machine.

What that comes out as, per box (`contours` is regions at once × cells each):

| memory / cores | `paths` | prominence fetches | `regions` | `avalanche` | `contours` |
|---|---|---|---|---|---|
| 4 GB / 2 | 1 | 1 | 1 | 1 | 1 × 1 |
| 8 GB / 4 | 2 | 2 | 2 | 2 | 2 × 2 |
| 16 GB / 8 | 3 | 3 | 4 | 4 | 2 × 4 |
| 32 GB / 16 | 3 | 3 | 4 | 4 | 2 × 8 |
| 64 GB / 32 | 3 | 3 | 4 | 4 | 2 × 16 |

- **`paths`: 3.** A worker peaks around 2-3 GB — osmium's flat ~2 GB plus a tippecanoe
  that never got near 1 GB even at 4x the features — so three is ~9 GB and the limit is
  cpu, not memory. Three rather than more because only europe, asia and north-america are
  big enough to be worth overlapping; the rest finish early whatever you set. Measured
  back to back on a Scotland+Montenegro pair, where one source dominates and the ceiling
  is therefore low: 78 s and 81 s at 1, against 73 s and 64 s at 3. `build-paths.sh`
  budgets 3 GB a worker against the memory it can actually see and prints what it settled
  on, so the default does not have to assume the host — and an explicit
  `RATMAP_PATHS_PARALLEL` is capped the same way, because a number you type is a statement
  about the work, not about the machine.
- **`contours`: two regions × half the cells.** A cell is budgeted 1 GB, after 2.5 GB for
  the two DEM fetches running ahead, so the cells a box can trace at once come to its
  cores on every box above but the smallest, whichever regions are in the run: morocco
  costs what liechtenstein does, per cell. Its DEMs are fetched ahead of
  the builds, two at a time (`RATMAP_CONTOURS_FETCH_AHEAD`).
- **`avalanche`: 4.** A region's phases run in sequence, so its peak is the largest of
  them and not their sum: ~0.8-1.5 GB, so four is ~6 GB on a 32 GB host. The warp phase is
  network-bound off `/vsicurl` with the cpu idle, which is what makes overlapping regions
  worth doing at all.

  An earlier note here put this at ~112 bytes per pixel and ~28.6 GB a worker for austria.
  That was read off a version of `encode-avalanche.py` that held the whole raster as
  float64 with eight `np.roll` copies; it went on to strip through memmaps, and has since
  been replaced by a Go port that streams three rows at a time (the table above). If you are reading a memory number in this repo,
  check it is not older than the code.

  The cpu side needed a second knob to make that true. `assemble-avalanche.py`'s WebP
  proof pass — ~2.5 s a tile, and Switzerland has ~600 of them — used to run a thread per
  core whatever else was running, so four regions meant four times the machine's cores in
  `cwebp` processes. `build-avalanche.sh` now divides the cores by
  `RATMAP_AVALANCHE_PARALLEL` and passes the share as `--jobs`: on 12 cores, four regions
  get three each. Run standalone with the variable unset it still takes every core, which
  is right for one region on an idle box.
- **Prominence fetches (`PROM_FETCH_WORKERS`): up to 3.** Sized by the same model the
  preflight checks the stage against — the worst pairing of "region being scored" plus
  "fetches running ahead" — so a box that cannot hold three gets two or one instead of
  being told to set the variable by hand. The rest of this bullet is why 3 is the ceiling.
  The peaks stage's DEM fetches are
  network-bound, and since `fetch-dem.sh` reads its VRT on one thread (below) a single
  fetch is slower than it was. Three at once took 70 s against 146 s one after another,
  for three similar regions (2026-09-23), with identical DEMs. Scoring stays one region at
  a time in a fixed order, so the number changes the wall clock and nothing else. Each
  fetch holds at most ~1.25 GB: `fetch-dem.sh` caps its block cache at 512 MB, which a
  straight copy does not miss (Bosnia: 229 MB peak at 2048, 236 MB at 256, same bytes).
  The fetches run ahead of the scoring and the regions are scored smallest first, so the
  largest region is scored with nothing left to fetch. The preflight walks that same
  order to find the worst pairing.
- **`regions` (`RATMAP_REGIONS_PARALLEL`): up to 4.** A region is already two downloads
  at once: `build-region.sh` runs terrain alongside the basemap, 16 range requests each
  (`REGION_DOWNLOAD_THREADS`). More regions at once only helps a host whose link that
  leaves idle, which is not something the image can know — so this is capped at 4 however
  large the host is, and at half its cores below that (`overlapping_io_parallel`), rather
  than scaling with them. Memory is not the binding constraint: a region's tippecanoe
  sorts on disk and stayed under 300 MB at 4x the features. On the 4 GB floor host it is
  1, which is what it always was.
- **`fetch-dem.sh`'s `xargs -P 16`** is availability probing over HTTP, not compute. It
  holds no raster and needs no adjustment. The read that follows is deliberately *not*
  parallel: GDAL's default of reading a VRT's sources on every core made the pixels along
  1° tile seams depend on which thread finished last, so no two fetches were the same DEM.
  `fetch-dem.sh` sets `VRT_NUM_THREADS=1`; see the note there.

### A global region build, in slices

`RATMAP_REGION_FILTER` is an extended regexp over region ids, so the `regions` stage can be
run a continent or a country at a time rather than as one run that has to survive for
days:

```sh
RATMAP_REGION_FILTER='^(france|germany|switzerland|austria|italy)' \
  docker compose run --rm infra global regions
```

**Safe to follow with `manifest` now, but check why.** This used to be deliberately
excluded: the stage did a bare, full-catalogue rebuild, so a filtered slice's `dist/` —
five countries — produced a manifest describing only those five, and `upload.sh` would
(correctly) refuse it as an unpublish of everything else. The stage now merges onto the
live catalogue whenever `PUBLIC_BASE_URL` is set, per artifact kind, so a slice publishes
its own regions and leaves the rest untouched. With no `PUBLIC_BASE_URL` it still falls
back to the bare rebuild, and the old warning applies in full.
Run `manifest` yourself afterward with `--base-live`, same as any other partial build (see
`../README.md`'s "Always pass `--base-live`" section). Also pass `--only`, scoped to
exactly this filter — a long-running `/work` volume accumulates archives from unrelated
past runs, and one corrupt file anywhere in `dist/regions/` would otherwise block
publishing this slice too, not just its own region:

```sh
docker compose run --rm infra build-manifest.py \
  --base-live --prune --only '^(france|germany|switzerland|austria|italy)$'
```

No manual `curl` or file staging needed — `--base-live` fetches the currently-published
manifest itself, and `PUBLIC_BASE_URL` is already in the container's environment via
`env_file: ../.env` (see the `compose.yml` volumes/environment above). `entrypoint.sh`
dispatches any `*.py`/`*.sh` name straight to `infra/scripts/`, so this runs
`build-manifest.py` with the image's pinned `pmtiles` — no local install needed either.

`upload.sh` skips archives already in the bucket at the same size, so uploading after each
slice is cheap.

## Upload

`upload.sh` works in the container if object storage credentials are present. `compose.yml` loads
`infra/.env` as environment (`required: false`, so its absence doesn't break every other
stage) rather than bind-mounting it — a bind mount of a file that doesn't exist yet
silently becomes a directory. `required:` needs Compose v2.24+; on an older Compose either
drop that line and always keep an `infra/.env`, or pass `--env-file ../.env` yourself.

```sh
docker compose run --rm infra upload.sh
```

`.dockerignore` keeps `.env` and `dist/` out of the image; credentials never go into a
layer.

Remember `places.sqlite` is app-shell, not a bucket artifact — `upload.sh` skips it by
design. Copy it into the app yourself:

```sh
cp ../dist/places.sqlite ../../public/data/places.sqlite
```

## What runs as root

The container runs as root by default, so on Linux the files it writes into `infra/dist`
are root-owned. Add `--user "$(id -u):$(id -g)"` to fix that; `/work` and `dist` are the
only paths written to, and both are mounts you own. Not an issue on Docker Desktop, which
maps ownership for you.
