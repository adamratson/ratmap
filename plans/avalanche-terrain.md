# Avalanche terrain — an optional layer, no live data

**Status: Stage A built — pipeline and map layer.** Written and implemented 2026-09-08;
see §6's status block for what is done and what is not. Destined for
`docs/IMPLEMENTATION.md` as **Phase 4.6**, in the same slot Phase 4.5 (SAC) occupies — an additive
per-region artifact under C16, no migration, no runtime compute, no new infrastructure.

Numbers in §3 were measured this session against real Copernicus data over Ben Nevis, not
estimated. §2 exists because two of the three obvious ways to build this produce a map
that is confidently, plausibly, and lethally wrong.

---

## 1. What this can be, and what it must never claim to be

Avalanche danger is **terrain × snowpack × weather**. Offline, with no bulletin, no
weather and no observations, this app has exactly one of the three, permanently.

So the layer is **avalanche terrain**: the static shape of the ground, and where that
shape is capable of producing or receiving an avalanche. It answers *"could this slope
slide, on terrain grounds alone"*. It cannot answer *"will it today"*, and nothing in the
UI may imply otherwise.

That is not a caveat bolted on at the end — it is the product decision that fixes the
name, the legend, the tap sheet and the route summary:

| Never | Always |
|---|---|
| "Avalanche risk" | **"Avalanche terrain"** |
| "Danger: high" | "Slope 38° — in the range where slab avalanches release" |
| A red/amber/green scheme borrowed from a bulletin's 1–5 danger scale | A scheme that is visibly *not* a danger scale (§5) |
| Silence about what the layer does not know | A standing line: *terrain only — this layer has never seen the snow* |

This is the same discipline as §4.5's ungraded-path problem, with a worse failure mode. A
walker reading an ungraded path as easy has a bad day; someone reading a terrain layer as
a forecast can die of it. Every honesty requirement in this document is load-bearing.

**It should also, plainly, tell people to get the forecast.** Where a national avalanche
service exists, the tap sheet names it and links out — a link is not live data, it costs
nothing offline, and it is the single most useful thing this feature can say.

---

## 2. Hard constraints

Same convention as `docs/IMPLEMENTATION.md` §1: each exists because the obvious approach
fails, usually silently.

| # | Constraint | Why |
|---|---|---|
| **A1** | **Never compute slope on a Web Mercator raster without correcting for the projection's scale factor.** Mercator is conformal, so the correction is exact: on each raster row, true ground cell size = `pixelSize × cos(lat)`. | Measured on the Ben Nevis box: the correct method finds **11.8%** of the terrain at ≥30°; `gdaldem slope` run straight on the 3857 raster finds **0.6%**. A real 36° slope reads as 21°. The map looks entirely normal. This is the single most dangerous mistake available in this feature. |
| **A2** | **`gdaldem slope -s 111120` on the EPSG:4326 source is also wrong.** | It treats a degree of longitude as the same ground distance as a degree of latitude. It is not: it is `cos(φ)` of it. Measured at 56.8°N: **6.0%** of terrain at ≥30° against a true 11.8%. The error is zero at the equator and worst where the mountains and the snow are, so it will never be caught by a spot check in the wrong place. |
| **A3** | **The tiles must be losslessly encoded, and the pipeline must prove it per build.** | GDAL's MBTiles driver has no lossless option for WebP — only `QUALITY`, which is lossy at every value **including 100** (verified: `gdalinfo --format MBTiles`). Measured round-trip: a channel written as the constant 128 came back spread over **92–133**, and a channel written as constant 0 came back over **0–19**. Decoded as a DEM, one corrupted byte in the high channel is a **±9216°** error. PNG round-trips exactly; `cwebp -lossless -exact` round-trips exactly and is 64% of PNG's size. |
| **A4** | **Pyramid levels must reduce by *maximum*, never by average or bilinear.** | Averaging dissolves a 40° gully inside a 25° hillside as you zoom out — the layer quietly stops warning about exactly the feature it exists for. **GDAL cannot do this at all**, by either route: `gdaladdo -r max` answers "Unsupported resampling method" outright, and `gdal_translate -tr … -r max` — which this document originally recommended — only *warns* ("GDAL_RASTERIO_RESAMPLING = max not supported") and silently falls back to nearest. The first pyramid built here went out that way and looked entirely normal. So the reduction is done in numpy (`encode-avalanche.py`), and the build asserts the maximum slope is unchanged at every level. Note `fetch-dem.sh` and the prominence build hit the same fallback; that is known and documented in `compute-prominence.py`. |
| **A5** | **Cap the artifact at the source DEM's own resolution, and render it blockily above that.** | Copernicus GLO-30 is ~30 m. z11 at 512 px is 20.9 m at 57°N, 38 m at the equator; z13 would be 5 m, which is invented detail presented as measurement. Above the native zoom, `resampling: nearest` so the user sees the real cell grid. A smooth lie is worse than a visible one. |
| **A6** | **A slope layer alone under-warns, structurally — say so until Stage B ships.** | It colours the start zone and leaves the runout white. The classic fatal error is standing on 10° ground beneath a 38° slope; this layer paints that spot as untouched. Until the runout channel exists, the legend and tap sheet must state that the layer does not know what is above you. |
| **A7** | **Below the draw threshold the raster stores 0, and 0 means "below 25°", not "measured flat".** | Same rule as an ungraded SAC path. The clamp is a compression decision (§3), not a statement about the ground. |
| **A8** | **Opt-in per region**, gated on `"avalanche": true` in `infra/regions.json`, exactly as `"contours": true` gates the contour build. | The catalogue is global and this is a mountain artifact. Building it for Bangladesh is bytes and CPU spent on nothing. |
| **A9** | **A later channel means a new filename, not a rebuilt artifact.** | `downloadArtifact` skips on `hasArtifact(artifact.filename)` alone (`src/regions/downloader.ts:355`). A rebuilt file under the same name is never re-fetched, so an already-downloaded region would keep the stale copy forever with nothing on screen to say so. Hence `<id>-avalanche-1.pmtiles` — the trailing integer is the content version, and Stage B publishes `-2`. |
| **A10** | **Attribute Copernicus, and do it in the source declaration.** | The Copernicus DEM licence is free worldwide with attribution required. **Pre-existing bug this surfaces:** `region-layers.ts` declares the *contours* source with `OSM_ATTRIBUTION`, but contours come from Copernicus GLO-30 via `build-contours.sh`, not from OSM. Fix that in the same change — attribution is already a hard requirement in this app. |
| **A11** | **Every one of `redFactor` / `greenFactor` / `blueFactor` must be non-zero.** | Found by reading `packDEMData()` before running anything. MapLibre packs the colour ramp's *own* elevation stops back into RGB with `minScale = min(red, green, blue)` and then divides by it — one zero factor makes `minScale` zero, every stop `NaN`, and the shader's binary search over the stop texture collapses. It does not throw and it does not warn. This killed the first channel layout outright (§4), and no amount of looking at the map would have explained why. |
| **A12** | **`color-relief-color` must be an `interpolate` expression — never `step`.** | `_createColorRamp()` only reads stops when the expression is an `Interpolate`; anything else leaves the ramp empty and falls back to a single transparent stop, so the layer renders **nothing** with no error. Hard class bands come from duplicating each stop at its band edges, not from `step`. |

---

## 3. Measured this session

Test box `-5.2,56.65,-4.8,56.95` — 809 km² of Lochaber, Ben Nevis in the middle. Source
is Copernicus GLO-30 through `fetch-dem.sh`, warped to EPSG:3857 at z11/512 px
(38.2185 units/px = 20.9 m ground at 56.8°N).

### The projection trap, quantified

| Method | mean | p95 | max | ≥30° | ≥35° |
|---|---|---|---|---|---|
| **Correct** — 3857, per-row `cos(lat)` cell size | 15.6° | 35.9° | 66.4° | **11.8%** | **5.9%** |
| `gdaldem slope` on the 3857 raster, no correction | 9.0° | 21.7° | 51.6° | 0.6% | 0.2% |
| `gdaldem slope -s 111120` on the 4326 source | 12.9° | 31.3° | 65.9° | 6.0% | 2.7% |

Both wrong methods produce a coherent, believable relief map. Neither produces an error
message. The naive-Mercator run erases **95% of the avalanche terrain in Lochaber**.

### Artifact size

PNG tile blobs, z8–z11 pyramid, slope clamped `<25° → 0`, `>60° → 60`, 1° quantisation:

| Contents | test box | per km² | Scotland (78,800 km²) | as lossless WebP |
|---|---|---|---|---|
| Slope only | 562 KB | 0.69 kB | 53 MB | **34 MB** |
| Slope + aspect, aspect masked to cells the slope layer draws | 662 KB | 0.82 kB | 63 MB | **40 MB** |
| Slope + aspect everywhere | 1135 KB | 1.40 kB | 108 MB | 69 MB |

Three things follow:

- **The clamp is the size lever.** Unclamped 1°-precision slope measured 3100 KB against
  562 KB clamped — 5.5×, for information the layer never draws. 80.1% of the box falls
  below 25° and collapses to a single value that compresses to nearly nothing.
- **Aspect is only cheap if it is masked.** Everywhere: +102%. Masked to the cells where
  slope ≥ 25°: **+18%**. Aspect on a 12° meadow is noise in both senses.
- **Against Scotland's 646 MB basemap this is ~6%.** Affordable. The test box is
  mountainous, so 0.69 kB/km² is near the worst case for the regions this is enabled on,
  and small-box tile-alignment padding makes the extrapolation conservative rather than
  optimistic.

### Renderer support

- `maplibre-gl` **5.24.0** is installed and has the **`color-relief`** layer type.
  `color-relief-color` is a `color-ramp` property parameterised on `["elevation"]`, plus
  `color-relief-opacity` and `resampling` (`linear`/`nearest`). The style spec validator
  requires a **`raster-dem`** source and rejects any other layer type on one.
- `raster-dem` supports **`encoding: "custom"`** with `redFactor` / `greenFactor` /
  `blueFactor` / `baseShift`, so the decoded value can be made to *be* the slope in
  degrees rather than a terrarium offset hack.
- `pmtiles://` → `raster-dem` is already proven on a real iPhone (§2 spike 1 of the main
  spec, hillshade). `color-relief` on that path is now proven in **WebKit** too — see the
  spike below.

### The spike, run (2026-09-08) — `spike/`

A self-verifying page (`spike/color-relief.html`) over a real archive built from the
measurements above: Copernicus GLO-30 across the Ben Nevis box, slope with the A1
correction, 1° quantised, PNG tiles, `pmtiles convert`. It jumps to eight cells whose 5×5
neighbourhood is a single slope class, reads the pixel back off the GL canvas, and compares
it to the colour the ramp must produce; then it decodes the same tiles through
`createImageBitmap` and requires the channel integers back **exactly**. Nothing is judged
by eye. Run it with `node spike/run.mjs [chromium|webkit]` against `npm run dev`.

**All three engines: 15 / 15, exact.** Not within tolerance — identical values.

| Engine | Result |
|---|---|
| Chromium 151 (headless) | PASS — 15 checks |
| WebKit 605.1.15 / Safari 26.5 (Playwright, macOS) | PASS — 15 checks |
| **iOS Safari 26.4 — iPhone 17 Pro simulator, iOS 26.4** | **PASS — 15 checks** |

What that establishes: `color-relief` over a `pmtiles://`-fed `raster-dem` with
`encoding: 'custom'` renders the right colours in WebKit; hard class bands from duplicated
`interpolate` stops work; overzoom from a z11 archive to z15 with `resampling: nearest`
gives clean cell edges; the aspect channel riding under the slope does not shift the
rendered class; and the sampler path recovers slope and aspect as exact integers under
`colorSpaceConversion: 'none'`.

**What it does not establish.** The iOS run is the **simulator**, which is real iOS Safari
and the real iOS WebGL stack but draws on the Mac's GPU through Metal, not on Apple silicon
in a phone. So the one thing still open is a device GPU/driver difference in shader
compilation or texture precision. For a fragment shader doing a dot product and a binary
search over a 14-texel ramp, that is a narrow risk — and note the main spec's insistence on
a *physical* iPhone (§2) was about storage policy and Wake Lock, neither of which is in
play here. Worth one look on the phone when the layer is next in front of one; not worth
blocking on.

Battery and thermals are also untested: a full-screen `color-relief` pass every frame is
cheap on a Mac GPU and not obviously cheap on a phone. Measure it on hardware before the
layer defaults to anything other than off.

Three things the spike cost, all of them silent failures worth knowing about:

- **A11** (zero factors → `NaN` ramp stops) — found by reading `packDEMData()` first. It
  would have rendered nothing, with no error, and no way to reason back to the cause.
- **A12** (`step` yields an empty ramp) — same class of failure, found the same way.
- MapLibre v5 moved `preserveDrawingBuffer` into **`canvasContextAttributes`**, and drops
  the stale top-level option in silence. The map renders correctly and every readback comes
  back transparent black — which reads exactly like "the layer drew nothing". Only relevant
  to test harnesses, but it is the reason the first spike run reported 7/7 failures against
  a map that was, in the screenshot, plainly correct.

---

## 4. The artifact

**`regions/<id>/<id>-avalanche-1.pmtiles`** — one 512 px RGB raster pyramid, kind
`avalanche`, per region, opt-in. Three independent fields packed into three channels:

| Channel | Field | Encoding |
|---|---|---|
| **R** | **Slope**, whole degrees | `0` = below 25°; `25`–`60` = the drawn range; `60` = 60° and above |
| **G** | **Aspect octant** | `0` = slope is 0 (nothing to say); `1`–`8` = N, NE, E, SE, S, SW, W, NW |
| **B** | **Runout exposure** | Stage B. The minimum travel angle at which this cell is reachable from a potential release area, in degrees. `0` until Stage B ships. |

The map source declares only the slope:

```js
map.addSource(sourceId, {
  type: 'raster-dem', url,
  encoding: 'custom', redFactor: 1, greenFactor: 1 / 256, blueFactor: 1 / 65536, baseShift: 0,
  attribution: COPERNICUS_ATTRIBUTION,
});
```

so the "elevation" `color-relief` ramps over **is the slope angle in degrees**, with no
decoding arithmetic anywhere in the style.

**Slope is in R, and the factors are all non-zero, because of A11.** The obvious layout —
slope alone in G at `greenFactor: 1` with the other two factors zeroed — cannot work.
Putting slope in R at factor 1 instead lets the other two channels ride underneath it:
G contributes at most `8/256` = **0.031°** and B at most `90/65536` = **0.0014°**. Both sit
far inside a 1° quantisation and a 5° class, so what the ramp sees is the slope. The exact
channel values are never read from here — the sampler (§6) decodes the tile itself.

**Why 1° quantisation.** Avalanche slope classes are 5° wide, so 1° is already finer than
the decision. It cuts the artifact 5.5×, it makes per-channel `max` reduction exactly
equal to max-of-slope (A4), and it is far below the error a 30 m DEM carries anyway
(§7 — a 30 m grid smooths small steep features and *understates* them).

**Zoom range.** `z8` to the largest z where the tile pixel is no finer than the source
DEM: `floor(log2(40075017·cos(φ) / (512 · 30)))` at the region's centre latitude, clamped
to `[9, 12]`. z11 in Scotland, z12 in the Alps and the Rockies, z12 near the equator. The
manifest already records each artifact's real `minzoom`/`maxzoom` from its PMTiles header,
so the app's detail notice keeps telling the truth with no extra plumbing.

---

## 5. Cartography

The palette has one job beyond legibility: **it must not read as a danger scale.** A
green→amber→red ramp is the visual grammar of every avalanche bulletin in the world, and
borrowing it would assert exactly the thing §1 forbids.

Proposal, to be settled with §8.3's other open cartographic calls:

| Class | Meaning | Treatment |
|---|---|---|
| < 25° | Below the threshold this layer draws | Nothing — the map underneath, unchanged |
| 25–29° | Rare release, but runout and terrain traps live here | Lightest tint |
| 30–34° | Release becomes common | |
| 35–39° | **The peak of the distribution** — most slab avalanches release here | Strongest tint |
| 40–44° | Frequent, smaller, more often loose-snow | |
| ≥ 45° | Sluffs continuously, rarely builds slabs | Distinct treatment, *not* "more of the same" |

Two design points that fall out of the domain rather than from taste:

- **The ramp is not monotonic.** ≥45° is not "worse" than 35–39° — it is a different
  failure mode, and a ramp that keeps intensifying past 45° teaches the wrong thing. Give
  it a hatch or an outline rather than a hotter colour.
- **`resampling` steps to `nearest` above the artifact's native zoom** (A5), via
  `['step', ['zoom'], 'linear', <native+1>, 'nearest']`.

Drawn beneath the region's own labels and beneath the SAC bands, via the existing
`beneathLabels()` helper — same stack position as hillshade and contours, for the same
reason.

**Default off.** This is an optional layer, and a map that arrives pre-shaded in six
colours is not a map most walkers want in June.

---

## 6. Work

### Pipeline — `infra/`

**`scripts/build-avalanche.sh <region-id>`**, modelled on `build-contours.sh` (same DEM
source, same per-region gate, same verify-then-rename discipline):

1. `fetch-dem.sh` for the region bbox → Copernicus GLO-30 clip, as contours already do.
2. `gdalwarp -t_srs EPSG:3857 -tr <native-z res> -r bilinear -tap`.
3. Slope and aspect in one numpy pass, **with the per-row `cos(lat)` cell size (A1)**;
   Horn's 3×3, matching `gdaldem`'s method. Clamp, quantise, mask aspect, pack RGB.
4. Pyramid: level by level with `gdal_translate -tr … -r max` (A4), each level encoded
   separately.
5. Tiles as **PNG** (A3), then a post-pass re-encoding each to lossless WebP with
   `cwebp -lossless -exact` — 64% of the size, byte-identical after decode (measured).
   Skippable via a flag; PNG alone is correct, just larger.
6. `pmtiles convert`, `pmtiles verify`, then rename into place.

**Build assertions**, in the spirit of `build-peaks.sh`'s Ben Nevis 1345 m check and
`build-sac.sh`'s grade check — a silent slope regression is precisely the failure this
feature cannot survive:

- Pin the **class histogram for a fixed reference box** (the Lochaber box above:
  11.8% ≥30°, 5.9% ≥35°) and fail on drift beyond a tolerance. This single assertion
  catches A1, A2 and A4 at once — every one of them moves that histogram by a factor.
- Assert the **round trip**: decode a written tile and require the recovered slope to
  equal the input exactly. This is the A3 tripwire, and it is the one that would have
  caught the lossy-WebP corruption before publication rather than after.
- Assert **`max` reduction**: the maximum slope at each pyramid level is
  non-decreasing towards the coarse end.

**Also:** `ARTIFACT_KINDS` in `build-manifest.py` gains `"-avalanche-1.pmtiles":
"avalanche"` — per its own comment, that is all publishing a new kind takes. `regions.json`
gains `"avalanche": true` on the mountain regions; the docker `build-global.sh` loop
gains the same gate contours use. No change to `build-region.sh` — this artifact is
generated, not extracted, so it sits beside contours rather than inside the extract loop.

### App — `src/`

| File | Change |
|---|---|
| `src/avalanche.ts` *(new)* | Class table, palette, `color-relief` ramp expression, legend copy, the standing "terrain only" line. The `sac.ts` shape: one module owning the domain, its colours and its honesty. |
| `src/regions/region-layers.ts` | An `avalanche` branch: `raster-dem` source with the custom encoding, one `color-relief` layer, inserted at `beneathLabels()`. Plus the A10 contours-attribution fix. |
| `src/avalanche-sampler.ts` *(new)* | Slope/aspect/runout at a point, by decoding the artifact's tiles directly. `TerrainSampler` already does exactly this — tile fetch, LRU cache, `premultiplyAlpha: 'none'`, `colorSpaceConversion: 'none'`, bilinear sampling — so this is that class generalised over which channels it reads, not a second copy. **Nearest, not bilinear, for slope**: interpolating across a class boundary invents a value that is in neither cell. |
| `src/main.ts` | Settings toggle (default off); the layer's own line in the legend; slope/aspect/nearest-forecast-service in the coordinate and peak tap sheets. |
| `src/routes/profile.ts` + the route panel | Per-class distance breakdown along a planned route, exactly like the SAC breakdown — "1.2 km crosses ground at 30–35°" — plus the maximum slope crossed. This is where the layer earns its place: it turns a map you look at into a number about the route you are about to walk. |
| `src/style.css` | Palette variables, light and dark, per `sacCssColor`'s precedent. |

### Status (2026-09-08): Stage A pipeline and map layer built

Built, tested, and verified against a real region (`liechtenstein`, the smallest genuinely
alpine entry in the catalogue — 124 kB, z11, lossless WebP):

| | |
|---|---|
| `infra/scripts/encode-avalanche.py` | slope, aspect, quantisation and the max-reduced pyramid, with a `--self-test` the build runs every time |
| `infra/scripts/assemble-avalanche.py` | per-level tiling, merge, and the lossless-WebP pass that proves itself |
| `infra/scripts/build-avalanche.sh` | the region build, gated on `"avalanche": true` |
| `build-manifest.py`, `build-global.sh`, `regions.json` | the new kind registered, an `avalanche` stage, the flag on one region |
| `src/avalanche.ts` | classes, palette, `color-relief` ramp, encoding, the Settings toggle's state |
| `src/regions/region-layers.ts` | the `avalanche` branch — plus the A10 contours attribution fix |
| `src/main.ts`, `src/style.css` | Settings toggle (default off), legend section, palette in both themes |
| `src/avalanche.test.ts`, `test/avalanche-palette.test.ts`, `test/avalanche-archive.test.ts` | 17 tests; the archive one asserts the **published bytes**, skipping without build output or GDAL |

Full suite 495 passing, both typechecks clean. The built artifact renders correctly through
the shipping ramp and encoding — `spike/region-check.html` imports from `src/avalanche.ts`
and reads `infra/dist` directly, so it always shows the current build rather than a copy.

Four things the build taught, all now encoded in the scripts:

- **`gdal_translate -r max` does not do what it says.** GDAL answers
  "GDAL_RASTERIO_RESAMPLING = max not supported", warns, and falls back to nearest — so the
  first pyramid was silently built the wrong way (A4). The reduction is numpy now, and the
  build asserts the maximum slope is unchanged at every level.
- **Snapping the extent to the *coarsest* zoom's tile grid is catastrophic.** A z8 tile is
  156 km across, so Liechtenstein's 18x25 km box inflated to 313x313 km — 268 megapixels of
  mostly nothing, and a class histogram diluted to 1% steep ground. Snap at `zmax`.
- **Round the zoom cap up, not down.** Rounding down put an alpine region on 52 m cells
  against a 30 m DEM; under-resolving smooths gradients and reports terrain as gentler than
  it is, which is A1's direction of error by another route.
- **Never build below the zoom the app draws at.** `region-layers.ts` suppresses region
  layers below `ceil(log2(360/span))`; for Liechtenstein that is z11, so the original z8
  floor was three levels nobody would ever see.

**Cartography is not settled, and the first real region shows why.** Rendered over
Liechtenstein, ground above 25 degrees is most of the country — the layer covers nearly the
whole frame. That is a true statement about the Rätikon and a bad map. The 50% opacity, the
25-degree floor and the class colours are all defensible defaults on Ben Nevis and want a
real decision made over alpine terrain with the basemap underneath. §5 and §8.3 both stay
open, and this is now the concrete case to decide them against.

**Regions enabled and first real builds (2026-09-08).** 41 regions carry
`"avalanche": true` — see §8 decision 2 for the set and the criterion. Two are built:

| Region | raster | artifact | notes |
|---|---|---|---|
| `liechtenstein` | 0.5 Mpx | 124 kB, z11 | 16.7% of the bbox at or above 25° |
| `switzerland` | 127.4 Mpx | **40 MB**, z8–z11, 673 tiles | 29.2% above 25°, 12.9% in the 35–44° band |

Switzerland is the scaling proof, and it forced two fixes:

- **The encoder now streams.** It held the whole raster and made eight `np.roll` copies of
  it — fine for Liechtenstein, about 100 GB of temporaries for Scotland's 1.6 gigapixels.
  Slope is a local 3×3 operator, so it now runs in strips over memmaps with a one-row halo,
  which is bit-identical to a single pass (Liechtenstein rebuilt byte-for-byte unchanged)
  and bounded in memory whatever the region.
- **The WebP proof runs across every core.** Each tile costs a `cwebp -z 9` plus two
  `gdal_translate` decodes to prove it round-trips; sequentially that was ~25 minutes for
  Switzerland's 673 tiles and would have dominated every later build. Threads are enough —
  the time is all in subprocesses. Switzerland now builds end to end in ~14 minutes, of
  which the DEM fetch and the slope pass are ~6.

`build-catalog.py` preserves the flag across a regeneration, alongside `contours`,
`maxBytes` and `terrain` — without that, the next catalogue rebuild would have silently
dropped all 41.

**The remaining 39 regions are a `ratmap global avalanche` run**, not a laptop afternoon:
roughly 20 gigapixels of DEM to fetch and process. The stage skips what is already built,
so it resumes.

**Not yet built, from the list above:** the sampler (`src/avalanche-sampler.ts`), the tap
readout, and the per-class route breakdown. The layer renders and can be switched on and
off; it cannot yet be interrogated. Those are the next piece of work, and the archive test
already pins the channel semantics they will read.

**Not in scope, deliberately:** slope does **not** feed routing cost. Same reasoning as
§4.5's refusal to let SAC grades steer the router — a route that silently avoids a path
because of a raster cell beside it is the quiet wrongness this project is written against.
If it is ever wanted, it comes back as its own entry with the edge-matching problem stated
up front.

---

## 7. Stages

### Stage A — slope and aspect *(this plan)*

What every backcountry map ships, done correctly and offline. Deliverable on its own, and
honest about A6.

**Aspect is worth its 18%** even without a forecast: prevailing-wind lee slopes and solar
aspect are both read off it, and a walker who knows the local pattern can use it. It is
also what makes a future bulletin-aware feature (§8) a display change rather than a
rebuild.

### Stage B — runout and terrain traps

The half that makes the layer a decision aid rather than an overlay, and the answer to A6.

- **Potential release areas (PRA):** cells at 28–55°, with a minimum connected area so
  single noisy pixels do not seed a runout. (Above ~55° snow sluffs continuously and
  rarely builds a slab; below 28° release is rare.)
- **Runout:** propagate downslope from each PRA and record, per cell, the minimum travel
  ("alpha") angle at which it is reached. 23° is the extreme-runout convention in Swiss
  and Canadian hazard mapping, 27–30° covers typical events — so the stored angle lets the
  app draw either without a rebuild.
- **Use [Flow-Py](https://github.com/avaframe/FlowPy) rather than rolling our own.** It is
  published, open source, and does exactly this with a priority-queue propagation; a naive
  all-pairs alpha-angle search is O(n²) and will not finish on a region. GPL, but it is a
  build-time tool processing our data, not linked into the shipped app.
- Ships as `-avalanche-2.pmtiles` (A9), the B channel filled in. Nothing else changes.

**Verify before building on it:** Flow-Py's runtime and memory on a full region bbox is
unknown here, and the contour build already taught this pipeline that a per-region raster
step can hit 9.8 GB RSS (`build-contours.sh`'s SQLite note). Measure on the Lochaber box
before enabling a region the size of Scotland.

### Stage C — AutoATES — deferred, with reasons

Automated ATES (the Avalanche Terrain Exposure Scale: simple / challenging / complex)
exists as a published open method and would be the natural end point. It needs, on top of
Stage B, **forest density** — which is what separates challenging from complex terrain in
practice and which we have no global source for. OSM's `natural=wood` / `landuse=forest`
gives extent but not density or canopy height, and treating "there is a polygon here" as
"this forest anchors a slab" is a guess dressed as a classification.

It is also validated regionally, not globally. Shipping a four-class terrain rating over a
worldwide catalogue on the strength of a model tuned in the Canadian Rockies is a larger
claim than this project should make quietly. **Open decision (§8), not a planned stage.**

---

## 8. Before building

**The architecture spike is done and passed in iOS Safari** (§3) — `color-relief` over a
`pmtiles://` `raster-dem` with `encoding: 'custom'`, plus exact channel recovery through
the sampler, 15/15 exact on an iPhone 17 Pro simulator running iOS 26.4. The fallback it
was guarding against (a pre-coloured `raster` layer, losing the dark theme, the tap readout
and any future threshold control) is not needed. **This phase is unblocked.**

Two small things to fold into the next session with a physical phone, neither a gate:
the same page on device silicon (§3), and a battery/thermal look at a full-screen
`color-relief` pass.

The wider on-device gap from the main spec (§4 Phase 6) is unchanged and unrelated: no part
of this app has ever been verified on a physical iPhone beyond the download path.

### Acceptance

Airplane Mode throughout, region downloaded:

1. Toggle the layer on from Settings; it renders over the region and disappears cleanly
   when toggled off.
2. **A known 35–40° slope reads 35–40°** on tap. The Ben Nevis reference box's histogram
   is the automated version of this; a human check on one named face is the version that
   catches a co-ordinate transposition.
3. Zooming from z11 to z16 makes the cell grid visible rather than smoothing it (A5), and
   zooming *out* to z8 does not make the steep ground disappear (A4).
4. A planned route reports a per-class distance breakdown and a maximum slope crossed.
5. The tap sheet and legend both state that the layer is terrain only and has not seen the
   snow, and the sheet links to the relevant national avalanche service.
6. Force-quit, relaunch, still offline → all of the above, unchanged.
7. Rebuild the artifact as `-avalanche-2.pmtiles` and confirm the catalogue row offers
   **Update** quoting only the new file's bytes (the §4.5 `update`-vs-`partial` path).

### Cost

One more per-region static file, ~34 MB for Scotland as lossless WebP against a 646 MB
basemap. No new infrastructure, no runtime compute, £0. Storage against the Krystal 250 GB
floor is the only real consideration, and only if it is enabled broadly — which is what
A8's opt-in gate is for.

### Open decisions — ask Adam, do not guess

1. **Aspect in Stage A, or slope only?** +18% for a field that is genuinely useful and
   genuinely hard to interpret without a forecast. Recommendation: **include it** — the
   marginal cost is small and adding it later is a filename bump and a re-download.
2. ~~Which regions get `"avalanche": true`?~~ **Decided 2026-09-08: 41 regions, the
   European alpine set.** Not the 62 contour-enabled regions — contours are useful in the
   Peak District and this is not. The criterion is *terrain covered by an avalanche
   warning service, or with documented avalanche activity*, which is a real-world signal
   that the hazard exists rather than a guess from topography alone:

   | Range | Regions |
   |---|---|
   | Alps | `switzerland` `austria` `liechtenstein` `rhone-alpes` `provence-alpes-cote-d-azur` `oberbayern` `schwaben` `nord-ovest` `nord-est` `slovenia` |
   | Pyrenees | `andorra` `midi-pyrenees` `aragon` `cataluna` `navarra` `aquitaine` |
   | Scotland | `scotland` (SAIS forecast area) |
   | Scandinavia & Iceland | `nord-norge` `vestlandet` `ostlandet` `trondelag` `sweden` `iceland` |
   | Carpathians & Tatras | `slovakia` `malopolskie` `romania` `ukraine` |
   | Balkans | `bulgaria` `montenegro-region` `bosnia-herzegovina` `albania` `kosovo` `macedonia` |
   | Iberia outside the Pyrenees | `andalucia` (Sierra Nevada) `asturias` `cantabria` `castilla-y-leon` (Picos de Europa) |
   | Caucasus & Anatolia | `georgia` `turkey` |
   | Apennines, Corsica | `centro` (Gran Sasso, Sibillini) `corse` |

   **Two deliberate exclusions, on proportionality rather than on the terrain.**
   `morocco` (the High Atlas is genuinely avalanche-prone and people die there) and
   `svalbard-janmayen` are both catalogue entries whose *bounding box* is mostly desert or
   ocean — 10.4 and 4.5 gigapixels of raster respectively, against Switzerland's 112 Mpx,
   for a small fraction of relevant ground. Worth adding if either bbox is ever split, or
   if the build cost is acceptable on the day. Also left out and easy to add: `serbia`,
   `croatia`, `greece`, `wales`, `england-north-west`, the Czech Krkonoše regions
   (`liberecky`, `kralovehradecky`), `finland`, `cyprus`, `faroe-islands`.

   **The cost is compute, not storage.** The 41 regions are ~5.4 GB of artifact at the
   all-mountain rate and far less in practice, against a 250 GB allowance — but they are
   ~20 gigapixels of DEM to fetch and process, which is a `ratmap global avalanche` run on
   the docker box, not a laptop afternoon. The per-region builds are independent and the
   stage skips what is already built, so it resumes.
3. **The palette (§5)** is a cartographic call, and joins §8.3's existing queue. The
   non-monotonic ≥45° treatment in particular wants a real opinion.
4. **Stage C / AutoATES** — worth pursuing at all, given the forest-data gap and the
   regional-validation problem? A "no" here is a perfectly good answer and shortens this
   feature considerably.
5. **Is a bulletin ever in scope?** Not as live data in the app — but a *manually entered*
   danger level and problem aspect ("Considerable, N through E, above 900 m", typed in at
   the trailhead while there is still signal) would let the terrain layer highlight exactly
   the terrain the forecast names, offline, all day. That is the highest-value thing this
   layer could grow into and it stays inside the no-third-party-data constraint. It is a
   different feature; flagging it here so the aspect channel is not designed away.
