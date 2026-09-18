# Scree, boulder fields and bare rock — a terrain-features artifact

**Status: not started. This is the plan, not the build.** Written 2026-09-18 after
[the bare-rock styling fix landed](../src/landuse.ts) surfaced the harder half of the same
question: what other ground-surface detail is missing, and what would it cost to add.
Destined for `docs/IMPLEMENTATION.md` as a Phase 4/5 entry (own number TBD — it depends on
nothing but the basemap the region already carries, same as Phase 4.5/4.6) if approved.

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

**Not yet verified, and must be before building (same discipline as `build-sac.sh`'s
`sac_scale` enum check):**

- **Geometry mix per value** — what fraction of `scree`/`shingle`/`rock` are ways/areas vs.
  bare nodes. This decides whether the layer is fill-only, fill+point, or needs to drop
  stray point-tagged scree that can't be filled. `osmium tags-filter` + a quick count over
  one region extract answers this in minutes; it is not worth guessing.
- **Regional density.** Taginfo's global count says nothing about coverage in Scotland,
  the Alps, or wherever this actually ships first — the SAC build found 7% coverage in
  Lochaber against a much denser Alps, and this could easily be as lopsided.

---

## 3. The artifact

`scree-global.pmtiles`, source-layer `terrain_features`, one property `kind` ∈
`scree | shingle | rock | stone`, built the same way `sac-global.pmtiles` is:
`osmium tags-filter` per source extract → `osmium export` to line-delimited GeoJSON →
a normalize pass → `tippecanoe` → `pmtiles convert`.

**No free-text parsing needed** — unlike `sac_scale`'s 184-value enum, these are already
clean OSM values. `normalize-terrain-features.py` exists mainly to attach `kind` uniformly
and to apply the point-drop/keep decision from §2's open geometry question, not to parse
anything.

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
| `stone`, `rock` (point) | A small marker icon **only if §2's geometry check finds this worth including** — otherwise dropped | A field of these across a whole country could be visual noise for near-zero navigational value; this is the one part of §4 that should not be built before §2 answers the density question |

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
| `scripts/build-scree.sh` *(new)* | Modelled directly on `build-sac.sh`: same per-continent extract-then-concatenate structure (§ the history-file trap that script's comments document), same `--self-test` convention. |
| `scripts/normalize-terrain-features.py` *(new)* | Thin — attach `kind`, apply the geometry keep/drop decision from §2. |
| `build-manifest.py` | `ARTIFACT_KINDS["-scree.pmtiles"] = "terrain-features"` (or similar — naming TBD so it doesn't collide with a future landcover-general artifact). |
| `build-region.sh` | A `terrain-features` branch in the `--only` set and the extract loop, same shape as the existing `sac`/`paths` branches. |

**Build assertion, same standard as every other pipeline here:** pin a known scree feature
(a named scree slope in whichever region builds first) and fail the build if it goes
missing — the same class of check as the Ben Nevis elevation pin and the SAC hardest-grade
pin. Concretely: don't invent the name now — find one that's actually tagged in the first
region this targets, the same way the SAC checks were read out of a real build's output
rather than a guidebook.

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

Unmeasured — this plan stops short of infra access to actually run `tippecanoe` and report
a real number, which is the same discipline the avalanche plan insisted on before writing
down a size. Rough order-of-magnitude reasoning only: `sac-global.pmtiles` covers ~921k
ways worldwide and is a similar shape of extract; `scree`+`rock`+`stone`+`shingle` combined
is ~826k features globally (§2 table), so a broadly similar weight class is a reasonable
prior — **but this must be measured on a real build before it's treated as a decision
input**, exactly as §2 flags.

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

1. **Points or fills only?** §2's unresolved geometry-mix question decides whether `stone`
   (near-always a node) ships at all, or whether this artifact is fill-only.
2. **Artifact name/kind string** — `scree`, `terrain-features`, `rock`, something else. The
   manifest kind string is user-facing nowhere directly but shapes every filename and
   catalogue entry that follows it, so worth a real name rather than whatever seemed fine at
   3am.
3. **Does this want its own settings toggle**, like avalanche terrain's default-off switch,
   or does it ship always-on like SAC bands and paths? Coverage is uneven but the feature
   itself isn't a "not just a caveat, actually dangerous" case the way avalanche terrain is
   — leaning towards always-on, but not decided here.
4. **Worth a route-panel callout** ("crosses scree for 400 m")? Flagged in §6 as
   deliberately out of scope for a first cut; easy to add later if wanted.
