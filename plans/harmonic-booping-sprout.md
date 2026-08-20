# OSM Summit Map — PWA Implementation Spec

**Audience: the implementing agent.** Read *Hard constraints* before writing any code.
Each one exists because the obvious approach fails, usually silently.

**Where this file belongs:** copy into the app repo as `docs/IMPLEMENTATION.md` and have
`CLAUDE.md` point at it. Currently outside any repo.

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
| C2 | **Drive Add-to-Home-Screen in onboarding on iOS.** Detect standalone via `display-mode: standalone`. | WebKit grants `persist()` "based on heuristics like whether the website is opened as a Home Screen Web App". Install isn't just discovery — it *gates the storage guarantee*. iOS has no `beforeinstallprompt`, so this must be a hand-held UI flow. |
| C3 | **Every PMTiles artifact must have a globally unique filename.** | `FileSource.getKey()` returns `file.name`, and that key is how `Protocol.add()` registers the archive. Two regions each shipping `basemap.pmtiles` collide and silently serve the wrong region's tiles. Use `<region>-basemap.pmtiles`. |
| C4 | **Configure CORS on the R2 bucket: allow the `Range` request header, expose `ETag` and `Content-Range`.** | Unlike a native app, a browser enforces CORS on range requests. Without exposed `ETag`, the pmtiles library cannot do its archive-consistency check. Classic silent failure — tiles just never load. |
| C5 | **Store `.pmtiles` archives in OPFS, not the service-worker Cache API.** Keep the SW cache for the app shell only. | Cache API has a much smaller effective quota; OPFS gives real random-access file handles, which is what range reads need. |
| C6 | **Do not expect an elevation value on Protomaps peaks.** | Schema v4 puts peaks in `pois` as `kind=peak` with `kind`, `cuisine`, `religion`, `sport`, `iata` — no `ele`. (v2's `physical_point` had it; that layer is gone.) Use our own `peaks.pmtiles`. |
| C7 | **Bundle glyphs and sprites locally.** | They load from URLs independent of the tile archive. Left remote, the offline map renders geometry with no labels and no icons. |
| C8 | **No tile server, no Worker, no runtime compute for tiles.** | PMTiles is read by HTTP range request straight from static storage. |
| C9 | **No geocoding API.** Search is a local SQLite FTS5 index via `sql.js`/`wa-sqlite`, or an IndexedDB inverted index. | Works offline, no key or quota, queries never leave the device. |
| C10 | **Persist routes as complete coordinate arrays, never a server-side route ID.** | A saved route must render with the network permanently off. |
| C11 | **Waypoint placement must not require a successful network snap.** | If a waypoint only commits after `/trace_route`, offline editing becomes impossible. Allow unsnapped waypoints with deferred snapping. |
| C12 | **Region downloads must be resumable and chunked, and hold a Screen Wake Lock while running.** | No Background Fetch or Background Sync on iOS. A multi-GB download only progresses in the foreground; assume it will be interrupted. |
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
- No background geolocation on iOS PWAs → §7.
- Screen Wake Lock supported from Safari 16.4.
- `map.setTerrain({source, exaggeration})` and hillshade layers work off a `raster-dem`
  source; custom protocols can feed DEM sources.

### Must spike before relying on (Phase 0)

1. **`raster-dem` fed by `pmtiles://` carrying WebP terrarium tiles**, rendering hillshade
   *and* `setTerrain` in **iOS Safari specifically**. Least-proven link in the chain.
2. **OPFS → `getFile()` → `FileSource` → `Protocol.add()`** serving a local archive, and
   how it behaves after the app is backgrounded and resumed.
3. **`persist()` actually granted** on a real iOS device once installed to Home Screen,
   and observed retention past 7 days of no use.
4. Sustained OPFS write throughput for a multi-GB download on a mid-range phone.

If (1) fails, fall back to AWS Open Data terrain tiles
(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) for online
hillshade and accept that offline terrain needs a different encoding.

---

## 3. Architecture

**Everything is a static file.** One R2 bucket on a custom domain with CORS (C4), plus
static app hosting (Cloudflare Pages). Zero runtime compute through Phase 4.

```
R2 bucket (custom domain, CORS: allow Range, expose ETag + Content-Range)
├─ planet-<version>.pmtiles        Protomaps basemap, pinned            (C13)
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

**Runtime servers: zero through Phase 4.** Valhalla appears in Phase 5 for route
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

- R2 bucket, custom domain, **no Worker**, CORS per C4.
- Pinned Protomaps planet build (C13). Consume their published builds.
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

### Phase 3 — Launch

Small, compared to the native path — no review, no store, no privacy manifest.

- Deploy to production domain; verify the manifest, icons and iOS splash screens.
- Lighthouse PWA audit clean.
- Verify update flow: a new SW version must not strand a user mid-download.

**Acceptance:** a stranger can reach the URL, install it, and use it offline.

### Phase 4 — Offline regions

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

### Phase 5 — Route planning

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

### Phase 6 — Deferred

Much smaller than the native plan — offline elevation and 3D terrain are already done.

- **Offline routing.** The one genuinely hard remaining item. Valhalla tiles per region
  plus a WASM build; immature. Routing tiles rival or exceed the basemap per region
  (Germany ~4.6 GB), so opt-in with per-artifact sizes shown.
- **Custom region selection** — user-drawn bbox needs a server-side extract job.
- **Trail rendering** — if Protomaps path coverage is inadequate at high zoom, custom
  `tippecanoe` from OSM extracts. Verify coverage during Phase 1.

---

## 5. Cost

| Item | Cost |
|---|---|
| Cloudflare R2 (~120 GB planet) | ~$3 / month, no egress fees |
| Cloudflare Pages hosting | Free tier |
| Domain | ~$10–15 / year |
| Workers / search / app stores | $0 — not used |
| Valhalla (Phase 5 only) | Hosted free tier or small VPS |

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
| Offline elevation queries are hard (Phase 6) | **Gone** — `queryTerrainElevation` works offline |
| `isExcludedFromBackup` on iOS | **Gone** — no iOS filesystem |
| App Store review, 4.2 risk, privacy manifest, TestFlight, 12-testers/14-days | **Gone** |

New in exchange: storage persistence (C1), install-gates-persistence (C2), filename
collisions (C3), CORS (C4), OPFS vs SW cache (C5), foreground-only downloads (C12).

---

## 7. Accepted limitations

State these plainly in the product, not just here.

- **No background geolocation.** Cannot record a track with the phone pocketed and screen
  off. Following a route means app foregrounded and screen on. This is a platform
  capability that does not exist, not a workaround gap.
- **No background downloads.** Region downloads only progress in the foreground.
- **iOS install friction.** No install prompt; Share → Add to Home Screen manually — and
  it gates persistence (C2).

**Escape hatch — do not design against it, but know it exists.** If background location or
store distribution later becomes necessary, wrap this same web codebase in **Capacitor**:
native background-geolocation plugins and App Store/Play distribution, no rewrite. The
cost is re-acquiring the native build and review overhead. Nothing in this spec forecloses
it — which is why C10 and C11 are still here even though nothing in the PWA path needs
them yet.

---

## 8. Open decisions — ask Adam, do not guess

1. **App name and domain.** Blocks the repo scaffold and hosting setup.
2. **Planet or catalog-only?** Keep the ~120 GB planet for "pan anywhere online", or ship
   only a low-zoom world plus regional extracts and cut storage to cents/month.
3. Contour interval and styling — needs a cartographic call on real target regions.
4. Street-level address search — currently out of scope; would ship per-region.
5. Accounts/sync — currently none, all local.
