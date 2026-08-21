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
```

All three were run for real during Phase 1 development (2026-08-21) against small/coarse
inputs to verify the commands are actually correct, not just plausible — see the comments
at the top of each script for what was verified and the exact numbers.

**`build-peaks.sh` defaults to one small region (Scotland)**, not a global run — see the
comment in that script for how to point it at a global source. That's a much bigger
download (tens of GB); don't kick it off by accident.

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

Then load that URL as a `pmtiles://` source in the app (`VITE_DEMO_BASEMAP_PMTILES_URL` in
the repo-root `.env.local`, see `src/config.ts`) and confirm it renders — a browser enforces
CORS on range requests where `curl` doesn't, so a clean `curl` result alone proves nothing.

**Verified end-to-end 2026-08-21**: all three artifacts uploaded, preflight + ranged GET
return the headers above, and the app rendered the R2-hosted world catalog in a real
browser (206s, no console errors). `.env.local` is pointed at the bucket already.

## Not yet built

- `places.sqlite` (FTS5 place/peak search index)
- Forked Protomaps style as a static JSON artifact (the app currently generates its style
  at runtime via the `@protomaps/basemaps` package — see `src/main.ts`)
- Elevation regression assertions (Ben Nevis 1345, Mont Blanc 4808) as an actual CI check,
  not just something proven manually once
