# Scree, boulder fields and bare rock — a terrain-features artifact

**Status (2026-09-18): built and verified against real data.** Written the same day after
[the bare-rock styling fix landed](../src/landuse.ts) surfaced the harder half of the same
question. Kind string settled as `terrain-features` and the layer ships always-on (Adam's
call — §9 decisions 2 and 3, no longer open). Destined for `docs/IMPLEMENTATION.md` as a
Phase 4/5 entry (own number TBD) once this lands on `main`.

**What's actually built, not just planned:**

- `infra/scripts/normalize-terrain-features.py` and `infra/scripts/build-terrain-features.sh`
  — ran end-to-end against real cached extracts (`scotland-latest.osm.pbf` +
  `montenegro-latest.osm.pbf`). Produced `terrain-features-global.pmtiles`, 5.1 MB,
  z11–15, `pmtiles verify` clean. Found and fixed a real bug in the process: `osmium
  export` emits a closed way twice by default (a raw LineString *and* the assembled
  MultiPolygon) — `--geometry-types=point,polygon` drops the duplicate at the source. Also
  found that `osmium tags-filter`'s relation handling pulls in unrelated-tagged multipolygon
  members (1,176 stray `coastline`/`heath`/`wood`/etc. features in the Scotland-only run),
  which is why `normalize-terrain-features.py`'s kind check is load-bearing, not just
  defence in depth. Both are documented in the scripts themselves, not just here.
- `build-manifest.py` and `build-region.sh` wired with the new `terrain-features` kind —
  cut a real `scotland-terrain-features.pmtiles` (4.3 MB, z11–15) and confirmed it appears
  correctly in a locally-generated `manifest.json` with real min/maxzoom read from the
  archive header.
- `src/terrain-features.ts` (new) — the fill + point layers, palette and coverage-caveat
  text. `src/regions/region-layers.ts` wired with a `terrain-features` branch. A legend
  section in `src/main.ts`. Full test suite (508 tests) and `tsc --noEmit` clean.
- **Visually verified against the real built archive**, not just unit-tested: a standalone
  MapLibre page loaded `scotland-terrain-features.pmtiles` directly and rendered the exact
  paint expressions from `src/terrain-features.ts`. Centred on a real named feature found
  in the data ("Caerketton Screes", Pentland Hills) — the fill, the point markers for
  nearby rock outcrops, and the name label all rendered correctly at real map zoom.

**Not done:** nothing uploaded (`upload.sh` was not run — that touches the live bucket and
needs explicit sign-off), and no on-device/production verification. The §8 acceptance
checklist below still describes what "done" means once this is live.

---

## 1. What's already done, and what this covers

**Already shipped (separate change, not this plan):** `natural=bare_rock` polygons ride in
every basemap archive already — Protomaps' own ingestion puts them in the `landuse`
source-layer at minzoom 2 — but no flavor's generated style paints them.
[`src/landuse.ts`](../src/landuse.ts) splices a fill rule in after `landuse_park`. Zero new
data, zero pipeline change, done.

**This plan is the harder half:** `natural=scree`, `shingle`, `rock`, `stone` are not
carried by Protomaps' OSM ingestion *at all* — confirmed by reading `Landuse.java` directly,
not assumed. Getting real coverage means a new OSM-sourced global artifact, cut per region,
same shape as `sac-global.pmtiles` (Phase 4.5) and `paths-global.pmtiles` (also 4.5): a tag
the basemap has no room for, built once globally, delivered as a per-region cutout.

**Not in scope:** landcover *classification* generally (e.g. distinguishing grass from
heath), or anything requiring DEM computation. This is a tag-extraction pipeline like SAC,
not a raster pipeline like the avalanche-terrain plan — there is no projection trap here,
no slope math, no A1-class hazard.

---

## 2. Evidence

Checked directly against taginfo (2026-09-18), not estimated:

| `natural=` value | Global uses | What it is |
|---|---|---|
| `scree` | 396,425 | Loose rock fragments, usually mapped as an area |
| `rock` | 249,615 | A rock/outcrop, mapped as node or small area |
| `stone` | 92,790 | A single large boulder, almost always a node |
| `shingle` | 87,731 | Loose rounded stones, usually an area (often coastal as well as montane) |
| — for scale — `peak` | 1,107,510 | |
| — for scale — `bare_rock` | 1,326,640 | Already covered (§1) |

There is no `natural=boulder` in real-world use — an isolated boulder is `natural=stone`;
a boulder *field* is generally mapped as `natural=scree` or `natural=bare_rock` with no
distinguishing sub-tag, which is a real limitation carried into §5.

**Geometry mix and regional density — measured, not guessed (2026-09-18).** The two
questions this section originally left open, checked directly against a live Overpass
mirror (`overpass.kumi.systems`, a real global instance — `overpass-api.de` itself and
several other public mirrors were unreachable from this session's network, and
`overpass.osm.ch` turned out to be a Switzerland-only extract, caught by getting zero
results for a Scotland bbox and 4,886 `scree` ways for a Swiss Alps bbox on the same
query). Counted over the exact Lochaber test box (`-5.2,56.65,-4.8,56.95`) the avalanche
plan already established as this project's reference region:

| `natural=` | nodes | ways | total |
|---|---|---|---|
| `scree` | 0 | 46 | 46 |
| `shingle` | 0 | 19 | 19 |
| `rock` | 2 | 1 | 3 |
| `stone` | 1 | 0 | 1 |
| — for comparison — `bare_rock` | 0 | 74 | 74 |

**Geometry mix answered cleanly: 66/69 (96%) are ways.** `scree` and `shingle` are 100%
ways in this sample, matching `bare_rock`'s own 100%-way pattern. Points (`rock` nodes +
the one `stone`) are 3 features total — real, but a rounding error. This resolves §9's
original open decision 1: **ship both**, fills for the ways and markers for the points —
there's nowhere near enough point density for the "clutter" failure mode §4 worried about
to be a real risk, so there's no tradeoff left to weigh a fill-only layer against.

**Also found while measuring: none of the 65 scree/shingle ways in this box carry a
`name` tag.** Unlike SAC grades, scree polygons are essentially always unnamed. §6's build
assertion needs to change shape because of this — see that section.

**Regional density confirmed lopsided, same shape as SAC's 7% (§4.5).** 69 non-bare_rock
features across 809 km² is ~0.085/km². Naively scaled to Scotland's ~78,800 km²
(the figure the avalanche plan measured) that's a back-of-envelope ~6,700 features — an
order-of-magnitude estimate from one small box, not a real count, and Switzerland's Alps
box alone returned 4,886 `scree` ways by itself, so density varies by well over an order of
magnitude between ranges exactly as SAC coverage did. **Still needs a real per-region count
before publishing a Scotland number** — this only establishes that the lopsidedness is
real, not what to do about it (nothing — §5 already prices in uneven coverage as a
standing legend caveat, the same posture as SAC).

---

## 3. The artifact

`terrain-features-global.pmtiles`, source-layer `terrain_features`, one property `kind` ∈
`scree | shingle | rock | stone`, built the same way `sac-global.pmtiles` is:
`osmium tags-filter` per source extract → `osmium export` to line-delimited GeoJSON →
a normalize pass → `tippecanoe` → `pmtiles convert`.

**No free-text parsing needed** — unlike `sac_scale`'s 184-value enum, these are already
clean OSM values. `normalize-terrain-features.py` exists mainly to attach `kind`
uniformly, not to parse anything. §2's geometry-mix measurement means there's no
point-drop decision to make here after all: keep nodes and ways both, tagged the same
`kind`, and let the style layer (§4) draw fills for one and markers for the other.

**Attribution: OSM, not Copernicus** — this is a tag extract like SAC and paths, not a DEM
derivative like contours or avalanche terrain. Use `OSM_ATTRIBUTION`, and watch for the
same class of bug A10 caught in the avalanche plan (a Copernicus artifact wrongly
attributed to OSM) — here the risk runs the other way, so it's cheap to get right from the
start.

**Zoom range:** matches the basemap's own landuse fade-in — `-Z11` (below this the region's
own layers are suppressed anyway, per `regionMinZoom`), `-z15` (the basemap's own ceiling).
No lower-zoom global-catalog band is proposed — scree fields are a hiking-zoom feature, not
a planning-zoom one, same reasoning that kept `paths-global.pmtiles` off the world catalog.

**Not opt-in.** Unlike avalanche terrain (a heavy DEM pipeline gated per-region), this is a
tag extract of the same weight class as SAC and paths, which ship globally. Cost is bytes
and a tippecanoe pass, not GPU-hours.

---

## 4. Cartography

Three visually distinct kinds, not one grey wash — a scree slope and a single boulder mean
different things to someone routefinding:

| Kind | Treatment | Why |
|---|---|---|
| `scree`, `shingle` | Fill, stippled/speckled texture if MapLibre's paint expressions can fake one cheaply, otherwise a flat grey-brown distinct from `bare_rock`'s tint | The one that actually matters for routefinding — scree underfoot changes the walk |
| `rock` (area) | Fill, closer to `bare_rock`'s tone but with a distinguishing edge/hatch | Outcrops are often small; needs to read at a glance next to bare_rock |
| `stone`, `rock` (point) | A small marker icon, included by default | §2 measured 3 points against 66 ways in the reference box — the "visual noise across a whole country" worry this row originally raised doesn't hold at the density actually observed; the marginal cost of drawing them is close to zero |

Inserted in the same z-order slot as the bare-rock fix (§1): among the landuse-equivalent
fills, under roads and labels, via the same `beneathLabels()`-style placement the rest of
the region artifacts use.

**Not settled — joins §8.3's existing open cartographic queue** in `docs/IMPLEMENTATION.md`
(contour interval, path styling, avalanche palette). This plan proposes a first cut, not a
decision.

---

## 5. Known limitation, state it in the product like §7's others

**Coverage will be partial, and non-uniform, the same shape as SAC's 7%.** A summit missing
its scree slope on the map is not "there is no scree there" — most of the world's `natural=`
surface tagging is incomplete. The legend entry should say this plainly rather than let an
untagged scree slope read as an untagged (and therefore assumed easy) one — same principle
as §Phase 4.5's "ungraded is not necessarily easier."

**`natural=stone` cannot distinguish a boulder field from an isolated garden rock.** OSM has
no field-vs-individual sub-tag. If points ship at all (§4), a dense cluster reads as a
boulder field by virtue of density on screen, not by any tag — worth a line in the legend,
not a blocker.

---

## 6. Work (not started)

### Pipeline — `infra/`

| File | Role |
|---|---|
| `scripts/build-terrain-features.sh` *(new)* | Modelled directly on `build-sac.sh`: same per-continent extract-then-concatenate structure (§ the history-file trap that script's comments document), same `--self-test` convention. |
| `scripts/normalize-terrain-features.py` *(new)* | Thin — attach `kind` uniformly across nodes and ways (§2 resolved the keep/drop question: keep both). |
| `build-manifest.py` | `ARTIFACT_KINDS["-terrain-features.pmtiles"] = "terrain-features"`. |
| `build-region.sh` | A `terrain-features` branch in the `--only` set and the extract loop, same shape as the existing `sac`/`paths` branches. |

**Build assertion has to take a different shape than SAC's.** SAC pins named paths
(Ben Nevis Mountain Path, Aonach Eagach) because graded ways nearly always carry a `name`.
§2 found the opposite here: none of the 65 scree/shingle ways in the Lochaber reference box
carry a `name` tag — scree polygons are essentially always anonymous. So the per-feature
named-pin pattern doesn't apply; instead, follow the *fallback* check `build-sac.sh` already
has for exactly this situation (its own comment: "the named checks only fire... this one
always fires") — pin a **count/histogram** for the reference box instead of a named feature:
this session measured `scree: 46, shingle: 19, rock: 3, stone: 1` for
`-5.2,56.65,-4.8,56.95` on 2026-09-18 (§2), which is a real number from a real build tool
(Overpass, not this project's own pipeline) and a reasonable starting pin, to be replaced
with whatever `osmium`/`tippecanoe` itself counts on the first real build — a regression
check should assert against its own pipeline's output, not against a different tool's.

### App — `src/`

| File | Change |
|---|---|
| `src/terrain-features.ts` *(new)* | Palette, filter-by-kind paint expressions, legend copy — the `sac.ts`/`avalanche.ts` shape: one module owning the domain and its honesty about coverage (§5). |
| `src/regions/region-layers.ts` | A `terrain-features` branch, modelled on the existing `sac`/`paths` branches — vector source, `OSM_ATTRIBUTION`, layer(s) from `src/terrain-features.ts`, inserted at the same landuse z-order slot the bare-rock fix uses. |
| Legend / settings | New legend rows for scree/shingle/rock, with the §5 coverage caveat in the same voice as the SAC and avalanche legend text. |

No sampler, no route-panel integration proposed — unlike SAC grade or avalanche slope, scree
underfoot doesn't have an obvious single number to report per route leg. Could change if
someone wants a "crosses scree" route callout later; not scoped here.

---

## 7. Cost

Still not a real tippecanoe/pmtiles measurement — that needs actual infra access this
session didn't use — but §2's Overpass counts sharpen the estimate past pure taginfo
extrapolation. `sac-global.pmtiles` covers ~921k ways worldwide at 13 MB for Scotland;
`scree`+`rock`+`stone`+`shingle` combined is ~826k features globally (taginfo, §2 table),
so a broadly similar weight class remains a reasonable prior, and the measured Lochaber
density (69 features / 809 km² ≈ 0.085/km², §2) scaled to Scotland's ~78,800 km² lands
around 6,700 features — same order of magnitude as SAC's 372,205-way `paths-global.pmtiles`
input was for a much smaller (z12-13-only) output, so a Scotland cutout in the low single
digit MB is a defensible prior. **Still must be measured on a real build before treating it
as a decision input** — a density extrapolated from one 809 km² box has wide error bars,
and this box is Ben Nevis specifically, plausibly denser in scree than lowland Scotland.

No new infrastructure, no compute layer, no DEM fetch. Same `£0` marginal-infra line as
SAC and paths.

---

## 8. Acceptance (once built)

Airplane Mode throughout, a region with this artifact downloaded:

1. A known scree slope or boulder field in that region — picked from the real build's
   output, not assumed in advance (§6) — renders with the scree/rock fill, distinguishable
   from `bare_rock` and from plain earth.
2. Toggling regions on/off in Settings shows/hides the layer cleanly, same as every other
   artifact kind.
3. The legend states the coverage caveat (§5) in view.
4. Force-quit, relaunch, still offline → unchanged.
5. A region built before this artifact existed still renders everything else correctly —
   same `update`-vs-`partial` path Phase 4.5 built for exactly this situation.

---

## 9. Open decisions — ask Adam, do not guess

1. ~~Points or fills only?~~ **Resolved by measurement (§2), not a judgement call: both.**
   The reference box came back 96% ways — points are real but far too sparse (3 of 69
   features) to be a visual-noise risk, so there's no tradeoff left to decide. Still worth
   a glance once a real region builds, in case Lochaber's mix isn't representative.
2. ~~Artifact name/kind string?~~ **Decided: `terrain-features`.** Filenames, the
   `ARTIFACT_KINDS` entry, the source-layer name and the build script are all built on it.
3. ~~Settings toggle?~~ **Decided: always-on**, matching SAC/paths. No toggle was added.
4. **Worth a route-panel callout** ("crosses scree for 400 m")? Flagged in §6 as
   deliberately out of scope for a first cut; easy to add later if wanted. Still open.
