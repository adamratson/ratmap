# Route sharing — links, QR codes and better files, with no server

**Status (2026-10-01): §3.1–§3.5 fixed; nothing of the sharing itself built yet.** Planned
2026-09-30, the same day as an ideas pass and a review of those ideas against the code. The
existing-behaviour fixes §3 calls for landed the next day (§3 says how each was fixed and
verified); §3.6 waits on §6 decisions 3 and 4, and §3.7 belongs to Stage C. Every size and
reproducibility figure in §2.1 was measured by running the app's own routing and export
code over the real Scotland archive. The platform behaviour in §2.2 is documented upstream
and has not been tried on a phone. Nothing here needs a server, an account or a new
artifact. Destined for `docs/IMPLEMENTATION.md` as a Phase 4 addendum (number TBD) once §6
is decided.

**In one paragraph.** Turning a route into a link is the easy part. The Ben Nevis Mountain
Path (8.0 km, 521 vertices) is 25.9 KB as the GPX ratmap exports today and 640 characters as
a link. The hard part is the person receiving it. Their map is a download of about 1 GB for
Scotland (677 MB basemap + 359 MB terrain, as built on disk). On iOS a tapped link opens in
Safari, whose storage is not the installed app's, rather than in ratmap. So this plan is
built around what a shared route can do *before* the recipient has the map, and how it
reaches the installed app afterwards.

---

## 1. What exists today

- **Out:** [`shareOrDownload`](../src/routes/routes-ui.ts) hands a GPX or GeoJSON file to
  `navigator.share({ files })`, or downloads it. It is reachable only from the saved-routes
  list. The planner panel (Undo · Save · Follow · Done · Clear) has no share, so a route has
  to be saved before it can leave the phone.
- **In:** an `<input type=file>` behind "Import GPX". Nothing reads `location.hash` or
  `location.search`, and the web manifest has no `share_target`, `file_handlers` or
  `launch_handler`. Deep linking is greenfield.
- **Between two copies of ratmap:** only export-then-import, which loses information (§3).

---

## 2. Evidence

### 2.1 Measured (2026-09-30)

A scratch vitest harness ran the repo's own `PathGraph`, `OfflineRouter`, `toGpx` and
`toGeoJson` over `infra/dist/regions/scotland/scotland-basemap.pmtiles` (built 2026-09-06,
manifest sha256 `4831c21341dc…`). It is not committed; the method is described here so it
can be rebuilt as the tests in §5. Coordinates were quantised (1e-5° for geometry, 1e-6° for
waypoints), then delta + zigzag + varint encoded and base64url'd. Simplification is
Ramer–Douglas–Peucker in a local metric projection.

**Payload size, on real router output.** Five routes were tried. Three used coordinates I
had guessed, which turned out not to be on the network, and did not route. These two did.
Longer routes scale linearly, at about 80 characters per km at 2 m.

| Route | Vertices | GPX today | Link, unsimplified | Link, 2 m | Link, 5 m |
|---|---|---|---|---|---|
| Achintee → Ben Nevis, 8.0 km | 521 | 25.9 KB | 1,412 chars | 640 (length −0.35%) | 415 (−1.04%) |
| The same, out and back, 15.9 km | 1,041 | 51.3 KB | 2,815 | 1,270 (−0.35%) | 819 (−1.04%) |

- **Compression isn't worth carrying.** Deflate changed the simplified payloads by −6% to
  +3%, and only earns its keep unsimplified (−18% to −21%). Varint deltas are already close
  to random bytes. No `CompressionStream`.
- **Simplifying always shortens.** The router reads z15 precisely because "a simplified path
  is a *wrong* path length" ([router.ts](../src/routes/router.ts), `ROUTING_ZOOM`). So a link
  carries each leg's measured distance and displays that. Its geometry is for drawing and
  following, where 2 m is nothing against the 60 m off-route threshold in
  [follow.ts](../src/routes/follow.ts).

**Waypoints only: do the same waypoints give the same route?** 60 random routes went
through the real `OfflineRouter`, using per-leg graphs exactly as the app routes. Each had
3–5 waypoints 1.5–4 km apart as the crow flies, with every tap up to 25 m off the path.
Routed lengths were 6.7–25.0 km, median 15.1. *Same path* means only the spurs to the
tapped points moved (≤ 2 m, ≤ 0.1%). *Minor* is within 30 m and 1%.

| Input | Same path | Minor | Material |
|---|---|---|---|
| Same waypoints, fresh router (cold tile cache) | 60 | 0 | 0 |
| Same waypoints, warm cache | 60 | 0 | 0 |
| Rounded to 1e-7° (~1 cm) | 60 | 0 | 0 |
| Rounded to 1e-6° (~11 cm) | 60 | 0 | 0 |
| Rounded to 1e-5° (~1 m) | 58 | 2 | 0 |
| Rounded to 1e-4° (~11 m) | 3 | 51 | 6, worst 2.6 km / 11% |

So on the same data and code, a waypoint link reproduces the route exactly, provided it
carries waypoints at 1e-6° or finer. That costs 19, 25 and 31 bytes for 3, 4 and 5
waypoints.

**A fragility this turned up.** A first harness built one graph for the whole area rather
than one per leg. Adding the same tiles and lines to it in a shuffled order changed 1–2 of
the 60 routes materially, one of them by 1.1 km (4.6%). The app's order is fixed:
`OfflineRouter.buildGraph` walks `tilesForBbox` in order. So this doesn't bite today. But
"same waypoints, same route" is a property of the current code, not a guarantee. Any router
change can change what an old waypoint link means, which is why §4.4 has golden routes.

**QR capacity** (byte mode, from
[Thonky's table](https://www.thonky.com/qr-code-tutorial/character-capacities)). v10-M holds
213 B (57×57 modules), v21-M holds 711 B (101×101) and v40-L holds 2,953 B. With a
~40-character origin in front, a compact link (§4.1) is roughly 140–175 B and fits v10-M.
The 8 km route as a full link at 2 m is about 740 B, just past v21-M. Scan reliability at
either density is untested (§2.3).

### 2.2 Documented upstream, not tested here

| Claim | Source |
|---|---|
| iOS has no link capturing (only a push notification opens an installed web app), and Home Screen web app storage is not shared with Safari | [firt.dev iOS PWA notes](https://firt.dev/notes/pwa-ios/) |
| Safari copies a site's cookies, and no other storage, into a web app when it is added. WebKit's wording is for macOS Dock apps; the iOS Home Screen case is not confirmed | [WebKit, Safari 17](https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/) |
| iOS 26: Add to Home Screen defaults to "Open as Web App" | [MacRumors](https://www.macrumors.com/how-to/save-safari-bookmark-web-app-iphone-home-screen/) |
| `share_target`: Chrome Android 76, Chrome desktop 89; Safari and Firefox never. Installed PWAs only | [MDN compat data](https://github.com/mdn/browser-compat-data/blob/main/manifests/webapp/share_target.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/Manifest/Reference/share_target) |
| An installed WebAPK registers intent filters for its scope, so in-scope links open the app, and it shares cookies and storage with Chrome | [web.dev, WebAPKs](https://web.dev/webapks/) |
| File Handling (`file_handlers`, `launchQueue`) is desktop only | [Chrome docs](https://developer.chrome.com/docs/capabilities/web-apis/file-handling) |
| `BarcodeDetector`: Chrome Android 83; Safari only behind a preference, so not usable | [MDN compat data](https://github.com/mdn/browser-compat-data/blob/main/api/BarcodeDetector.json) |
| A URL's fragment is not part of the HTTP request, and a redirect whose `Location` has no fragment inherits the original's | HTTP; [RFC 9110 §10.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.2) |

**Not confirmed:** whether GitHub redirects the `github.io` URL once a custom domain is set.
Its custom-domain page does not say. See §6 decision 1.

### 2.3 Must spike on real phones before relying on it

1. **iPhone:** a link tapped in Messages opens Safari, not the installed app. This is
   expected, and confirms the paste path is needed.
2. **iPhone, iOS 26:** a cookie set in Safari is readable inside the web app after Add to
   Home Screen. This decides Stage D.
3. **Android:** a link tapped in WhatsApp or Messages opens the installed app, both cold and
   with the app already open. The second is a same-document navigation: it fires
   `hashchange` and does not reload.
4. **Messengers** (iMessage, WhatsApp, Signal, Gmail, Slack): does a 0.5 k, 1.5 k or
   3 k-character link arrive whole and clickable?
5. **QR codes** at v10 and v21: scan from a phone screen with a phone camera, outdoors.
6. **Golden routes on an iPhone:** do the §4.4 golden routes give the same answer in
   JavaScriptCore as in V8? `Math.cos` and `Math.hypot` are implementation-approximated, so
   an exact cost tie could break differently. That should be vanishingly rare; this settles
   it.

---

## 3. Found in review: existing behaviour to fix first

1. **Imports lose their structure.** Given no editing state,
   [`RoutePlanner.load()`](../src/routes/route-planner.ts) builds a single `snapped` leg with
   only the two end waypoints. Export-then-import is today's only ratmap-to-ratmap path, and
   a route that takes it loses its middle waypoints. A straight leg comes back drawn as a
   path (C11).
   **Fixed 2026-10-01** as §4.7 describes: exports record each leg as a vertex span
   (`legSpans` in [gpx.ts](../src/routes/gpx.ts)), and imports rebuild the legs and
   waypoints, all or nothing, from a file ratmap wrote. A file whose spans no longer fit its
   track opens as one track, and the import toast says its straight sections aren't
   marked. The GeoJSON side also gained two round-trip fixes. Waypoint heights are now read
   back from the `ele` property they were always written to. The `Waypoint N` names the
   export invents for other tools are dropped on the way back in. Verified by an e2e round
   trip (`routes-library.spec.ts`: three waypoints, two straight legs, export, import, both
   still straight).
2. **Foreign GPX with waypoints puts the markers on the wrong points.** With ≥ 2 `<wpt>`,
   `load()` makes the first and last `<wpt>` the route's ends, even when they are POIs
   partway along the track. Dragging one re-routes the whole import between two POIs.
   **Fixed 2026-10-01:** the ends are always the track's own. A `<wpt>` within 25 m of an
   end still lends it its name and height, which keeps older ratmap exports named.
3. **Opening a route discards the current plan with no undo.** `load()` replaces
   `this.draft`, and the undo stack belongs to the old draft. This is true of import today.
   A link arriving in a running app (Android) makes it likelier.
   **Fixed 2026-10-01:** `load()` returns a way back, which the routes sheet offers as an
   Undo toast when opening a saved route or an import replaces a plan. Undo brings back the
   replaced draft object, so its own undo history comes with it, along with its saved-route
   id and name. It declines, and says so, once the opened route has been edited, because
   going back would lose that edit.
4. **A route opened at startup races the region restore.** `coverage.restore()` is
   fire-and-forget in `installAppLayers` ([main.ts](../src/main.ts)), and nothing tells the
   planner when it finishes. A route loaded before then shows "Elevation profile needs a
   downloaded region" and never retries. A waypoint link would route every leg straight and
   never re-route.
   **Fixed 2026-10-01:** `RegionCoverage` takes an `onDownloadedChange` hook, called when
   the downloaded set actually changes (by region and archive), as soon as what's on disk
   is drawn rather than after the catalogue fetch. A theme switch's identical redraw stays
   quiet. `main.ts` points it at `planner.invalidateRegions()`. Verified red then green in
   a real browser against the production build. An init script opened a route on the
   map's first `styledata`, ahead of the app's own handler and so before the restore.
   Before the fix its profile never arrived; after it, the profile arrived in about 2 s.
   That run used a Ben Nevis region cut from the local Scotland archives with
   `pmtiles extract` and seeded into OPFS, because over this machine's VPN the e2e suite's
   26.6 MB Andorra download could not finish in time (11 KB/s on a range read). The same
   test is in `route-planning.spec.ts` against Andorra, and it has not been run there yet.
   It needs a normal connection or CI.
   Note for Stage B: this fixes the *profile*. Legs computed before the restore stay
   straight, so a link must still wait for the restore before loading (§4.3).
5. **`load()` never computes pending legs.** It only refreshes the profile, so a draft
   loaded with `null` legs would sit on "Working out the route…" forever.
   **Fixed 2026-10-01:** `load()` runs `recompute()`, which routes any leg the draft
   arrived without and then measures. The fix showed a second problem. Simply clearing the
   old figures on every load would have blanked the chart on every Save, which reopens the
   route it just stored. So the figures are cleared only when the line itself changes.
6. **Exports carry no heights and no credit.** `RouteExport.elevations` exists in
   [gpx.ts](../src/routes/gpx.ts), but `shareOrDownload` never fills it, and `SavedRoute`
   ([route-store.ts](../src/routes/route-store.ts)) keeps no profile. Neither format credits
   OpenStreetMap.
   **Not fixed: waits on §6 decisions 3 and 4,** and fixing it turned up a fact for each:
   - *Heights:* the saved-routes list has no profile in hand, so heights would have to be
     computed between the tap and `navigator.share()`. Share needs transient user
     activation, and an async pause risks losing it, so the export falls back to a
     download, which is exactly what iOS makes awkward. Not checked on a phone. If it holds,
     it argues for storing heights at save time.
   - *Credit:* a blanket `<copyright author="OpenStreetMap contributors">` would be wrong on
     an import exported again: a track recorded in another app is not OSM data.
7. **The manifest's per-artifact `sha256` is unused.** `build-manifest` writes it (for
   example `4831c21341dc…` for `scotland-basemap.pmtiles`). The app declares it in
   [manifest.ts](../src/regions/manifest.ts) and never reads or records it.
   *Not a bug today;* it is the Stage C prerequisite, and stays with Stage C.

---

## 4. Design

### 4.1 One format, two sizes

A link is `<origin><BASE_URL>#r=<base64url>`. It is built from `location.origin` and
`import.meta.env.BASE_URL` at share time, never from a hardcoded host.

- **In the fragment.** The fragment never reaches GitHub or any other server, so a route is
  exactly as private as the channel it is sent through. Static hosting could not route
  `/r/…` paths anyway. `#` is otherwise unused, so keep it `key=value` and another key (a map
  position, one day) can sit beside it.
- **Full** (the default for messages): waypoints plus every leg's kind, distance and
  geometry. The link *is* the route, which is C10 extended to sharing: it draws, follows and
  exports to GPX with no region and no network.
- **Compact** (the default for QR codes): the same with no geometry, plus a per-leg check
  (§4.4). The recipient needs the region. In exchange it is a fifth to a quarter of the size
  of the 8 km full link: a v10 QR code where a full link needs more than v21.

### 4.2 Payload, version 1

The fields, in order. The exact byte layout is settled in the codec, with tests.

1. **Header:** format version, then a flags byte (geometry, sender stats, origin, check). An
   unknown version or flag is refused with "this link needs a newer ratmap", following the
   `CatalogueTooNew` pattern. It is never half-read.
2. **Route name:** UTF-8, ≤ 120 bytes.
3. **Waypoints:** 2–500, at 1e-6° (§2.1). Each has an optional name ≤ 80 bytes, which is
   the summit name `describePoint` attaches when a waypoint is dropped on a peak.
4. **Legs:** each leg carries its kind (snapped or straight, so C11 survives the trip) and
   its measured distance in metres. With geometry, the interior vertices follow at 1e-5°,
   simplified to 2 m per leg with both ends fixed. The ends are the waypoints, so they cost
   nothing twice.
5. **Sender stats (optional):** ascent and descent, shown labelled as theirs until the
   recipient's own region gives a profile (§6 decision 7).
6. **Origin (optional):** an 8-byte random id and an updated-at, so a re-shared version can
   offer "Replace your copy / Keep both" (§6 decision 5).
7. **Check (compact only):** router version, the first 4 bytes of the basemap's sha256
   (zero when unknown), and each leg's midpoint at 1e-4°.
8. **CRC-32.** A messenger that truncates a long URL has to produce "this link is damaged",
   never a shorter route that decodes cleanly.

Decoding treats the link as untrusted, the same rule that applies to imported GPX and OSM
names:

- reject anything over 64 KB before decoding;
- cap vertices at 20,000;
- range-check every coordinate;
- strip control and bidi-override characters from names;
- render with `textContent` only.

### 4.3 Receiving

This runs on boot, on `hashchange`, and from `launchQueue` where it exists (desktop
Chromium).

1. **Wait until the downloaded regions are known** (§3.4). Check this does not wait out the
   5 s catalogue timeout when offline; restore draws from the saved manifest first.
2. **Decode.** A damaged link says so, and a too-new one says "update ratmap". Nothing is
   half-loaded.
3. **Clear the fragment** (`history.replaceState`) so a reload does not open it again.
4. **Protect the current plan.** If the planner already holds waypoints, open the new route
   and offer Undo in a toast, the app's "act now, offer a way back" pattern. Undo restores
   the previous draft, its id and its name (§3.3).
5. **Load it.** Call `planner.load()` with the waypoints and legs. For compact links the
   legs are `null`, so `load()` must call `recompute()` when legs are pending (§3.5).
6. **Show a received block** in the planner panel:
   - distance from the carried per-leg figures, so it is exact;
   - their ascent and descent, labelled, until the recipient's own profile exists;
   - when no downloaded region covers the route, which catalogue region does and its size,
     with the download action. Use `regionAt()` on the start, end and midpoint, and if they
     disagree, say the route spans regions;
   - Save · Follow · Save as GPX. The last makes every link useful to someone who never
     installs ratmap, because it converts itself into a file for whatever app they use;
   - for compact links only, the result of the check (§4.4).
7. **Save nothing until they tap Save,** the same as an import.

A received route can be followed without a pointer. That partly answers the §7
accessibility gap, where planning is pointer-only but following is not.

### 4.4 Compact links: make drift loud

The same data and code reproduce a route exactly (§2.1), so the only question is whether
the two phones differ.

- **Router version.** A `ROUTER_VERSION` constant travels in the link. A golden-route test
  over the real archive pins a set of waypoints to their route hashes. Like
  [archive-route.test.ts](../test/archive-route.test.ts), it is skipped when the archive is
  absent. Any change to routing output fails the test, and the fix is a deliberate version
  bump.
- **Per-leg check.** After routing, compare each leg's distance and midpoint with the
  carried ones, and warn per leg: "Leg 2 is 3.1 km on your map and 2.4 km on theirs." Tune
  the thresholds against the §2.1 harness, not by guessing.
- **Warn from the check, not from the build hash.** Most rebuilds do not touch any given
  route, and a warning on every rebuild cries wolf. That is the same reason the detail-limit
  notice reads real zoom ranges rather than a constant. Once the app records the hash
  (§3.7), the hash only makes the message specific: "their map was built on 6 September".
- **No region:** every leg comes back straight (C11). Say "this short link needs the map
  for Scotland (about 1 GB)" rather than drawing dashed lines and leaving it there.

### 4.5 Getting it into the installed app

- **Android:** in-scope links open the installed app (documented; spike 3).
- **iOS:** links open Safari (spike 1). So:
  - **Paste a route.** A field in the Routes sheet takes a link or GPX/GeoJSON text. A text
    field needs no clipboard permission. The received view in Safari gets a Copy button.
  - **Carry the route through install.** A first-time iOS recipient loses the route on
    install, because Safari's storage does not follow it. If spike 2 passes, stash the route
    in a short-lived cookie before the Add to Home Screen walkthrough: the full link if it
    fits in ~3.5 KB, otherwise the compact one. Read and delete it on the first standalone
    launch. A cookie goes out with the app's own network requests to its origin, so for
    those minutes the route does reach GitHub. If the spike fails, the walkthrough says "copy the
    route first, then paste it in the app".
- **Desktop:** drag a `.gpx` onto the map. `file_handlers` only helps an installed desktop
  app.

### 4.6 Sending

- **One Share action.** It sits in the planner panel beside Save (enabled once the route is
  complete), and in each saved-route row in place of the GPX/GeoJSON pair. It offers Link ·
  QR code · GPX · GeoJSON.
- **Link:** `navigator.share({ url, title })`, falling back to the clipboard the way the
  coordinate sheet's Copy does.
- **Before it goes:** "Anyone with this link can see this route, and it can't be taken
  back." Offer to trim the first and last 200 m, because a route often starts at someone's
  door.
- **QR code:** compact by default, shown full-screen.

### 4.7 Files, fixed (§3.1, §3.2, §3.6)

- **Heights:** interpolate the profile onto each exported vertex by distance along the
  route. Matching by index is wrong: `profileSampleCoords` keeps every vertex, except that a
  route with more than 2,500 vertices is resampled. With no profile, write no `<ele>` and
  say so.
- **Legs (built 2026-10-01):** *not* one `<trkseg>` per leg, as this section first said. A
  new segment means "signal was lost here" in GPX 1.1, and another app may draw it as a gap.
  Instead, the track stays one segment and carries `<ratmap:legs>` in its `<extensions>`:
  one `<ratmap:leg kind start end>` per leg, as vertex indices. The namespace is a dated
  `tag:` URI, so it needs no host and adds nothing to decision 1. GeoJSON carries the same
  spans in a versioned `ratmap` property on the route feature.
- **Import (built 2026-10-01):** a file ratmap wrote comes back with its waypoints and legs,
  straight legs still straight. A foreign file keeps today's single `snapped` leg, with its
  end waypoints at the track's own ends.
- **Credit:** GPX `<metadata><copyright author="OpenStreetMap contributors">` with the ODbL
  URL, and a property on the GeoJSON route feature. Whether it is required is §6 decision 4.

---

## 5. Work

### Stage A — fix what exists (no new format)

**Done 2026-10-01**, apart from heights, credit and Share from the planner:

- **[route-planner.ts](../src/routes/route-planner.ts)**, done:
  - replacing the current plan is undoable (§3.3);
  - foreign files get their end waypoints at the track ends (§3.2);
  - `load()` computes pending legs (§3.5);
  - the profile is re-run once the startup restore has drawn the regions (§3.4), which also
    covers a saved route opened in the first seconds.
- **[gpx.ts](../src/routes/gpx.ts)**, done: leg spans in a track extension (§4.7), and the
  importer rebuilds legs and waypoints from files ratmap wrote. *Heights and credit wait on
  §6 decisions 3 and 4* (§3.6).
- **[routes-ui.ts](../src/routes/routes-ui.ts)**, done: the Undo toast, and legs through
  export and import. *Not done:* Share from the planner panel, a feature that goes with
  Stage B's Share sheet.
- **Tests**, done:
  - an e2e round trip of a three-waypoint, two-straight-leg route;
  - unit tests for each fix (planner, GPX/GeoJSON, routes sheet, coverage);
  - the startup race as an e2e test (§3.4 on why it has only run against a seeded region so
    far);
  - the existing "imports a GPX file" test still sees one `snapped` leg.

### Stage B — full links

- **New `src/routes/share-link.ts`:** the codec, with `LinkDamaged` and `LinkTooNew`
  errors. Unit tests:
  - round trip within quantisation;
  - random and truncated bytes always fail with `LinkDamaged`, never yielding out-of-range
    coordinates;
  - every cap;
  - names stripped;
  - a size test on the Mountain Path.
- **[main.ts](../src/main.ts):** the receive sequence of §4.3.
- **[routes-ui.ts](../src/routes/routes-ui.ts):** the received block, the Share sheet, and
  Paste a route.
- **e2e:**
  - opening `…/#r=` shows the route with the right leg kinds and exact distance;
  - the same holds on an offline cold start;
  - a damaged link and a too-new one each say so and load nothing;
  - a `hashchange` into a running app opens the route, and the plan it replaced comes back
    on Undo.

### Stage C — compact links and QR codes

- `ROUTER_VERSION` and the golden-route test (§4.4), rebuilt from the §2.1 harness.
- The per-leg check and its warning.
- Record the basemap's `sha256` when a region is downloaded (§3.7).
- **QR:** an encoder, lazy-loaded like SQLite ([vite.config.ts](../vite.config.ts)). In-app
  scanning needs a JS decoder, because `BarcodeDetector` is unusable on iOS. The alternative
  is to leave scanning to the camera app and the paste path (§6 decision 6).
- **e2e, with the Andorra region fixture:** a compact link reproduces the sender's legs, and
  a tampered distance raises the warning.

### Stage D — iOS install bridge (only if spike 2 passes)

The cookie stash of §4.5. Acceptance is on a real iPhone: open a link in Safari, install,
and the first launch shows the route.

### Stage E — independent extras

- **Tell someone:** a plain-text message with the name, distance, ascent, Naismith time
  (labelled as Naismith), a start time and an "expected back" time they enter, and the link.
  It must not suggest anyone is watching: ratmap sends nothing and monitors nothing. No
  bearings or grid references until there is a declination and OSGB model.
  [`compassBearing`](../src/routes/geo.ts) is eight-point, for search results.
- **Image card:** map, stats and profile as a PNG. Draw the credits into the image, because
  the attribution control is DOM, so the canvas lacks it, and the spec makes attribution a
  legal requirement. Capture needs a spike, since the map has no `preserveDrawingBuffer`.
- **Android `share_target`** for GPX from other apps: a POST handler in the service worker
  (`workbox.importScripts`), checked against the staged-update guarantees in
  [service-worker.test.ts](../test/service-worker.test.ts).

---

## 6. Open decisions — ask Adam, do not guess

1. **Decide the domain before links ship?** Every link names the origin forever, and §8
   item 1 leaves the domain open until Phase 6. Moving later leaves old links depending on a
   github.io redirect that is not confirmed (§2.2). A custom domain would also stop ratmap
   sharing an origin, and so its storage, with any other Pages project on the same account.
2. **Simplification tolerance:** 2 m with exact per-leg distances (recommended), no
   simplification (about 2.2× the size), or 5 m (about 0.65×).
3. **Keep heights in `SavedRoute`?** As an additive optional field, a saved route could
   export `<ele>` without its region on the phone. The alternative is to compute heights at
   export and omit them when the region is absent. That alternative puts an async pause
   between the tap and `navigator.share()`, which may cost the share its user activation
   (§3.6), so storing them looks like the better option.
4. **Credit in exported files:** required, or a courtesy? Either way, not as a blanket
   `<copyright>`: a track imported from another app and exported again is not OSM data
   (§3.6). Credit only routes whose legs were routed here, or use a softer `<link>`/`<desc>`
   line.
5. **Route id in links**, for "replace your copy": 8 bytes of random id, or accept
   duplicates in the library.
6. **Compact links:** QR only, or offered for messages too? And in-app QR scanning (a JS
   decoder and camera permission), or the camera app plus paste?
7. **Sender's ascent and descent:** real numbers from their terrain, but not the
   recipient's. Show them labelled, or keep the §7 rule of drawing nothing without a region?
8. **The cookie bridge,** if spike 2 passes: acceptable, given the route rides in request
   headers for those minutes?
9. **Android `share_target`:** worth a service-worker change?

---

## 7. Out of scope, with reasons

- **Hosted short links, per-route previews, revocation.** These need a write endpoint (§3
  "runtime servers: zero"; §8 item 5). The server would also hold people's routes, which is
  location data, and that reopens the UK-residency reasoning of §8 item 8.
- **Live location sharing.** It needs a relay, and background geolocation, which §7 says no
  browser has.
- **Collaborative editing and shared collections.** These need accounts and sync (§8 item
  5).
- **KML, FIT and TCX import.** GPX is the common export format of the planning apps
  people already use. Revisit if asked.

---

## 8. Cost

£0. No infrastructure, no artifact, and no change to the bucket or egress. The bundle gains
a small codec, a QR encoder and, only if Stage C scans in-app, a decoder, both of the last
two lazy-loaded.

---

## 9. Acceptance (once built)

Airplane Mode throughout, unless stated.

1. Phone A plans a route with one straight leg and shares it as a link. Phone B, which has
   the region, opens it: the same legs, the straight one dashed, the same distance to the
   metre. Follow it.
2. Phone B **without** the region, online: the route draws, the distance is exact, the
   covering region and its size are offered, and Save as GPX produces a file another app
   opens.
3. Truncate the link by one character: "damaged", and nothing drawn.
4. A compact QR code from A, scanned by B with the region: the same route, with the check
   passing. A compact link made by a build with an older `ROUTER_VERSION` warns.
5. Export a route as GPX and import it: waypoints, legs and the straight leg are all intact.
6. iOS: a link in Messages opens Safari. Copy there and paste in the installed app; the
   route opens. (With Stage D: install from the link and the route is there on first
   launch.)

---

## 10. Proposed spec changes (on approval)

- **C20:** a shared route is self-contained (geometry, or waypoints plus a check) and never
  a server-side id. The format is versioned and integrity-checked, and refused rather than
  half-read when it isn't understood.
- **C21:** a received route is untrusted input: bounded, validated, rendered as text.
- **§7:** "On iOS a shared link opens in Safari, not the installed app; paste it in." And:
  "A compact link needs the recipient to have the region."
- **§2:** the §2.1 measurements and the §2.2 table, in the existing dated style.
