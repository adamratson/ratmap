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
| C18 | **Persist a bagged summit as a self-contained record — name, coordinates, elevation, list id, date — never as a bare OSM node id.** Keep the id as a *join hint* for re-matching, not as the record. | Same failure as C10. OSM nodes get deleted, re-created with a new id, or moved when a survey corrects them; a peaks rebuild then silently empties someone's log of twenty years of hillwalking. Irreplaceable user data must not depend on a foreign key we do not control. |
| C19 | **Derive editorial list membership from CC0/ODbL sources (Wikidata, OSM tags) only. Never transcribe a publisher's table**, and carry per-list source and licence in the artifact. | Individual heights are facts, but a *curated selection* is exactly what UK/EU sui generis database right protects, and the Wainwrights are the selection of an in-copyright work. Attribution is already a hard requirement here for ODbL (Phase 2); a bagging list is the second place we ship someone else's data. |

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

**Runtime servers: zero. Full stop.** This originally read "zero through Phase 3", with
Valhalla arriving in Phase 4 for route computation. That is no longer true — Phase 4 was
built without a routing engine (see below), so the serverless posture now holds across
every phase that has shipped.

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

First run on a real iPhone (2026-08-23) found an eighth, iOS-only bug: **every completed
download failed at the last step** with `TypeError: Not enough arguments`. WebKit
implements only `move(destinationDirectory, newName)`; the single-argument
`move(newName)` overload Chromium accepts throws there — so the full-size `.part` could
never be promoted to its final name. The region stayed on **Resume** and each retry
re-failed instantly, since resume had nothing left to fetch. Finalisation now uses the
two-argument form (accepted by both engines) and treats a `move()` failure as a fall
through to copy+delete rather than a fatal error. Confirmed against Safari directly, not
inferred; covered by `src/regions/opfs-store.test.ts`.

Still open:

- **Full on-device verification has still not been run** (iPhone install → Airplane Mode
  → force-quit → relaunch; Android Chrome equivalent). Only the download path has been
  exercised on hardware; everything else above is desktop.
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

### Phase 3.5 — Summit lists (peak bagging)

Numbered 3.5 rather than inserted as a new 4: it depends on Phase 3's manifest machinery
and on the prominence pipeline, **not** on routing, and the later phase numbers are
referenced from code comments and from §5 and §8 below. Ordering is by dependency, not by
importance — this can ship before Phase 4.

**What this is.** Named collections of summits that people work through and tick off:
**Munros** (Scottish summits over 3000 ft, per the SMC's Munro Tables), **Wainwrights**
(the 214 Lakeland fells of the *Pictorial Guides*), Corbetts, Grahams, Donalds, Hewitts,
Nuttalls, Marilyns, and non-UK equivalents (Colorado 14ers, the NH 4000-footers, the UIAA
Alpine 4000ers). For a large share of hill walkers this *is* why they open a map at all.
It is also the first feature in this plan whose value is a list of things the user has
**not** done yet, which changes what the map is for: the primary query stops being "what
is around me" and becomes "what is around me that I still need".

#### The split that determines everything else: rule-derived vs editorial

| Kind | Lists | Where membership comes from |
|---|---|---|
| **Rule-derived** | Marilyns (P ≥ 150 m), Hewitts (≥ 2000 ft, P ≥ 30 m), Nuttalls (≥ 2000 ft, P ≥ 15 m), Corbetts (2500–3000 ft, P ≥ 500 ft), Grahams (2000–2500 ft, P ≥ 150 m) | Computed from `ele` + `prom`, both of which the peaks pipeline already produces, clipped to a boundary polygon. Costs nothing new and doubles as a hard test of `compute-prominence.py`. |
| **Editorial** | **Munros**, Munro Tops, **Wainwrights**, Donalds | Not derivable. Membership is a published editorial judgement about what counts as a separate mountain. Must be joined from an outside source (C19). |

**Do not try to fit a rule to the Munros.** The tables promote and demote by judgement, so
a threshold tuned to reproduce today's count is wrong at the next revision — and wrong
*silently*, which is the failure mode this document exists to prevent. The Wainwrights are
worse: they are one man's selection, several of them are low-prominence shoulders that no
rule would ever pick, and that is the whole point of the list.

#### Pipeline (`infra/`)

- **`build-summit-lists.py`** → `summit-lists.json`, a new **global artifact** alongside
  `peaks-global.pmtiles`. Structure: `{ version, lists: [{ id, name, region, source,
  licence, revision, criteria?, members: [...] }] }`. A member is `{ osmId, wikidata?,
  name, lat, lng, ele }` — enough to render and to re-match without the tiles (C18).
- **Rule-derived lists are generated**, from the same normalized GeoJSONL that
  `build-peaks.sh` already produces, plus a boundary polygon per list (Scotland, England
  and Wales, the Lake District national park). Criteria live in the artifact so the app
  can explain *why* a summit qualifies.
- **Editorial lists are joined, never transcribed (C19).** Route: a SPARQL query against
  Wikidata (CC0) for list membership, joined onto our peaks by `wikidata` QID, with OSM
  tags as the cross-check and the fallback for peaks with no QID. **Verify before relying
  on this** — the same standard as §2:
  1. Does OSM actually carry a usable membership tag in Scotland and the Lake District
     (`munro=*` and friends)? Check taginfo for real key/value usage and coverage, not
     the wiki page.
  2. Does Wikidata's modelling of these lists give a clean, complete membership query, and
     how many members fail to join onto an OSM peak we hold?
  3. Whatever the join rate, it will not be 100%. Decide the policy *before* building:
     an unmatched member is a visible gap in the list, not a silently shorter list.
- **Count assertions in the build, exactly like the Ben Nevis elevation check.** Pin each
  list's expected count *and the revision it comes from* and fail the build on drift —
  currently published as 282 Munros and 214 Wainwrights, but **verify both against the
  source at build time; do not take them from this document.** A list that quietly loses
  four summits to a broken join is the bug this catches.
- Bake a `lists` property into `peaks-global.pmtiles` as well (a delimited string, e.g.
  `munro;marilyn`), so the map can style and filter membership without loading the JSON.
  The JSON stays the source of truth for the checklist UI; the tile property is a render
  hint. Rebuilding peaks is already scripted, so keeping the two in step is a pipeline
  ordering problem, not a schema problem.
- **Not per-region.** All UK lists together are a few thousand entries — low hundreds of
  KB gzipped. It ships with the app shell and is precached, like `places.sqlite`, so
  lists work on a cold offline start before any region is downloaded.

#### App

- **List browser**: pick a list → members with height, distance and bagged state; sort by
  height, by distance, or unbagged-first; progress as `n/282` with a bar.
- **Nearest unbagged**, from the GPS fix or the viewport centre. This is the single
  feature that makes a bagging app worth opening, and it is pure local computation over a
  few hundred points — no network, no index.
- **Bag from the peak detail sheet.** The sheet already carries name, elevation, coords
  and a Save action (`src/main.ts`); "Bag" sits next to "Save place" and records date and
  an optional note. Storage is IndexedDB, a new store beside `saved-places` — a bagged
  ascent is a log entry, not a bookmark, and merging the two would lose the distinction.
- **Map rendering: list membership must override the notability filter.**
  `PEAKS_NOTABILITY_FILTER` ranks on prominence, so a low-prominence Wainwright is exactly
  the kind of summit it is designed to drop — and would vanish from the map at the zoom
  the user is actually walking at. When a list is active its members always render,
  filter regardless. Bagged and unbagged need distinct symbols that survive a greyscale
  screen in rain; colour alone is not enough.
- **Export and import.** The bagged log is irreplaceable user data that we hold in a
  browser's IndexedDB, so it must be trivially extractable — GeoJSON/CSV out and back in,
  sharing the Phase 4 export plumbing if that lands first, its own if not. Also the
  migration path *in* from whatever the user already tracks.
- **Attribution per list** in the UI, carried from the artifact's `source`/`licence`
  fields (C19), sitting with the existing OSM attribution.

#### Acceptance

Airplane Mode throughout, on a device with `lochaber` downloaded:

1. Open Munros → 282 members, progress `0/282`, nearest unbagged named with a distance.
2. That nearest summit is visible on the map, **and so is a deliberately chosen
   low-prominence Wainwright with the Wainwrights list active** — the filter-override
   case, which is the one that regresses.
3. Bag a summit, force-quit, relaunch → still bagged, with its date.
4. Export the log, clear site data, re-import → identical log.
5. Rebuild `peaks-global.pmtiles` with a changed OSM id for a bagged summit → the log
   still renders that summit (C18). This is the test that proves the storage decision,
   and it is easy to skip because nothing looks broken until years of data are gone.

#### Cost and scope

No new infrastructure and no runtime compute — one more static file in the bucket, a few
hundred KB. §5 is unchanged.

**Out of scope here:** verified/GPS-proven ascents, social features, leaderboards, and
any account or sync (§8.5 still says local-only). Bagging is a private log.

### Phase 4 — Route planning

**Decision, 2026-08-23: there is no routing engine.** This phase originally specified
Valhalla behind an async cancellable interface, hosted or on a small VPS, with `/route`
and `/trace_route`, and accepted that route *computation* would be online-only while
following and the elevation profile worked offline. Adam's call was that an offline-first
mountain map should not have an online-only planner at its centre — so routing was built
on-device instead, and Valhalla is gone from the plan entirely rather than deferred.

**What replaced it.** The network is read straight out of the `roads` layer inside the
region basemap archive the user already downloaded in Phase 3. No new artifact, no new
build step, no server, and nothing to keep in sync — the network we draw the map from is
the network we route over. Verified before building on it (2026-08-23): the Ben Nevis
Mountain Path is present in `lochaber-basemap.pmtiles` at z15 as `kind=path,
kind_detail=path`, with its name.

- **`src/routes/path-tiles.ts`** — decodes one vector tile into walkable lines. Works in
  *global tile units* (`tile.x * extent + localX`), an integer grid shared by every tile
  at a zoom, and clips each tile's geometry to its **exact** bounds, discarding the
  rendering buffer. That clip is what makes the graph stitch: two tiles' buffered copies
  of a crossing way end at different points, and joined naively they leave a hole at every
  tile seam — a router that silently refuses to cross a boundary, which only shows up on
  long routes, which is to say in the field.
- **`src/routes/path-graph.ts`** — every vertex is a node (a junction in tile geometry
  *is* a shared vertex, so contracting them would have to reconstruct what it discarded),
  with a sub-metre merge tolerance for the seam case, and Dijkstra over cost multipliers
  per `kind`/`kind_detail`. `walking` and `cycling` weightings, replacing what Valhalla's
  `pedestrian`/`bicycle` costing was for.
- **`src/routes/router.ts`** — keeps the interface the Valhalla client was going to have:
  async, cancellable by `AbortSignal`, and free to fail. C11 is the reason it never
  rejects for a routing failure — an unroutable leg comes back as an explicitly-marked
  straight one, drawn dashed and called out in the panel, never passed off as a path.
- **Elevation profile: `src/routes/terrain-sampler.ts`, not `queryTerrainElevation()`.**
  The spec named MapLibre's call and it is genuinely the reason this project is a PWA — but
  reading its implementation before relying on it (maplibre-gl v5, `src/render/terrain.ts`)
  showed two disqualifying properties for a *route* profile: `getDEMElevation()` returns
  **0, not null**, for any DEM tile not currently loaded, and tiles load only for the
  current viewport — so a profile for a route that does not fit on screen reads as sea
  level over half its length, indistinguishable from genuinely being at sea level. It also
  multiplies by the terrain exaggeration. Sampling the region's terrarium tiles directly is
  viewport-independent, exaggeration-independent, returns null where there is no data, and
  needs no `setTerrain()`. Ascent is threshold-filtered at 5 m: summing raw sample-to-sample
  differences turns DEM noise into hundreds of metres of phantom climb.
- Tap to add a waypoint, tap the line to insert one mid-route, drag to move, long-press to
  remove, undo. Placement always commits first (C11).
- Local-first persistence (C10), GPX + GeoJSON import/export, Web Share API where files
  can be shared and a download where they cannot.

**Offline route *following* ships in this phase** and needs no engine: view saved routes
offline, follow against the GPS dot, off-route distance with two thresholds so it cannot
flap at the boundary, GPX import. Foreground only, and the panel says so (§7).

**What this costs, honestly.** On-device routing over tile geometry is not Valhalla. It has
no turn restrictions, no one-way handling, no ferry or barrier logic, no access-time
conditions, and no idea about surface or gradient beyond what `kind_detail` carries. It
routes within **one** downloaded region — a leg spanning two regions falls back to a
straight line rather than stitching two archives. For a hill map, where the question is
"which path goes up this mountain", that is the right trade; for street navigation it
would not be. §7 gains this as a stated limitation, not a footnote.

**Acceptance:** with a region downloaded and Airplane Mode on throughout — plan a route
that follows real paths, read a correct ascent total, save it, force-quit, relaunch, and
follow it against the GPS dot.

### Phase 5 — Deferred

Much smaller than the native plan — offline elevation and 3D terrain are already done.

- ~~**Offline routing.**~~ **Shipped in Phase 4**, by a different route than this entry
  imagined. It assumed offline routing meant Valhalla tiles per region (Germany ~4.6 GB)
  plus an immature WASM build, and priced it as the one genuinely hard remaining item.
  Routing over the `roads` layer already inside the basemap archive costs **zero extra
  bytes** and no new build step. What that does *not* buy is Valhalla's road model — turn
  restrictions, one-way handling, barriers, access conditions, cross-region routing. If a
  use case ever needs those, this entry comes back with its original scope; nothing in
  Phase 4 forecloses it, since the router sits behind the same async cancellable interface
  a Valhalla client would have used.
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
| Routing engine | **$0 — none.** Phase 4 routes on-device over the region tiles already in the bucket |

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
- **Routing is a hill-path router, not a road router.** Phase 4 routes on-device over the
  path network inside a downloaded region. It has no turn restrictions, no one-way
  handling, no barrier or ferry logic and no access-time conditions, and it works within a
  single region — a leg spanning two falls back to an explicitly-marked straight line.
  Good for "which path goes up this mountain"; not a substitute for street navigation.
- **Routing and the elevation profile need the region downloaded.** With only the
  worldwide catalogue there is no path network to route over, and the global terrain layer
  is a z0-4 extract — roughly 5 km per pixel — so the app draws no profile rather than a
  smooth curve that means nothing.

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
   The routing cost multipliers in `src/routes/path-graph.ts` are the same kind of open
   call: they decide which of two parallel ways a route prefers, never whether a route
   exists, and the current values are defensible defaults rather than a tuned model.
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
6. **Which summit lists ship first (Phase 3.5), and in what order?** The rule-derived
   ones are nearly free once prominence exists; Munros and Wainwrights are the ones
   people actually ask for and are the ones with a sourcing question (C19). Also: do we
   ship non-UK lists at all, given that regions so far are Scotland and Montenegro?
7. **Is a bagged ascent ever more than a tick?** Date and note are assumed. Photos,
   companions, a linked route, weather — each is cheap on its own and together they are
   a different product. Needs a call before the IndexedDB schema is written, because it
   is user data and migrating it is the expensive kind of change.
