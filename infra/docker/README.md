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
| numpy + scipy | in a venv at `/opt/ratmap/infra/.venv` | `build-peaks.sh`'s prominence pass requires an interpreter at exactly that path. Bounded to current majors rather than pinned; `ratmap doctor` reports what got installed (currently numpy 2.5.2, scipy 1.18.1) |

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

**Disk is the binding constraint here, not memory.** That is a deliberate result: the
GeoJSON intermediates are line-delimited (`osmium export -f geojsonseq`) and every
consumer streams them a feature at a time, so nothing in the pipeline scales its memory
with the size of the planet except one thing — `build-places-db.py` holds one row tuple
plus one dedupe key per surviving feature. Measured at ~319 B per row, that is ~1.6 GB
for the planet's ~5.1 M places+peaks.

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
| `peaks` | `build-peaks.sh` over all 8 continents → `peaks-global.pmtiles` | hours |
| `places` | `build-places.sh` over all 8 continents → `places.sqlite` | hours, the memory-hungry one |
| `regions` | `build-region.sh` for every id in `regions.json` (filter with `RATMAP_REGION_FILTER`) | hours — days for a global catalogue |
| `contours` | `build-contours.sh` for the ids opting in with `"contours": true`, several regions at once (`RATMAP_CONTOURS_PARALLEL`) | the slowest by far |
| `manifest` | `build-manifest.py` — always regenerated, always last | minutes (sha256s everything) |

Stages skip work that already exists; `--force` redoes it. `--dry-run` passes through to
`build-region.sh` so you can size the region extracts first. `--skip-preflight` overrides
the resource check if you know better. `--repin` throws away the pinned snapshot dates
and resolves current ones — see below.

```sh
docker compose run --rm infra global prefetch peaks places
docker compose run --rm infra global regions --dry-run
docker compose run --rm infra global manifest --force
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

`gdal_contour` itself has no multithreading, but regions are independent of each other, so
the `contours` stage runs several at a time (default: 4) rather than one after another.
Each region's full output goes to its own log under `/work/logs`; only a one-line
OK/FAILED per region reaches the main `contours` stage log. The default is capped well
below the container's core count deliberately: each concurrent worker costs roughly its
own ~300 MB/sq-degree of scratch space, so this is bounded by memory/disk, not CPU. Raise
it on a box with room to spare, or lower it further, with `RATMAP_CONTOURS_PARALLEL`:

```sh
RATMAP_CONTOURS_PARALLEL=8 docker compose run --rm infra global contours manifest
```

### A global region build, in slices

`RATMAP_REGION_FILTER` is an extended regexp over region ids, so the `regions` stage can be
run a continent or a country at a time rather than as one run that has to survive for
days:

```sh
RATMAP_REGION_FILTER='^(france|germany|switzerland|austria|italy)' \
  docker compose run --rm infra global regions manifest
```

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
