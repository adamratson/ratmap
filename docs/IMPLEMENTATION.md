# OSM Summit Map — PWA Implementation Spec

**Audience: the implementing agent.** Read *Hard constraints* before writing any code.
Each one exists because the obvious approach fails, usually silently.

**Where this file belongs:** the app repo, at `docs/IMPLEMENTATION.md`, with `CLAUDE.md`
pointing at it. (Original copy: `plans/harmonic-booping-sprout.md`.)

**Product:** offline-first OpenStreetMap mountain map, delivered as an installable PWA for
iOS and Android. Map viewer → offline region download → hiking/cycling route planner with
GPX. Not turn-by-turn navigation, not background track recording (see §7).

**Why PWA over native:** MapLibre GL JS is the reference implementation and ahead of
Native; PMTiles in a browser is the format's native habitat; `queryTerrainElevation`
exists in GL JS and *not* in the React Native binding, which deletes the hardest deferred
problem outright. No App Store review, no $99/yr, no native modules. The tradeoff is no
background geolocation and no background downloads — accepted, see §7.

---

## 1. Hard constraints

| # | Constraint | Why |
|---|---|---|
| C1 | **Call `navigator.storage.persist()` at startup and verify with `persisted()`. Refuse to start a region download if it returns false** — explain why instead. | Default storage is best-effort and evictable. Persistent mode is *excluded from eviction*. Never let a user believe they have offline maps they don't — they find out with no signal, on a mountain. |
| C2 | **Installation gates persistence on both platforms — drive it in onboarding.** Detect standalone via `display-mode: standalone`. On **iOS** hand-hold Share → Add to Home Screen; on **Android** capture `beforeinstallprompt` and offer a real install button. | Both engines key `persist()` on installation: WebKit grants it "based on heuristics like whether the website is opened as a Home Screen Web App", and Chromium's heuristic counts PWA installation plus engagement. Install is not just discovery — it *gates the storage guarantee*. Only iOS lacks `beforeinstallprompt`, so only iOS needs the manual walkthrough. |
| C3 | **Every PMTiles artifact must have a globally unique filename.** | `FileSource.getKey()` returns `file.name`, and that key is how `Protocol.add()` registers the archive. Two regions each shipping `basemap.pmtiles` collide and silently serve the wrong region's tiles. Use `<region>-basemap.pmtiles`. |
| C4 | **Configure CORS on the R2 bucket: allow the `Range` request header, expose `ETag` and `Content-Range`.** | Unlike a native app, a browser enforces CORS on range requests. Without exposed `ETag`, the pmtiles library cannot do its archive-consistency check. Classic silent failure — tiles just never load. |
| C5 | **Store `.pmtiles` archives in OPFS, not the service-worker Cache API.** Keep the SW cache for the app shell only. | Cache API has a much smaller effective quota; OPFS gives real random-access file handles, which is what range reads need. |
| C6 | **Do not expect an elevation value on Protomaps peaks.** | Schema v4 puts peaks in `pois` as `kind=peak` with `kind`, `cuisine`, `religion`, `sport`, `iata` — no `ele`. (v2's `physical_point` had it; that layer is gone.) Use our own `peaks.pmtiles`. |
| C7 | **Bundle glyphs and sprites locally.** | They load from URLs independent of the tile archive. Left remote, the offline map renders geometry with no labels and no icons. |
| C8 | **No tile server, no Worker, no runtime compute for tiles.** | PMTiles is read by HTTP range request straight from static storage. |
| C9 | **No geocoding API.** Search is a local SQLite FTS5 index via `sql.js`/`wa-sqlite`, or an IndexedDB inverted index. | Works offline, no key or quota, queries never leave the device. |
| C10 | **Persist routes as complete coordinate arrays, never a server-side route ID.** | A saved route must render with the network permanently off. |
| C11 | **Waypoint placement must not require a successful network snap.** | If a waypoint only commits after `/trace_route`, offline editing becomes impossible. Allow unsnapped waypoints with deferred snapping. |
| C12 | **Baseline: region downloads are resumable, chunked, and hold a Screen Wake Lock while running. Enhancement: use the Background Fetch API where available.** Build the baseline first; the enhancement is strictly optional and must not be a second code path of equal weight. | iOS has no Background Fetch or Background Sync, so a multi-GB download only progresses in the foreground and *will* be interrupted — the resumable baseline is mandatory. Chromium on Android **does** support Background Fetch, letting a download survive app close with browser-provided progress and cancel UI. Detect, don't assume. |
| C13 | **Pin the Protomaps basemap build version.** Never track `latest`. | A schema bump between v2 and v4 silently removed `ele`. Treat their schema as a dependency that breaks. |
| C14 | **Never generate tiles in the browser.** | Valhalla tile builds need ~600 GB scratch, up to ~1.6 TB with elevation. Contours likewise. Build offline, ship the output. |
| C15 | **Do not hotlink Protomaps or Mapterhorn buckets in production.** | Both explicitly ask users to copy to their own storage. Extract regions into our bucket. |
| C16 | **The region manifest schema is versioned and open-ended** — a region is "a set of named artifacts". | So routing tiles are an additive artifact later, not a migration. |
| C17 | **`maplibregl.addProtocol` should be called exactly once in the app lifecycle.** | Documented library guidance; repeated registration causes subtle cache and handler issues. |

---

## 2. Evidence status

### Verified directly (this session)

| Claim | How |
|---|---|
| PMTiles serves from static storage with no tile server | `curl -H "Range: bytes=0-126"` against a live public archive → HTTP **206**, `accept-ranges: bytes`, 127 bytes, magic `PMTiles`, spec v3 |
| `FileSource` does lazy range reads from a browser `File` | Read `js/src/index.ts` — `getBytes()` is `file.slice(offset, offset+length)` then `.arrayBuffer()` |
| `FileSource.getKey()` returns `file.name` → **C3** | Same file |
| `Protocol` exposes `add(p: PMTiles)` / `get(url)` to register preloaded archives | Read `js/src/adapters.ts` |
| Home Screen web apps get **browser-tier** quota: origin up to 60% of disk, overall up to 80% (non-browser apps get 15%/20%) | WebKit storage policy |
| `persist()` granted heuristically, keyed on Home Screen install; persistent mode excluded from eviction → **C1, C2** | WebKit storage policy |
| Protomaps v4 `pois` has `kind=peak`, no `ele` | Read v2 and v4 schema docs |
| Mapterhorn planet terrain ≈ 706 GB, terrarium-encoded WebP from Copernicus DEM 30 m, as PMTiles | `content-length: 705886514815` + project docs |

### Documented upstream, not tested here

- Storage API fully supported from Safari 17 / iOS 17.
- No Background Fetch or Background Sync on iOS → **C12**.
- Background Fetch **is** supported on Chromium (Android + desktop), not in WebView →
  **C12** enhancement path.
- Chromium grants `persist()` silently via heuristic — PWA installation and engagement are
  the criteria; it is silently *denied*, never prompted → **C1, C2**.
- Firefox behaves differently again: it *prompts* the user for persistence rather than
  deciding heuristically. Treat as a third behaviour, not a Chromium clone.
- **No background geolocation on any platform**, Android included → §7.
- Screen Wake Lock supported from Safari 16.4.
- `map.setTerrain({source, exaggeration})` and hillshade layers work off a `raster-dem`
  source; custom protocols can feed DEM sources.

### Must spike before relying on (Phase 0)

1. **`raster-dem` fed by `pmtiles://` carrying WebP terrarium tiles**, rendering hillshade
   *and* `setTerrain` in **iOS Safari specifically**. Least-proven link in the chain.
   ✅ **Confirmed** (2026-08-21, real iPhone, corrected renderer): `usgs-mt-whitney-8-15-webp-512.pmtiles`
   loaded via the OPFS spike (OPFS → FileSource → Protocol.add() → `raster-dem` source,
   `encoding: 'terrarium'`) renders real, correctly-decoded relief shading. (First attempt
   the same day, before the spike drew a proper `hillshade` layer, gave a false positive —
   see git history / earlier revision of this doc for that trail. Left out here since the
   corrected result supersedes it.)
   Not yet covered: `setTerrain`/3D specifically (only 2D hillshade was tested), and this
   was tested from the OPFS spike, not the main map's own terrain source — closing this
   fully means our real `terrain-global.pmtiles` (Phase 1) gets the same test.
2. **OPFS → `getFile()` → `FileSource` → `Protocol.add()`** serving a local archive, and
   how it behaves after the app is backgrounded and resumed.
   ✅ **Confirmed** (2026-08-21, real iPhone): loaded via the OPFS spike picker, backgrounded
   the app, resumed — archive stayed registered and rendered. Not yet stress-tested (long
   background duration, OS memory pressure evicting the tab, multiple archives at once).
3. **`persist()` actually granted** on a real iOS device once installed to Home Screen,
   and observed retention past 7 days of no use.
   ⚠️ **Partially confirmed**: granted on install (2026-08-21). 7-day retention check still
   outstanding — re-open without touching it before 2026-08-28 and recheck the status
   banner.
4. Sustained OPFS write throughput for a multi-GB download on a mid-range phone.
   ⚠️ **Weak signal only**: 471 MB/s on a small (single-digit MB) test file (2026-08-21,
   real iPhone). That's a burst write, not sustained — flash write speed on phones commonly
   degrades over a multi-GB transfer as any write cache fills. Not representative until
   tested with a file in the hundreds of MB to low GB range.

**The Phase 0 OPFS spike harness (the "pick a local .pmtiles file" picker) was removed on
2026-08-23.** It existed to prove items 2 and 4 above before a real downloader existed;
Phase 3's region downloader now does the same OPFS → `FileSource` → `Protocol.add()` path
for real, at size, with resume — and is covered by the Playwright suite. Leaving debug
scaffolding in the shipping UI was just clutter. The spike results recorded above stand;
re-running them now means downloading a region.

If (1) fails, fall back to AWS Open Data terrain tiles
(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) for online
hillshade and accept that offline terrain needs a different encoding.

---

## 3. Architecture

**Everything is a static file.** One R2 bucket (CORS per C4; custom domain deferred to
Phase 6 — R2's own `*.r2.dev` public bucket URL is fine through Phase 1/2 dev), plus
static app hosting. **Deployed:** GitHub Pages at `<user>.github.io/ratmap`, not the
Cloudflare Pages this section originally named — decided during Phase 0, no material
difference to this architecture (still static hosting, still zero compute). Zero runtime
compute through Phase 3.

**§8.2 resolved: catalog-only**, not full planet (2026-08-21). No `planet-<version>.pmtiles`.
Instead a small low-zoom world extract for "pan anywhere at low detail," plus regions built
on demand (Phase 3). Cuts R2 storage from ~120 GB/~$3/month to a rounding error; the
tradeoff is panning outside a downloaded region shows nothing useful above the low zoom cap
until that region is extracted.

```
R2 bucket (CORS: allow Range, expose ETag + Content-Range)
├─ world-catalog-<version>.pmtiles Protomaps basemap, low-zoom extract, pinned (C13)
├─ terrain-global.pmtiles          coarse, pmtiles extract from Mapterhorn
├─ peaks-global.pmtiles            ours: natural=peak|volcano|saddle + ele
├─ regions/manifest.json           versioned, open-ended artifact list  (C16)
└─ regions/<id>/<id>-{basemap,terrain,contours}.pmtiles   unique names  (C3)

app (static, service worker)
├─ SW cache:  app shell only                                            (C5)
└─ OPFS:      downloaded region archives + places index                 (C5)
```

**Central module: `TileSourceRegistry`.** Owns which archive backs each style source, and
is the only place `Protocol.add()` is called. Remote archives use `FetchSource` via a
`pmtiles://https://…` URL; local archives are `new PMTiles(new FileSource(await handle.getFile()))`
registered under a unique key (C3). Basemap, terrain and contours all route through it.
Build in Phase 2; every later phase reuses it.

**Runtime servers: zero through Phase 3.** Valhalla appears in Phase 4 for route
computation only.

---

## 4. Phases

### Phase 0 — Foundations (days, not weeks)

No Xcode, no CocoaPods, no Android SDK, no simulators. Verified present: Node v25.9.0,
npm 11.12.1.

1. Vite + TypeScript + `maplibre-gl` + `pmtiles` + `vite-plugin-pwa` (Workbox). Web app
   manifest with `display: standalone`, icons, and iOS meta tags.
2. Static hosting on Cloudflare Pages; custom domain. **HTTPS is mandatory** — service
   workers, OPFS and geolocation all require a secure context.
3. Run the four spikes in §2 **on a real iPhone, not the simulator or desktop Safari** —
   storage policy and Wake Lock behaviour differ.

**Acceptance:** an installed Home Screen web app on a physical iPhone renders a remote
`pmtiles://` basemap with hillshade, and `navigator.storage.persisted()` returns true.

### Phase 1 — Tile and data infrastructure

Separate repo or `infra/`. Scripted and re-runnable on data refresh. **Identical to the
native plan except for CORS.**

- R2 bucket, **no custom domain yet** (use the bucket's `*.r2.dev` URL — Phase 6 swaps in
  a custom domain), **no Worker**, CORS per C4.
- **Catalog-only (§8.2, decided 2026-08-21):** `pmtiles extract` a low-zoom-capped world
  cutout from a pinned Protomaps published build — not the full ~120 GB planet. Full
  per-region detail comes from Phase 3's on-demand extracts, not this file.
- `peaks-global.pmtiles`: OSM extract → filter `natural=peak`, `natural=volcano`,
  `natural=saddle`, `mountain_pass=yes` → keep `name`, `ele`, `prominence`, `wikidata` →
  `tippecanoe`. Prefer OSM's surveyed `ele` over DEM sampling; it matches signage. Drive
  low-zoom filtering off `ele` thresholds with `wikidata` presence as a notability proxy
  (`prominence` is too sparsely tagged).
- `terrain-global.pmtiles`: coarse `pmtiles extract` from Mapterhorn, run against the
  remote archive over range requests — no 706 GB download.
- `places.sqlite`: FTS5 over `place=city|town|village|hamlet|suburb` joined with peaks.
- Fork the Protomaps style into the repo — we rewrite `glyphs`/`sprite` URLs per
  environment anyway.
- Vendor glyphs + sprites (C7).

**Acceptance:** `curl -H "Range: …"` against the custom domain returns 206 with correct
bytes, **and a cross-origin `fetch` with a `Range` header from the app origin succeeds
with `ETag` readable**. Pipeline asserts known elevations — Ben Nevis 1345, Mont Blanc
4808 — so a schema regression fails CI, not the device.

### Phase 2 — MVP

- Map screen: pan/zoom/rotate/pitch, MapLibre GL JS.
- **`TileSourceRegistry`** (§3). Structural — do not defer.
- **Storage bootstrap**: request `persist()`, surface state in UI, gate downloads (C1).
- **Install onboarding**: detect iOS + non-standalone, walk the user through Share → Add
  to Home Screen, explaining that offline maps depend on it (C2).
- Hillshade from the terrain archive; optionally `setTerrain` for 3D.
- Summits: peaks overlay with name + elevation labels, tap for detail sheet.
- Location: `watchPosition`, user dot, follow mode. Foreground only — say so in the UI.
- Search: local FTS5, prefix match ranked by distance from viewport. Place and peak names
  only, not addresses (C9).
- Saved places: IndexedDB.
- **Attribution UI — legally required.** Visible "OpenStreetMap" credit, tappable, links
  to `openstreetmap.org/copyright`, makes ODbL discoverable, **not auto-hidden without
  user action**.
- Offline app shell via service worker, so a cold start with no network still boots.

**Acceptance:** installed to Home Screen, Airplane Mode, force-quit and relaunch → app
shell boots, map renders labelled tiles, summits show names and heights, search returns
results. Same on Android Chrome.

**Status (2026-08-21): built, desktop-verified.** Every bullet above is implemented and
checked in a real browser (headless Chromium against the production build). Notes:

- **Search uses `@sqlite.org/sqlite-wasm`, not `sql.js`** as this doc suggested. sql.js
  ships FTS3 only — `USING fts5` fails at runtime with "no such module: fts5", confirmed
  against its compile options. The official build has `ENABLE_FTS5`. It is deserialized
  in-memory rather than via the OPFS VFS, because that VFS wants SharedArrayBuffer, which
  needs COOP/COEP headers, which GitHub Pages cannot set.
- **`places.sqlite` ships in `public/`** and is service-worker precached, rather than
  living in OPFS as §3 describes. That is what makes search work on a cold offline start
  *before* any region download exists. Phase 3 should move it to OPFS per region and leave
  this as the no-region-yet fallback.
- **Offline tile rendering is not durably solved yet, and cannot be until Phase 3.** In the
  offline cold-start test the basemap did render labelled tiles — but from the browser's
  ordinary HTTP cache, which is evictable and not a guarantee. Hillshade and peaks did not
  render at all. Genuine offline tiles require the OPFS region downloader (C5, C12). Treat
  the tile half of this acceptance criterion as *pending Phase 3*, not met.
- Still to verify **on a real device**: this was all checked on desktop. The iPhone run
  (installed to Home Screen, Airplane Mode, force-quit, relaunch) and the Android Chrome
  equivalent have not been done.

### Phase 3 — Offline regions

- Build pipeline (offline, not a service): `pmtiles extract` per region → R2, plus a
  static versioned manifest of name, bbox, per-artifact size, build date (C16). Unique
  filenames (C3).
- Terrain per region needs **no generation** — an extract from Mapterhorn.
- Contours per region: `gdal_contour` over Copernicus GLO-30 → `tippecanoe`. Carry `ele`
  per line; tag index contours (every 5th) at generation time. **Fine-interval global
  contours are hundreds of GB — never build them.** Coarse 100 m global is optional.
- App: chunked resumable downloader writing into OPFS, with Wake Lock, progress, storage
  accounting, delete (C12). Re-register archives with `TileSourceRegistry` on completion.
- Show `estimate()` vs region size before starting; refuse if it won't fit.

**Acceptance:** download a region, force-quit, Airplane Mode, relaunch → pan at full zoom
with hillshade and contours rendering entirely from OPFS. Kill the app mid-download and
confirm it resumes rather than restarting.

**Status (2026-08-23): built and desktop-verified, contours included.**

Verified end-to-end in headless Chromium against the production build, using a small test
region (`lochaber`, 44.1 MB — basemap z13 + terrain z11 + contours z11–14):

- Download → all three artifacts land in OPFS at exactly their manifest sizes.
- Offline cold relaunch → region renders **from OPFS at hiking zoom with no network**:
  legible contours, streams, and named climbing features on Ben Nevis's north face
  (Tower Gully, The Comb, North East Buttress) at a 200 m scale bar. The detail-limit
  notice correctly stops showing, because region data now exists at that zoom.
- Interrupt mid-download → 16.7 MB partial retained, the button becomes **Resume**, and
  resuming completes rather than restarting.
- The **C1 gate genuinely blocks**: with persistence denied the download refuses and
  explains why. Confirmed by observing the refusal — headless Chromium will not grant
  `persist()` (no site-engagement/install heuristic, and CDP `Browser.grantPermissions`
  `durableStorage` reports success but changes nothing), so the *downloader itself* was
  exercised with persistence stubbed in the harness.

**Contours** come from Copernicus GLO-30 read as COG through GDAL's `/vsicurl`, so only
the region's bbox is fetched rather than the global DEM. 10 m interval with every 5th
(50 m) tagged as an index contour at generation time. Adding them required **no app
change** — the manifest, downloader and layer code all iterate declared artifacts, which
is exactly what C16 exists to buy.

Seven real bugs found and fixed during verification:

- Every failed tile posted its own status card, so going offline buried the map behind
  dozens of identical banners. Errors are now deduplicated with a repeat count, and an
  offline map reports once, plainly, instead of shouting per tile.
- Interrupted writes stranded Chromium writable swap files (`<name>.N.crswap`) in OPFS —
  6.4 MB leaked from a single cancelled download, silently consuming the storage this
  feature exists to manage. Now aborted rather than closed on error, plus a sweep for
  files stranded by a page teardown we don't control.
- The offline banner keyed off `navigator.onLine`, which reported `true` on a fully
  offline map, so the wrong message showed. It now keys off the fetch failure itself —
  `navigator.onLine` reports the OS link state, not whether requests succeed, so it also
  lies behind a captive portal or a dead uplink, which is this app's whole situation.
- **Downloading a region turned the rest of the map grey.** Protomaps' `layers()` emits a
  viewport-filling `background` layer; the region code copied all 71 layers, so each
  region added its own background and painted flat `#cccccc` over the entire global map.
  Region layers are now restricted to source-bound ones — a style needs exactly one
  background, and the global basemap already supplies it.
- **Hillshade painted over the labels.** Every region artifact was inserted at the peaks
  layer, which stacks each on top of the last; artifacts load basemap → contours →
  terrain, so relief ended up above the basemap's own labels and washed out the gully and
  corrie names. Relief and contours now insert beneath the region's *own* first label
  layer — region-scoped deliberately, since targeting the first label in the whole style
  would bury the relief under the region's opaque fills instead.
- **Index contours were never emphasised.** `build-contours.sh` tags them via SQLite,
  which emits an integer `0/1` under the alias `idx`; the style read `index` compared to
  `true`, matching neither the name nor the type, so every contour silently drew at the
  thin weight. Caught by reading the published tiles' own metadata rather than trusting
  the code.
- **Paths were effectively invisible** — both a data and a styling problem. Protomaps tags
  paths with `min_zoom: 14`, so the region basemap's z13 ceiling generalised nearly all of
  them away (decoding a z13 tile over Ben Nevis found exactly one path feature); and the
  `light` flavour draws what remains as a 0.5 px `#ebebeb` hairline on a near-white
  background. Region basemaps now build to z15 (4.9 MB → 14 MB for Lochaber, and z15 is
  the source archive's own maximum), and paths get a dedicated cased, dashed layer with
  tracks drawn solid and heavier than footpaths. On a walking map the paths are the single
  most important feature on the sheet.

Still open:

- **On-device verification has still never been run** (iPhone install → Airplane Mode →
  force-quit → relaunch; Android Chrome equivalent). Everything above is desktop.
- Only `lochaber` is published. `cairngorms` and `scotland` are defined in
  `infra/regions.json` but not built or uploaded. Scotland-scale contours are untested and
  will be far larger — Lochaber alone is 21 MB for a 1°×0.6° box.
- Contour interval/styling and the hillshade fade at high zoom are defensible defaults,
  **not** the cartographic decision §8.3 still asks for.

The manifest now records each artifact's real `minzoom`/`maxzoom`, read from its PMTiles
header at build time. The app derives its detail ceiling from that rather than a hardcoded
constant, which had drifted from the pipeline and made the "limited detail" notice fire
over a fully-downloaded region — a warning that cries wolf is worse than none.

There is a Playwright suite (`npm run test:e2e`) covering the download path, offline cold
start, and each of the regressions above; it runs against the production build via
`vite preview`, so service workers, precaching and the `/ratmap/` base path are real.

### Phase 4 — Route planning

- Engine: **Valhalla** behind an async cancellable interface. Hosted or small VPS.
- `/route` with `pedestrian` / `bicycle` costing.
- `/trace_route` for snap-to-path (C11 — snapping deferred, not required).
- **Elevation profile computed locally via `map.queryTerrainElevation()`** against the
  terrain source, with total ascent/descent. This works offline — no `/height` call, no
  server round-trip. *This is the capability the React Native binding lacks.*
- Tap to add waypoint, drag to reroute, insert mid-route, undo.
- Local-first persistence (C10), then GPX + GeoJSON import/export, and Web Share API.

**Offline route *following* ships in this phase** and needs no engine: view saved routes
offline, follow against the GPS dot, off-route distance, GPX import. Foreground only.

**Acceptance:** plan a route online, Airplane Mode, view and follow it over an offline
region with a working elevation profile.

### Phase 5 — Deferred

Much smaller than the native plan — offline elevation and 3D terrain are already done.

- **Offline routing.** The one genuinely hard remaining item. Valhalla tiles per region
  plus a WASM build; immature. Routing tiles rival or exceed the basemap per region
  (Germany ~4.6 GB), so opt-in with per-artifact sizes shown.
- **Trail rendering** — if Protomaps path coverage is inadequate at high zoom, custom
  `tippecanoe` from OSM extracts. Verify coverage during Phase 1.

### Phase 6 — Launch

Small, compared to the native path — no review, no store, no privacy manifest.

- Deploy to production domain; verify the manifest, icons and iOS splash screens.
- Lighthouse PWA audit clean.
- Verify update flow: a new SW version must not strand a user mid-download.

**Acceptance:** a stranger can reach the URL, install it, and use it offline.

**Carried into this phase from earlier work:**

- App icons are **placeholders** generated in Phase 0 (`scripts/gen-placeholder-icons.py`)
  — a flat triangle, no real design. They become the app's face on a home screen.
- **No iOS splash screens exist** (`apple-touch-startup-image`), so an installed iOS app
  shows a blank screen while booting.
- The R2 bucket is on its rate-limited `*.r2.dev` development URL, which Cloudflare
  explicitly says is not for production traffic. A custom domain fixes that and §8.1
  together.
- On-device verification (iPhone Home Screen install + Airplane Mode + force-quit;
  Android Chrome equivalent) has still never been run — everything so far is desktop.

---

## 5. Cost

| Item | Cost |
|---|---|
| Cloudflare R2 (~120 GB planet) | ~$3 / month, no egress fees |
| Cloudflare Pages hosting | Free tier |
| Domain | ~$10–15 / year |
| Workers / search / app stores | $0 — not used |
| Valhalla (Phase 4 only) | Hosted free tier or small VPS |

**~$3/month plus a domain, with zero compute.** No $99/yr Apple fee, no $25 Play fee.
Cost tracks stored bytes, not users.

---

## 6. What changed from the native plan

Kept, unchanged: the entire tile/data infrastructure, the peaks overlay, contours,
Mapterhorn terrain, the serverless posture, and the routing engine choice.

| Native constraint | Fate |
|---|---|
| Never use `offlineManager.createPack()` | **Gone** — no such API in GL JS |
| Never read PMTiles from Android assets | **Gone** — OPFS handles local archives on both platforms |
| Always fully specify the URL inside `pmtiles://` | **Gone** |
| Declare hillshade in style JSON, not `<Layer>` | **Inverted** — GL JS takes hillshade layers at runtime |
| Offline elevation queries are hard (deferred) | **Gone** — `queryTerrainElevation` works offline |
| `isExcludedFromBackup` on iOS | **Gone** — no iOS filesystem |
| App Store review, 4.2 risk, privacy manifest, TestFlight, 12-testers/14-days | **Gone** |

New in exchange: storage persistence (C1), install-gates-persistence (C2), filename
collisions (C3), CORS (C4), OPFS vs SW cache (C5), foreground-only downloads (C12).

---

## 7. Accepted limitations

State these plainly in the product, not just here.

- **No background geolocation — on either platform.** Cannot record a track with the phone
  pocketed and screen off. Following a route means app foregrounded and screen on. There is
  no Web API for this on any platform; Android does not rescue it. This is a capability
  that does not exist, not a workaround gap.
- **No background downloads on iOS.** Region downloads only progress in the foreground
  there. Android gets Background Fetch (C12).
- **iOS install friction.** No install prompt; Share → Add to Home Screen manually — and it
  gates persistence (C2). Android has a real install button.

### Platform matrix

Android is the stronger platform throughout. Where behaviour differs, iOS is the
constraint that shapes the design — build for iOS, enhance for Android.

| Capability | iOS Safari | Android Chromium |
|---|---|---|
| MapLibre GL JS, PMTiles, OPFS | ✅ | ✅ |
| Storage quota (installed) | up to 60% origin / 80% overall | comparable, disk-proportional |
| `persist()` | heuristic, keyed on Home Screen install | heuristic, keyed on install + engagement |
| Install prompt | ❌ manual Share → Add to Home Screen | ✅ `beforeinstallprompt` |
| Background Fetch | ❌ | ✅ |
| Background Sync | ❌ | ✅ |
| **Background geolocation** | ❌ | ❌ |
| Store distribution without rewrite | ❌ needs Capacitor | ✅ TWA via Bubblewrap |

Two consequences worth internalising: **nothing platform-specific is required for the core
product** — every capability the app depends on exists on both. And the *only* hard
limitation that survives on both is background geolocation, which is precisely why this is
scoped as a route planner rather than a track recorder.

**Escape hatch — do not design against it, but know it exists.** The two platforms offer
asymmetric exits. On **Android**, a TWA built with Bubblewrap puts this exact PWA on the
Play Store with no code change. On **iOS**, and for background geolocation on either
platform, wrap the same web codebase in **Capacitor**: native plugins plus store
distribution, still no rewrite. The cost is re-acquiring the native build and review
overhead. Nothing in this spec forecloses
it — which is why C10 and C11 are still here even though nothing in the PWA path needs
them yet.

---

## 8. Open decisions — ask Adam, do not guess

1. **App name:** `ratmap` (decided Phase 0). **Domain:** still open, but no longer blocking
   — app hosting uses GitHub Pages' free subdomain, R2 uses `*.r2.dev`. Revisit at Phase 6.
2. ~~Planet or catalog-only?~~ **Decided 2026-08-21: catalog-only.** Low-zoom world extract
   plus on-demand regions (Phase 3), not the ~120 GB planet. See §3.
3. Contour interval and styling — needs a cartographic call on real target regions.
   **Partly resolved 2026-08-23:** peak *selection* no longer needs per-region tuning.
   It ranks on topographic prominence computed from the DEM at build time
   (`infra/scripts/compute-prominence.py`) rather than absolute elevation, which encoded
   an assumption about Scottish terrain — at `ele >= 1000` Montenegro carried 268x
   Scotland's peaks per square degree; on prominence the same figure is 2.8x, which is a
   real difference in the terrain rather than an artefact. Validated against ten published
   Scottish prominences at 19 m median error. Contour interval, path styling and the exact
   zoom thresholds (600/300/120/30 m at z9/11/13/15) remain judgement calls, not decisions.
4. Street-level address search — currently out of scope; would ship per-region.
5. Accounts/sync — currently none, all local.
