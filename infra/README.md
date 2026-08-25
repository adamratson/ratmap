# infra

Phase 1 tile/data pipeline (see `../docs/IMPLEMENTATION.md` §4 Phase 1). Scripted and
re-runnable on data refresh — nothing here is a one-off manual process except the R2
bucket itself (`SETUP.md`, needs your Cloudflare account).

## Prerequisites

```sh
brew install tippecanoe pmtiles osmium-tool gdal   # gdal only needed for contours
```

`aws`/`curl` are assumed present.

## One-time setup

Follow `SETUP.md` to create the R2 bucket, then:

```sh
cp .env.example .env   # fill in R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_URL, AWS_* keys
```

`.env` is gitignored — never commit it.

## Build

Each script writes to `dist/` (gitignored) and is independent — run whichever artifacts
changed.

```sh
./scripts/build-world-catalog.sh   # low-zoom world basemap (§8.2 catalog-only)
./scripts/build-terrain.sh         # coarse global hillshade terrain
./scripts/build-peaks.sh           # natural=peak|volcano|saddle + mountain_pass=yes
./scripts/build-places.sh          # places.sqlite — offline FTS5 search index (C9)
```

All were run for real (2026-08-21) against small/coarse inputs to verify the commands are
actually correct, not just plausible — see the comments at the top of each script for what
was verified and the exact numbers.

**`build-peaks.sh` and `build-places.sh` derive their inputs from `regions.json`** — the
deduplicated union of every region's `osmExtract` (see `region-osm-sources.py`). Both
produce single *global* artifacts that have to cover whatever the catalogue publishes, so
deriving the list means adding a region can't silently ship a map with no summits and no
search. Re-run both whenever you add a region.

Override with `PEAKS_SOURCE_URLS` / `PLACES_SOURCE_URLS` for a genuinely global build off
Geofabrik's continent extracts — that's 85 GB of source; don't kick it off by accident.
`docker/` packages exactly that run — see [Running the whole planet](#running-the-whole-planet-docker).

`build-peaks.sh` normalizes OSM's free-text `ele` into a real number
(`normalize-peaks.py` — the raw tag includes values like `~340` and `1141m`) and asserts
known summit elevations (Ben Nevis 1345 m) so a parsing or schema regression fails the
build rather than surfacing on a mountain.

### Search index is app-shell, not a bucket artifact

`places.sqlite` lands in `dist/` like everything else, but it does **not** get uploaded to
R2 — copy it into the app instead, where the service worker precaches it so search works
on a cold offline start:

```sh
cp dist/places.sqlite ../public/data/places.sqlite
```

§3 puts the places index in OPFS long-term; Phase 4 should move it there per region and
keep this copy as the "no region downloaded yet" fallback.

```sh
./scripts/vendor-assets.sh         # C7: glyphs + sprites -> ../public, not dist/
```

Not a data artifact — writes straight into the app's `public/fonts` and `public/sprites`
(~13 MB), which then get bundled and service-worker-precached like any other app-shell
asset. Re-run only if the glyph/sprite set needs to change (new language support, etc.);
this doesn't need re-running on every data refresh the way the others do.

## Upload

```sh
./scripts/upload.sh
```

Uploads everything currently in `dist/` to the R2 bucket via `pmtiles upload` (S3-compatible,
uses the `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.env`).

## Verify (C4 acceptance check)

After uploading, confirm CORS and range requests actually work from a browser origin, not
just `curl` — this is the exact failure mode C4 exists to catch. Send an `Origin` header;
without one R2 returns no CORS headers at all and a plain `curl` looks deceptively fine:

```sh
curl -s -H "Origin: https://example.github.io" -H "Range: bytes=0-126" -D - \
  "$R2_PUBLIC_URL/world-catalog-<date>.pmtiles" -o /dev/null
# expect: 206, Content-Range, Accept-Ranges, Access-Control-Allow-Origin,
#         Access-Control-Expose-Headers listing ETag + Content-Range
```

Then load the app and confirm it renders — a browser enforces CORS on range requests where
`curl` doesn't, so a clean `curl` result alone proves nothing. The app defaults to this
bucket (`src/config.ts`); override with `VITE_R2_BASE_URL` in a repo-root `.env.local` to
point at a different one.

**Verified end-to-end 2026-08-21**: all three archives uploaded, preflight + ranged GET
return the headers above, and the app rendered basemap, hillshade and peaks from R2 in a
real browser (206s on all three, no console errors).

## Not yet built

- Forked Protomaps style as a static JSON artifact (the app currently generates its style
  at runtime via the `@protomaps/basemaps` package — see `src/main.ts`)
- Elevation assertions run inside `build-peaks.sh` but are **not wired into CI** — nothing
  runs the data pipeline on a schedule or on push, so a regression is only caught when
  someone rebuilds by hand
- A global (rather than Scotland-only) peaks/places build has **not been run**. The
  toolchain and driver for it exist (`docker/`, below); what's missing is someone
  spending the days and the 85 GB of downloads

## Running the whole planet (Docker)

Everything above is sized for a laptop and the sources `regions.json` implies. For the
global peaks/places build the README keeps pointing at, `docker/` has a pinned toolchain
image and a driver that runs the whole pipeline against Geofabrik's eight continent
extracts:

```sh
cd docker
docker compose build
docker compose run --rm infra doctor       # tool versions + resource preflight
docker compose run --rm infra global all   # days; ~85 GB downloaded once
```

It runs these same scripts with these same defaults — it adds a resumable, md5-verified
source cache (otherwise peaks and places each download 85 GB, with no resume), a
preflight that refuses to start on a box that can't finish, and per-stage logs.

Two things worth knowing before starting: it needs **~150 GB of disk but only ~4 GB of
RAM** (disk is the binding constraint — the GeoJSON intermediates are line-delimited and
streamed, so memory doesn't scale with the planet), and **contours stay per-region** — a
planet contour build is the C14 scratch-space problem, not something the image hides.
Details and the escape hatches are in `docker/README.md`.

## Offline regions (Phase 3)

Region definitions live in `regions.json` (`id`, display `name`, `bbox`). The id becomes
part of every artifact filename, which is also the OPFS key and the TileSourceRegistry key
— so ids must stay unique and stable (C3).

### The catalogue is generated, not hand-written

`regions.json` *is* the catalogue: nothing in the pipeline discovers regions, and
`ratmap global regions` builds exactly the ids that file defines. Covering the globe
therefore means several hundred definitions, which is `scripts/build-catalog.py`'s job.

```sh
./scripts/build-catalog.py --no-estimate --print   # rough shape of the catalogue, seconds
./scripts/build-catalog.py --print                 # measured; first run takes an hour or two
./scripts/build-catalog.py                         # same, and writes regions.json
```

It reads Geofabrik's `index-v1.json` — the same hierarchy the OSM extracts come from — and
walks down it, so every region has a name people recognise rather than a grid reference.
Three things it does that a straight dump of that file does not:

- **Sizes every candidate with `pmtiles extract --dry-run`** rather than guessing from
  bbox area, because area is a bad proxy: a square degree of Switzerland is 108 MB of
  basemap and a square degree of Montenegro is 31 MB. Anything over `--max-bytes` is
  subdivided into its Geofabrik children; anything with no children left to split gets a
  lower zoom ceiling (`basemapMaxzoom`/`terrainMaxzoom`, which `build-region.sh` reads)
  instead of becoming a download nobody can finish. Measurements are cached in
  `.cache/catalog-estimates.json`, so a re-run is free and an interrupted one resumes.
- **Cuts up what the hierarchy cannot.** Geofabrik has nothing below the Siberian Federal
  District, Greenland or Nunavut's Qikiqtaaluk region, and each is several GB even after
  the zoom ladder has taken two levels of detail away. Those get quartered instead
  (`--max-depth`, default 3, so up to 64 cells), recursively and on measurements rather
  than area — an empty quadrant measures zero and is dropped, which is most of what a
  quadtree over the Arctic produces. Cells are named for their centre
  (`siberian-fed-district-n62e082`, "Siberian Federal District (62°N 82°E)") rather than
  numbered: numbering means one new cell renumbers every cell after it, and C3 makes those
  names the OPFS keys of archives people have already downloaded.
- **Fixes the bboxes that would otherwise be planet-wide.** A bbox taken from a country
  polygon is `[-180, …, 180, …]` for the US, Russia, New Zealand, Fiji, Kiribati and
  Alaska — they cross the antimeridian, and `pmtiles extract` cannot wrap. Distant parts
  become separate regions (Hawaii is not a corner of Alaska's bounding box) and a genuine
  crossing is emitted as two.
- **Leaves out what `EXCLUDED_IDS` names**, with everything beneath it — currently
  `russia`, `us` and `south-america`. A decision about what is worth building, not a
  technical limit, and printed on every run so a hole in world coverage is a line in the
  output rather than something someone finds on a hill. Note the global peaks and places
  artifacts still cover that ground (they are built from the continent extracts), so
  search and summits work there while no region is downloadable — the world basemap is
  what those users get.
- **Drops Geofabrik's convenience aggregates** (`alps`, `dach`, `britain-and-ireland`,
  `sea`, the `us-*` groupings), which are unions of regions published separately. It also
  reads the US state extracts as children of `us` rather than as siblings, which is how
  the index actually lists them — taken at face value the catalogue would publish the
  whole United States *and* all 53 state extracts.

Hand-written regions survive regeneration: anything without a `geofabrikId` is preserved
verbatim, which is what keeps Lochaber and the Cairngorms — curated areas Geofabrik has no
equivalent for, and already published — in the catalogue. So do the two per-region
decisions the generator cannot make for itself:

- `"contours": true` — this region is worth the most expensive artifact in the pipeline.
- `"maxBytes": 1200000000` — this region is worth more than the default cap. Switzerland
  carries it: its basemap is 980 MB at z15, and the 900 MB default would drop it to z14,
  trading detail over the Alps for 20% of a download people take on wifi before a trip.
  Raising the cap for one region beats raising `--max-bytes` for all 469.

### Contours are opt-in

`ratmap global contours` builds only regions carrying `"contours": true`. Contours are by
far the most expensive artifact (roughly 300 MB of intermediate GeoJSON per square degree)
and there are now hundreds of regions; running the stage over all of them is the global
contour build C14 says never to attempt, arrived at by accident.

### Building a global catalogue

`RATMAP_REGION_FILTER` (an extended regexp over ids) splits the work up, which matters
when the whole set is a multi-day run:

```sh
RATMAP_REGION_FILTER='^(france|germany|switzerland|austria|italy)' \
  docker compose run --rm infra global regions manifest
./scripts/upload.sh
```

`upload.sh` skips archives already in the bucket at the same size, so re-running it after
each slice costs a few hundred HEAD requests rather than re-pushing everything. Set
`FORCE_UPLOAD=1` to re-push regardless.

Two numbers worth knowing before starting. The upstream archives are **134.8 GB**
(Protomaps planet, z0–15) and **705.9 GB** (Mapterhorn planet, z0–12) — measured, not
estimated — and a catalogue of region cutouts at the default ceilings adds up to a large
fraction of the first plus roughly a quarter of the second. At R2's $0.015/GB-month that
is single-digit dollars a month with free egress; the cost that bites is the days of
extraction, which is why the build is resumable at every level.

```sh
./scripts/build-region.sh lochaber --dry-run   # size it first
./scripts/build-region.sh lochaber             # extract basemap + terrain
./scripts/build-contours.sh lochaber           # contours (needs gdal)
python3 ./scripts/build-manifest.py            # regenerate regions/manifest.json
./scripts/upload.sh                            # archives, then the manifest
```

`build-manifest.py` picks up whatever artifacts exist in a region's directory, so a new
artifact kind needs no code change anywhere — that is what C16's open-ended schema buys.

`upload.sh` deliberately uploads the manifest **last**: a manifest listing artifacts that
aren't in the bucket yet would offer the user a download that 404s.

### Three guards against publishing something broken

All three exist because the corresponding failure actually happened during the Montenegro
build (2026-08-23):

- **Extraction is atomic.** `build-region.sh` extracts to `<name>.building`, runs
  `pmtiles verify`, and only then renames. An interrupted `pmtiles extract` leaves a file
  of exactly the right *size* whose header is all zeros — it looks fine in `ls` and only
  fails on "magic number not detected".
- **The manifest fails closed.** `build-manifest.py` aborts if it can't read an archive's
  PMTiles header, rather than recording `zNone-None` and carrying on. That is precisely
  what it did for the corrupt terrain file, one command away from publishing it.
- **`upload.sh` refuses to unpublish.** `dist/` is disposable scratch; one `rm -rf` and
  the next manifest silently delists every region that wasn't rebuilt, orphaning its
  archives in the bucket. The uploader diffs against the published manifest and stops.
  Override with `ALLOW_UNPUBLISH=1` when a delist is genuinely intended.

Source extracts are cached in `infra/.cache/osm` (gitignored) and downloaded with retry
and resume — Geofabrik drops connections, and a bare `curl` gave up on the first blip
partway through a 320 MB transfer. Running peaks then places re-downloads nothing.

Measured sizes (2026-08-21/22), useful for choosing maxzooms:

| Region | area | basemap | terrain | contours |
|---|---|---|---|---|
| lochaber | 0.6 sq° | z13 → 4.9 MB, z14 → 8.4 MB, **z15 → 14 MB** | z11 → 18 MB | z11–14 → 21 MB |
| switzerland | 9 sq° | z15 → 980 MB | z11 → 269 MB | untested |
| montenegro | 3.6 sq° | z15 → 113 MB | z11 → 67 MB | z11–14 → see below |
| scotland | 51 sq° | z12 → 84 MB, z13 → 175 MB | z10 → 107 MB, z11 → 340 MB, z12 → 1.1 GB | untested, expect large |

Size scales with area, so dry-run (`build-region.sh <id> --dry-run`) before committing to
a large one. Contours are the slowest step by far: the intermediate GeoJSON is roughly
300 MB per square degree before tiling.

Copernicus only publishes DEM tiles for cells containing land, so an all-ocean cell 404s.
`build-contours.sh` checks availability up front and prints which cells were skipped —
Montenegro legitimately skips N41/E018 (open Adriatic). A missing *land* tile would leave
a silent hole in the contours, so this is reported rather than left to a buried GDAL
warning.

Raster terrain grows far faster per zoom level than the vector basemap — hence the
different default ceilings (`REGION_BASEMAP_MAXZOOM`, `REGION_TERRAIN_MAXZOOM`).

**Basemap defaults to z15, not z13.** Paths carry `min_zoom: 14` in the Protomaps schema,
so a z13 cutout generalises almost all of them away — decoding a z13 tile over Ben Nevis
turned up exactly one path feature. On a walking map that is the wrong thing to drop, and
the extra detail is cheap (4.9 MB → 14 MB for Lochaber). z15 is also the source archive's
own maximum.

## Peak prominence

`build-peaks.sh` computes topographic prominence per region bbox and writes it as `prom`;
the app's zoom filter ranks on that. Needs the venv:

```sh
python3 -m venv infra/.venv && infra/.venv/bin/pip install numpy scipy
```

Why not elevation: at `ele >= 1000 m` Montenegro carries 268x Scotland's peaks per square
degree, so a threshold readable in one is an unreadable wall in the other. On prominence
the same comparison is 2.8x. It also separates a massif — Bobotov Kuk scores 1457 m
against Savin kuk's 81 m though they stand 2523 m and 2313 m.

Accuracy was checked against published figures rather than assumed: median error 19 m
across ten well-known Scottish summits, inside the 20 m quantisation step. Read
`compute-prominence.py`'s docstring before treating any value as authoritative — notably,
the highest peak in a bbox is over-ranked when the true high ground belongs to a peak
outside the OSM extract (Montenegro's box clips higher Albanian terrain).
