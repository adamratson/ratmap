# Migrating tile hosting from Cloudflare R2 to Krystal

Replaces the R2 bucket behind every `pmtiles://` and manifest fetch with the existing
Krystal (Katapult) Object Storage bucket. The app's static hosting stays on GitHub Pages —
this is only the data origin.

**Status:** Phases 0–5 complete as of 2026-08-28. The app is live against Krystal, verified
end-to-end in a real browser (basemap/terrain/peaks all 200, manifest correctly trimmed to
387 regions, zero console errors). `upload.sh` now targets Krystal via `aws s3 cp` (not
`pmtiles upload` — see that script's header comment for the SigV4 incompatibility found and
worked around). R2 is untouched and kept as the rollback window per §5 below — nothing
there has been deleted yet.

One item spun off separately, not part of this migration: commit 9d1ba06 retired
`lochaber`/`cairngorms` with no replacement, and republishing a correct (trimmed) manifest
during this cutover is what surfaced that four e2e specs now have no small region covering
Ben Nevis. Tracked as its own follow-up task, not fixed here.

---

## 0. The go/no-go probe — passed

Katapult's own S3-compatibility page lists "Bucket Cross-Origin Resource Sharing (CORS)"
under *unsupported* operations, alongside bucket and object ACLs, which read as a real risk
against C4 (a hard constraint in [docs/IMPLEMENTATION.md](../docs/IMPLEMENTATION.md)) —
this project has already been burned once by exactly this failure mode: missing `Range` in
`AllowedHeaders` or missing `ETag`/`Content-Range` in `ExposeHeaders` makes PMTiles range
reads fail in the browser while `curl` looks perfectly healthy.

"No `PutBucketCors` API" turned out to mean no *configuration* knob, not no CORS headers.
Probed directly against the live bucket (Swift/OpenStack under the hood, given the
`x-trans-id`/`x-openstack-request-id` headers) on 2026-08-27:

```
$ curl -s -H "Origin: https://example.github.io" -H "Range: bytes=0-126" -D - \
    "https://ratmap-tiles.uk-lon-1.katapultobjects.com/<file>" -o /dev/null

HTTP/2 206
accept-ranges: bytes
access-control-allow-origin: *
access-control-expose-headers: ..., etag, ..., content-type, ...
content-range: bytes 0-126/165626
```

```
$ curl -s -X OPTIONS -H "Origin: https://example.github.io" \
    -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" \
    -D - "https://ratmap-tiles.uk-lon-1.katapultobjects.com/<file>" -o /dev/null

HTTP/2 200
access-control-allow-headers: range
access-control-allow-methods: DELETE, POST, OPTIONS, PUT, GET, HEAD, COPY
access-control-allow-origin: *
```

Every C4 requirement is met, and it's fixed and unconfigurable — the bucket always emits
`Access-Control-Allow-Origin: *` on public objects, so there is no CORS policy step in
Phase 4 the way there was for R2 (SETUP.md's §3 JSON block has no Krystal equivalent —
one less manual step, and one less thing to get wrong). Proceed to Phase 1.

---

## 1. Move the data

**This must be a copy, not a rebuild.** `infra/dist/` currently holds only `regions/`
(393 MB) plus `peaks-global.pmtiles` and `places.sqlite`. The two big global archives —
`world-catalog-2026-08-21.pmtiles` and `terrain-global-2026-08-21.pmtiles` — exist *only*
in the bucket. Recreating them means re-extracting from Protomaps and Mapterhorn over
range requests against 135 GB / 706 GB upstream archives: hours of work to reproduce
bytes we already have.

`rclone` is the right tool and isn't in the toolchain yet (the pipeline uses `aws` and
`pmtiles`). Install it on the host rather than adding it to the infra image — this is a
one-off, not a pipeline stage.

```bash
rclone copy --progress --transfers 4 --checksum r2:ratmap-tiles krystal:<bucket>
```

Two remotes in `~/.config/rclone/rclone.conf`, both `type = s3`:

- `r2`: `provider = Cloudflare`, `endpoint = https://<account>.eu.r2.cloudflarestorage.com`
  (the `.eu.` is required — the bucket is jurisdiction-scoped, see `upload.sh`'s comment),
  `region = auto`.
- `krystal`: `provider = Other`, `endpoint = https://<region>.object-storage.katapult.io`,
  region and path-style per the Katapult console.

Verify before touching any code:

```bash
rclone check r2:ratmap-tiles krystal:<bucket> --size-only
```

`--size-only` rather than checksums because R2 multipart ETags are not MD5s and won't
compare — the same reason `upload.sh` uses size for its skip check.

Confirm `regions/manifest.json` came across with `Content-Type: application/json`; rclone
generally preserves it, but the app's manifest fetch is the one non-PMTiles request and a
wrong content type is a silent-ish failure.

---

## 2. Rewire the upload path

### `infra/scripts/upload.sh`

- Delete the `R2_ENDPOINT_HOST` construction and the whole `R2_JURISDICTION` mechanism —
  that's a Cloudflare-specific concept and the hard-won comment above it stops being true
  for the new provider. The lesson stays in git history.
- Replace with a single `S3_ENDPOINT` read from `.env`, plus `S3_REGION` (Katapult has a
  real region name; `AWS_DEFAULT_REGION=auto` is an R2-ism and appears three times).
- `pmtiles upload --bucket="s3://${BUCKET}?region=${S3_REGION}&endpoint=${S3_ENDPOINT}"` —
  **verify this works before trusting it.** `pmtiles upload` goes through gocloud's blob
  layer, and non-AWS endpoints often need `&s3ForcePathStyle=true` appended. Test with one
  small file both ways.
  - *Fallback if it won't talk to Katapult at all:* `aws s3 cp` with an explicit
    `--content-type application/octet-stream`. We lose nothing important —
    `pmtiles upload` is doing a multipart upload with sensible defaults, not anything
    PMTiles-specific to the wire format.
- Keep the request-checksum workaround noted in `infra/docker/README.md`
  (`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`). aws-cli v2's default CRC checksums
  break against several non-AWS S3 implementations, not just R2 — assume Katapult until
  proven otherwise.
- The unpublish guard, the size-based skip, and the manifest-last ordering are all
  provider-agnostic. Leave them exactly as they are.

Two Katapult constraints to check against the pipeline: single objects cap at **5 GB**
without multipart, and bucket create/delete is **not** available over the S3 API (web UI or
their own API only). Neither should bite — the largest region artifact is well under 5 GB
and `upload.sh` never creates buckets — but confirm the world-catalog and terrain archive
sizes before assuming.

### `infra/.env.example`

```
S3_BUCKET=<bucket>
S3_ENDPOINT=https://<region>.object-storage.katapult.io
S3_REGION=<region>
PUBLIC_BASE_URL=https://tiles.<domain>
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

`R2_JURISDICTION` goes away entirely. Update your own `infra/.env` at the same time —
it's gitignored, so nothing will remind you.

### `infra/docker/compose.yml`

One comment reads "R2 credentials for upload.sh". The `env_file` mechanism itself is
unchanged.

---

## 3. Rewire the app read path

The provider name is baked into an exported symbol and a public env var, so this is a
rename as well as a value change. Do it as its own commit — mechanical, separately
reviewable, and it keeps the risky parts of the migration legible in `git log`.

| File | Change |
|---|---|
| [src/config.ts](../src/config.ts) | `R2_BASE_URL` → `TILES_BASE_URL`; `VITE_R2_BASE_URL` → `VITE_TILES_BASE_URL`; new default URL; rewrite the header comment (it currently explains the `.r2.dev` rate limit and the Phase 3 custom-domain swap, both obsolete) |
| [src/vite-env.d.ts](../src/vite-env.d.ts) | rename the declared var |
| [src/regions/manifest.ts](../src/regions/manifest.ts) | import + two use sites |
| [src/config.test.ts](../src/config.test.ts) | var list, and two test names that say "R2 bucket" |
| [e2e/helpers.ts](../e2e/helpers.ts) | two comments about `.r2.dev` being rate-limited — the new failure mode is egress quota, not rate limiting |

**The production URL comes from the `src/config.ts` default, not from CI.**
[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) injects no `VITE_*` at all,
so whatever is hardcoded there is what ships. Change the default. (Adding a repo variable
instead would be more flexible and less greppable — not worth it for a value that changes
once.)

Point it at the **custom domain**, not a raw bucket URL. Katapult issues a free Let's
Encrypt cert on custom domains, and a domain you control is what makes a future provider
change a DNS edit instead of another one of these plans. This also means the domain
decision blocks Phase 3 — pick the hostname before starting it.

---

## 4. Docs

- [infra/SETUP.md](../infra/SETUP.md) — full rewrite. Every section is Cloudflare-specific:
  the jurisdiction trap, the `.r2.dev` public dev URL, the CORS Policy JSON, the R2 API
  token screen. The CORS step drops out entirely — Krystal's bucket emits a fixed
  `Access-Control-Allow-Origin: *` with no configuration surface (confirmed §0) — but keep
  a short C4 note pointing at the Phase 5 acceptance check anyway, so a future bucket or
  provider swap doesn't silently lose the one check that catches this failure mode.
- [infra/README.md](../infra/README.md) — the Upload section's R2 mention, and the "Verify
  (C4 acceptance check)" section. Preserve the "Verified end-to-end 2026-08-21" note but
  re-date it after Phase 5; a stale verification claim is worse than none.
- [docs/IMPLEMENTATION.md](../docs/IMPLEMENTATION.md) — C4 and C15 both name R2 by
  provider, and §3's architecture diagram opens with `R2 bucket (CORS: ...)`. C4's
  *rationale* is unchanged and still correct; only the provider noun moves.

---

## 5. Cutover and verification

Do not delete anything from R2 until this passes.

1. Run the C4 acceptance check from `infra/README.md` against the new base URL, with an
   `Origin` header (a bare `curl` proves nothing here).
2. Load the app in a real browser and confirm basemap, hillshade and peaks render —
   browsers enforce CORS on range requests where `curl` doesn't. Console must be clean.
3. Run the e2e suite, especially the region-download path — it exercises the manifest
   fetch and a full multi-hundred-MB artifact download, which is the traffic pattern that
   actually costs money now.
4. Re-check `Content-Type` on `regions/manifest.json` as served.
5. Leave the R2 bucket in place for ~2 weeks. `VITE_TILES_BASE_URL` in a local `.env.local`
   is the instant rollback lever; a full rollback is reverting the Phase 3 commit.
6. Then delete the R2 bucket and remove the Cloudflare payment method if nothing else uses
   the account.

---

## What gets worse, and it's worth being honest about it

**Egress stops being free.** This is the real cost of the move. R2 charges nothing for
egress; Krystal includes 1 TB/month at £5 and bills £0.02/GB beyond. A single Lochaber
download is ~54 MB today, but region artifacts are budgeted far larger — at ~350 MB per
region download, 1 TB is roughly **2,900 downloads a month** before overage. That's
comfortable for a personal project and ruinous if the app gets a good week on Hacker News.
Decide now whether you want a spend cap or an alert, because the failure mode is a bill,
not a 429.

**No CDN.** R2 on a custom domain sits behind Cloudflare's edge. Krystal serves from a UK
data centre with no edge cache. For a Scottish hiking map with a UK audience this is
probably *faster*, not slower — but a user in Australia downloading a region will feel it,
and the world-catalog/terrain archives are fetched by every user on every cold load.

**Smaller blast radius for support.** No jurisdiction traps, no `.r2.dev` rate limiting, no
Cloudflare dashboard archaeology. UK-hours human support instead. That's a genuine gain.

---

## Open decisions

1. **Custom domain hostname** — blocks Phase 3. Needs to exist in DNS before the cutover.
2. **Keep R2 as a mirror?** Storage there is a rounding error at catalog-only scale, and
   it would give `VITE_TILES_BASE_URL` a real failover target. Costs one extra
   `rclone copy` per data refresh.
3. **Egress alerting** — whether to set anything up before cutover or accept the risk.
