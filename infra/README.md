# infra

Phase 1 tile/data pipeline (see `../docs/IMPLEMENTATION.md` §4 Phase 1). Scripted and
re-runnable on data refresh — nothing here is a one-off manual process except the R2
bucket itself (`SETUP.md`, needs your Cloudflare account).

## Prerequisites

```sh
brew install tippecanoe pmtiles osmium-tool
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

**`build-peaks.sh` and `build-places.sh` default to one small region (Scotland)**, not a
global run — see the comment in `build-peaks.sh` for how to point them at global sources.
That's a much bigger download (tens of GB); don't kick it off by accident.

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
- A global (rather than Scotland-only) peaks/places build
