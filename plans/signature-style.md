# Ratmap Signature Style — "Technical alpine"

**Audience: the implementing agent.** A visual identity for ratmap, written 2026-09-19 after
reading `src/style.css`, `src/ui/theme.ts` and `src/main.ts`'s `buildStyle`, and after viewing
the app at 375×812 and at desktop width. §1 explains the problem. §2 gives the principles
that every later styling change is checked against. §3–§6 give the specification, §7 the
sequencing, and §8 the verification. This builds on
[`desktop-ux-review.md`](desktop-ux-review.md) and [`mobile-ux-review.md`](mobile-ux-review.md)
and does not change their layout decisions. This document covers only how things look.

---

## 1. The problem

ratmap has a careful token system (`style.css` names no hex outside its `:root` /
`[data-theme='dark']` blocks, and dark is designed as a separate theme rather than an
inversion). But the token *values* are stock Tailwind: slate surfaces, `#2563eb` blue,
`system-ui` type, pill chips, and a `#1e293b` theme colour. The basemap is the stock Protomaps
`namedFlavor`. The icon is the Phase 0 placeholder triangle. Nothing on screen says
"ratmap", so you couldn't tell a screenshot apart from a MapLibre demo.

The direction chosen is **technical alpine**: the app reads as an *instrument*, like a GPS
unit or an altimeter watch, rather than a consumer lifestyle app. It uses graphite chrome,
one high-visibility signal colour, and mono, tabular numerals for every measured value.
Scope is **chrome and map together**, plus the icon and the iOS splash screens.

The existing structure is kept. Almost everything in this document changes a token value or
a component rule. Layout, detents, the docked panel and the rail's position stay as they are.

---

## 2. Principles

1. **Numbers are the product.** Elevation, distance, ascent, time, grid refs and download
   sizes are set in mono with tabular figures, one step larger than the prose around them.
   Units are smaller and muted. A reader should find "1,345 m" before they find the sentence
   it belongs to.
2. **One signal colour, meaning "act here" or "you are here".** Signal orange marks the
   primary action, the active mode and the user's own position and progress. It is never
   used as decoration, and it never appears as map data (see §3.3).
3. **Hairlines, not shadows.** Use 1px borders and a 6px radius. There are no pills. Shadows
   stay only on things that really float over the map: the rail, toasts and the tooltip.
4. **Labels, not sentences, in the chrome.** Chip labels and section headings are uppercase,
   semi-condensed and letter-spaced, like the printing on an instrument bezel. Prose stays in
   sentence case in the sheet body, where people read rather than scan.
5. **Night is the signature theme; day must still feel like the same instrument.** Screenshots
   and the icon lead with graphite. The day theme is warm bone and ink, not white and slate,
   so it doesn't fall back to looking like Tailwind.

---

## 3. Colour

### 3.1 Chrome tokens

Token *names* in `style.css` are unchanged. Only the values move.

| Token | Day | Night |
|---|---|---|
| `--surface` | `#f4f3ef` | `#0e1114` |
| `--surface-sunken` | `#e9e7e1` | `#161a1f` |
| `--surface-raised` | `#fbfaf7` | `#1c2127` |
| `--border` | `#d6d3cb` | `#2a3038` |
| `--border-strong` | `#b9b5ab` | `#3a424c` |
| `--text` | `#14171a` | `#e6e9ed` |
| `--text-muted` | `#5a5f66` | `#9aa3ad` |
| `--text-faint` | `#62676d` | `#7a838d` |
| `--accent` (fill) | `#c2410c` | `#ff5a1f` |
| `--accent-strong` (text/icon) | `#a8360a` | `#ff7a45` |
| `--accent-text` (on accent) | `#ffffff` | `#0e1114` |

Contrast ratios, computed with the WCAG relative-luminance formula rather than estimated:

| Pair | Ratio |
|---|---|
| Night text on surface | 15.6 |
| Night muted on surface / raised | 7.4 / 6.3 |
| Night accent on surface | 6.1 |
| Night `--accent-text` on accent | 6.1 |
| Day text on surface | 16.2 |
| Day muted on surface / sunken | 5.8 / 5.2 |
| Day `--accent-strong` on sunken | 5.3 |
| White on day accent `#c2410c` | 5.2 |
| Day / night faint on sunken | 4.6 / 4.5 |
| Night `--accent-strong` on surface | 7.3 |

Rejected: `#d9480f` as the day accent. White text on it is 4.3:1, which fails body text.
Also rejected: `#767b82` / `#6b7076` as day `--text-faint`, at 4.0:1 on sunken. `#62676d` passes,
at the cost of sitting close to `--text-muted`. The previous slate pair had the same trade.

### 3.2 Status, follow and markers

- `--status-*`: toasts and conditions become `--surface-raised` (night values in both themes,
  since they sit over the map) with a **3px left stripe** coloured by severity. The whole-surface
  brown or red fill goes. Stripe colours: ok `#4ade80`, warn `#fbbf24`, error `#f87171`, neutral
  `--border-strong`.
- `--follow-*`: `--follow-surface: #0e1114` and `--follow-progress` becomes the night accent.
  `--follow-on` and `--follow-off` stay green and rose. They are status signals, not the signal colour.
- `--marker-start/end/mid`: start and end stay green and red (the convention). Mid becomes ink/white
  with an accent ring, not blue.

### 3.3 The collision with map data

Orange is already *data* on the map: SAC T4 `#e8590c` and avalanche 30° `#e08a10`. So:

- The signal accent is **chrome-only**. It's never painted as a map layer, except for the
  user-location dot and the follow-mode progress, both of which mean "you are here" (principle 2).
- The **planned-route line becomes magenta** (`#d6127e`, the GPS "course line" convention)
  instead of `#1d4ed8` in `src/routes/route-layers.ts:51`. The straight-segment dashes stay
  amber `#b45309`. Magenta on day land is 4.5:1 and on the night flavour it needs checking.
- The SAC ramp, the avalanche ramp, Munro gold and the contour and footpath browns are **untouched**.
  They're semantic and documented, and the contour brown is cartographic convention.

---

## 4. Type

| Role | Family | Use |
|---|---|---|
| `--font-ui` | Barlow 400/500 | Body, list rows, inputs |
| `--font-display` | Barlow Semi Condensed 500/600 | `h2`, chips, section labels (uppercase, `letter-spacing: 0.06em`) |
| `--font-mono` | JetBrains Mono 400/500, `tabular-nums` | Every measured value (principle 1) |

Scale tokens: `--text-xs 0.75rem`, `--text-sm 0.875rem`, `--text-md 1rem`, `--text-lg 1.25rem`,
`--text-xl 1.75rem` (the follow-screen readouts). Radius tokens: `--radius 6px`, `--radius-sm 3px`.
These replace the literals scattered through `style.css` today.

**Delivery (offline, same reasoning as C7):** use the `@fontsource/barlow`,
`@fontsource/barlow-semi-condensed` and `@fontsource/jetbrains-mono` packages, importing only
the weights above and only the Latin subset. `vite.config.ts`'s `workbox.globPatterns` has no
`woff2` today, so **add it**. Without it the fonts are missing on a cold offline start and the
app silently falls back to `system-ui`.

**Verify before building:** check each package's file listing for the weights and subsets
imported. The system-ui fallback stack stays at the end of every `--font-*`.

**Map labels (step 6, done):** Barlow, with Noto Sans baked in as the fallback, as three
"Barlow Noto" fontstacks built by `scripts/build-map-glyphs.sh`. They *replace* the Noto
stacks rather than sitting beside them, so the precache grows by the fallback coverage
added, not by a second full set. See the step 6 status below.

---

## 5. Components (`src/style.css`)

- **Chips** (`.chip`): 6px radius, `--font-display` uppercase. Active means `--text` fill with
  `--surface` text and a 2px accent underline. `.chip-mode.active` (planning) is the *only*
  solid-accent chip, because it's a mode, not a destination.
- **Rail** (`#rail`): one stacked "bezel", `--surface-raised`, 1px `--border`, `--radius`,
  44px square cells with hairline dividers. The active state is an `--accent-strong` icon. It
  keeps its one shadow, because it floats over the map.
- **Sheet** (`#sheet`): 1px top border instead of the heavy shadow. The grip is 28×4px at
  `--border-strong`. `h2` uses `--font-display`.
- **Readouts:** add a `.readout` utility, with the value in `--font-mono` and `.readout-unit` in
  `--text-xs` / `--text-muted`. Sites: `.route-stats`, summit elevation in the detail sheet,
  `.region-meta` sizes, `.peak-tooltip-ele`, and the follow screen at `--text-xl`. Each site needs
  its template to split value and unit into spans (`main.ts`, `routes/routes-ui.ts`,
  `regions/regions-ui.ts`). Do one site first, then repeat the pattern.
- **Toasts and conditions:** stripe treatment from §3.2.
- **Profile chart** (`routes/profile-chart.ts`): filled `--text` area at low opacity,
  hairline grid, mono axis labels, cursor in accent.
- **MapLibre controls** (`--ctrl-*`, `NavigationControl`): match the rail bezel.
- **Hover** (`brightness(0.94)`): check it on graphite. Night surfaces probably need
  `brightness(1.15)` under `[data-theme='dark']`.
- **Legend:** swatches stay as they are. Section `h3` switches to the display-label style.

---

## 6. Map and identity

### 6.1 Flavour

Add a new `src/map/flavor.ts`: `ratmapFlavor(theme: Theme): Flavor` spreads Protomaps' exported
`LIGHT` / `DARK` and overrides earth, water, landcover, roads and label colours.

- **Day:** a cool, desaturated topo. It is quieter than stock so the brown contours and
  footpaths carry the page.
- **Night:** graphite land (near `--surface-sunken`), deep slate water and muted landcover,
  so hillshade, the magenta route and the orange location dot are the brightest things on screen.

Consumers: `buildStyle` in `src/main.ts` and `src/regions/region-layers.ts`.

**Existing bug, fixed by this:** `region-layers.ts` hardcodes `namedFlavor('light')`, so a
downloaded region draws light-flavour patches onto the dark map. Pass the current theme in.
A theme change already reinstalls app layers through `installAppLayers`.

### 6.2 Peaks

`src/overlays/peaks.ts`: the label goes to ink (day) / `#e6e9ed` (night) with a matching halo. The dot is
ink/white with a hairline halo, replacing purple `#6d28d9`. Munro gold stays.

### 6.3 Icon, theme colour, splash

- **Mark:** a summit triangle with one contour line cut through it, orange on graphite. The
  source is `public/icons/icon.svg`. A script renders the 192/512 `any` icons and maskable
  variants (content inside the 80% safe zone) and the apple-touch icon. It replaces
  `scripts/gen-placeholder-icons.py`.
- **Theme colour** `#0e1114` goes in `index.html`, `vite.config.ts` (`background_color` and
  `theme_color`) and `src/ui/theme.ts`'s `apply()`. These are three places, and each gets a comment
  pointing at the other two. `theme.test.ts` asserts on this value.
- **iOS splash screens** (`apple-touch-startup-image`, missing today): graphite with the mark
  centred, rendered from the same SVG. This closes a Phase 6 carry-over item in
  `docs/IMPLEMENTATION.md`.

---

## 7. Sequencing

Each step is its own commit. Never push without asking.

1. **This document.**
2. **Tokens and fonts:** new values, font, scale and radius tokens, and `woff2` in precache.
   On its own this changes most of the app's look.
3. **Components:** chips, rail bezel, sheet, toasts, `.readout` plus the follow screen, and the profile chart.
4. **Map:** `src/map/flavor.ts`, the region-layer flavour fix, the peaks recolour and the magenta route.
5. **Identity:** icon, theme colour and splash screens.
6. **(Optional)** Barlow map glyphs.

---

## 8. Verification

- After each step: `npm test` and `npx tsc --noEmit`.
- In the browser pane (`ratmap-dev`), at 375×812 (mobile emulation) and 1440×900 (docked), in
  **both themes**: browse, a summit detail, the planner with a route, the follow screen, regions
  mid-download, a toast and the legend.
- Contrast: use `getComputedStyle` on the live page for each token pair in §3.1. Body text must
  be ≥ 4.5:1 and large numerals ≥ 3:1.
- Offline: `npm run build` and preview, load once, go offline, and reload. The fonts must still
  render, and there must be no off-origin font request.
- Night theme with a downloaded region: the region renders in the night flavour.
- `npx playwright test`. Specs select by role and text, so a failure is a real regression.

---

## Status — 2026-09-19

**Step 1** is done (this document).

**Step 2** is done. In `style.css`, the token blocks have the §3.1 values plus font, scale and radius
tokens. `--status-neutral`, `--follow-*` and `--ctrl-*` are moved onto graphite. The severity fills
(`--status-ok/warn/error`) are left for step 3's stripe treatment, and markers for step 4. `main.ts`
imports the eight `@fontsource` Latin files. `body` uses `--font-ui`, form controls
`font-family: inherit` (without it every button stayed in the system face), `.sheet-body h2`
`--font-display`, and the three existing `tabular-nums` rules (`.region-progress-label`,
`.route-stats dd`, `.sac-chip-distance`) `--font-mono`. `vite.config.ts` precaches `woff2`.

Verified: the contrast ratios above were read from the live page's computed tokens in both
themes, not only calculated offline. The browser pane showed Barlow loaded at 375×812 (light) and
1440×900 (dark, docked). `npm run build` lists all 8 woff2 files in `dist/sw.js`'s precache.
508 tests and `tsc --noEmit` pass. Not done: an actual airplane-mode reload, and checking
`.route-stats dd` in mono at 375px with a real route (mono is wider, so check it in step 3).

**Step 3** is done. In `style.css`:
- The rail is one bezel (the container carries surface, border and shadow; cells are flat with
  hairlines between visible buttons). Active state is an accent icon, not a fill.
- Chips are square, uppercase and semi-condensed. Padding dropped to 0.7rem so the three
  browse chips still fit at 375px and in the 24rem docked panel. The active chip is an ink fill
  with an accent underline, and planning is the only solid-accent chip.
- The sheet has a hairline edge instead of a cast shadow (right edge when docked). The grip is 28px.
- Toasts and conditions use graphite with a 3px severity stripe (`--status-stripe-*` replaces
  `--status-ok/warn/error`). This also fixed the toast action button, whose `color: var(--surface)`
  drew graphite on graphite in the dark theme.
- New `--overlay-*` tokens replace the hex literals on `#detail-notice`, `#peak-tooltip` and
  `.condition-toggle`.
- Remaining `0.35–0.6rem` radii become `--radius`, and pills become `--radius-sm`.
- The NavigationControl group matches the bezel, with its icons inverted plus `hue-rotate(180deg)`
  on dark so the north tip stays red.
- Night hover lifts (`brightness(1.18)`) rather than dipping.
- The profile chart uses ink line and fill tokens. On the follow screen it takes the follow
  palette, with the accent position dot.

New `src/ui/readout.ts` (`fillReadout`) splits a formatter's "<number> <unit>" into mono value and
muted unit spans. `textContent` is unchanged, so the e2e string assertions still hold. It is
applied to route stats, follow figures, the summit sheet elevation (now `--text-lg`) and the peak
tooltip. The tooltip is now built from DOM nodes instead of `innerHTML`, since it had been
interpolating the OSM name as HTML. Summit coordinates are mono. Region-meta sizes are **not**
readouts yet: they sit mid-sentence ("Europe · 1.3 GB · …"), and splitting that line is a
separate change.

Verified in the browser pane:
- 1440×900 dark: planner chip, "4.54 km" readout, amber-striped toast, bezel.
- 1440×900 light: summit sheet "1345 m", with DOM checked, and the tooltip.
- 375×812 light: chips, rail and toast.
- `#chips` `scrollWidth == clientWidth` at both widths when browsing.

512 unit tests (4 new) pass. The e2e specs for places, sheet, route-planning, search and
routes-library ran with 35 passed and 3 failed, and **the same 3 fail on 8b2259d, before any of
this work**: `sheet.spec.ts:25` and `:37` (`sheetHeight()` is 0 because Playwright's desktop
viewport gets the docked panel) and `places.spec.ts:44`. Not verified: the follow figures with a
real position fix, because the pane has no geolocation source. That DOM is covered by
`routes-ui.test.ts`.

**Step 4** is done. New `src/map/flavor.ts`:
- `ratmapFlavor(theme)` spreads Protomaps' `LIGHT` / `DARK` with ratmap's earth, water,
  landcover, roads and label colours. `mapInk(theme)` holds the inks for everything the app
  draws over the basemap.
- Night water was first `#0f1a22`, and in a headless screenshot the lochs disappeared into the
  land. It is now `#1d3040`.

Consumers:
- `buildStyle` (basemap and hillshade).
- `region-layers.ts`: flavour, paths, contours, contour labels, hillshade.
- `peaks.ts`: label and dot follow the theme, ink by day and near-white at night, replacing the
  fixed violet. Munro gold is kept.
- `route-layers.ts`: magenta `#d6127e` by day, `#ff4fa8` at night. Straight legs are amber,
  off-route red, each with a night variant. `RoutePlanner` takes a `theme` getter for its
  fallback `addRouteLayers`.
- The legend reads `mapInk` at render time, so its swatches match the map in either theme.

Fixed: `addRegionToMap` hardcoded `namedFlavor('light')`. It now takes a required `theme`
(no default, so a caller can't silently bring the bug back), with a regression test in
`region-layers.test.ts`.

Knock-on: the region inks (brown path `#8a3d2e`, white casings and halos) had only ever
been drawn on the light flavour. On night graphite the path was 2.3:1 and the casings
glared. So night gets its own set: graphite casings and halos, and browns lifted with their
hue kept (path 6.3:1, contour label 6.5:1).

Deliberate exception: SAC grade labels keep a white halo in both themes. Their text takes
the grade ramp, and T5/T6 need a light ground.

Night hillshade highlight drops from white to `rgba(154,163,173,0.45)`. Pure white turned
every sunlit slope into a pale blob brighter than the route. Tried live with
`setPaintProperty` before committing it.

In CSS:
- The location dot, heading cone and accuracy halo are the position orange (`--position`).
- Intermediate waypoint pins are ink by day and near-white at night, off the old route blue.
- At night, pin text and rings are graphite, which also fixes white-on-light-green start pins
  (2.3:1).
- §3.2's "accent ring on mid pins" is dropped: principle 2 keeps the accent for "you are here".

Verification notes:
- The browser pane was hidden for part of this. MapLibre defers loading the style to a
  `requestAnimationFrame`, which never fires in a hidden document. A blank map there is the
  environment, not a regression: measured as `visibilityState: 'hidden'` with no rAF in 3s.
- The day theme and the night-water fix were screenshotted with headless Playwright against
  the dev server instead.

Tests:
- 513 unit tests pass.
- E2E (offline-regions, sheet, route-planning, places, region-downloads): 30 passed, 10 failed,
  none from this step. The e2e theme test (`sheet.spec.ts` "keeps the app's own layers across a
  theme change") passes.

Failures:
- 3 are the known docked-panel ones.
- 1 is a stale regex in `offline-regions.spec.ts:75`, which predates the `avalanche` artifact
  kind (`andorra-avalanche-1.pmtiles`).
- 6 are download timeouts. Route-planning's own message reads "did not finish downloading
  within 240s (15.3 MB of 23.7 MB)". `region-downloads.spec.ts:57` fails identically on the
  step-3 commit, so this is bucket throughput, not this step.

A downloaded region in the night theme is therefore covered by the unit regression test, not
yet by a visual check on a real download.

**Step 5** is done.

The mark:
- `public/icons/mark.svg` is a summit with a graphite contour cut through it, in signal orange.
- `scripts/gen-icons.mjs` rasterises it through Playwright's Chromium (already a dev
  dependency; this machine has no rsvg or ImageMagick) onto graphite:
  - `any` icons at 72% of the width
  - maskable at 56%: the farthest point sits 0.30 of the icon from centre, inside Android's
    0.40 safe circle
  - apple-touch at 64%
  - eleven portrait iOS splash screens
- `scripts/gen-placeholder-icons.py` is removed.
- The viewBox starts at y=4 so the bottom-heavy triangle sits optically centred.

Theme colour: `#0e1114` in `index.html`, the manifest (`theme_color` and `background_color`)
and `theme.ts`. By day `theme.ts` uses `#1c2127`, not the bone chrome, because the status bar
sits over the map with light text. Each of the three places carries a comment pointing at the
other two. (§6.3 said `theme.test.ts` asserts the value. It doesn't; nothing does.)

Splashes are `globIgnores`d from the precache. The build shows Vite rewriting their hrefs to
`/ratmap/splash/…` and zero splash entries in `sw.js`.

**Unverified: no iPhone or Android device was used.** Still to check: the Home Screen icon, the
maskable crop under Android's launcher shapes, and whether iOS actually shows the splash
(online and offline).

**Step 6** is done.

What ships: three fontstacks in `public/fonts`, `Barlow Noto Regular/Medium/Italic`, each
Barlow with Noto Sans baked in as the fallback. `MAP_FONTS` in `src/map/flavor.ts` names them; the
flavour's `regular/bold/italic` slots and the three app label layers (peaks, SAC grades,
contour heights) all read it, and nothing requests plain Noto any more.

How they're built:
- `scripts/build-map-glyphs.sh` runs Stadia's `build_pbf_glyphs` 1.4.3 (source read first:
  fontnik parameters, 24px / radius 8 / cutoff 0.25, and a built-in precedence-ordered
  combine).
  - Inputs: the committed Barlow 1.408 TTFs in `assets/fonts/barlow` (from google/fonts,
    OFL) and the Noto ranges.
  - Not 1.5.x, which needs rustc ≥ 1.87 (this machine has 1.86).
- The Noto ranges are now build input in the gitignored `infra/.cache/glyphs-src`, moved out
  of `public/fonts`. `infra/scripts/vendor-assets.sh` fetches them there and then runs the
  build.
- Both OFL licences ship beside the glyphs (`public/fonts/OFL-*.txt`).

Fixed along the way: the vendored Noto Sans **Medium** never had `▲` (U+25B2, 1 glyph in
that block against Regular's 96). So the Munro label prefix in `src/overlays/peaks.ts`, which exists
so membership isn't carried by colour alone, has never rendered. Medium and Italic now fall
back to Noto Regular last. That also gives peak labels, which use Medium, Regular's full
script coverage (13k glyphs against Medium's 7k) in places like the Caucasus.

Cost: the precache goes from 15.5 MB to 22.5 MB (the glyph sets from 13.2 to ~20.5 MB).

Checked:
- Metrics: cap height 17px in both fonts at the 24px glyph size. Barlow's baseline sits 1px
  above Noto's, which only matters in a label that mixes scripts.
- Headless Playwright, since the pane was hidden:
  - The Mamores by day render in Barlow.
  - Rila in Bulgaria at night falls back cleanly to Cyrillic.
  - Every glyph request returned 200, and only the Barlow Noto stacks were requested.
- New `src/map/flavor.test.ts` fails if any fontstack the generated style can request has no full
  256-range directory on disk (checked by moving one aside). 516 unit tests pass.

Not seen: a rendered `▲ Munro` label. The global peaks archive carries no `lists` property, so
it needs a downloaded region; the fix is verified only as the glyph being present in the stack.

## Theme default — 2026-09-19

Dark is now the default and the only default: `theme.ts` is a two-state stored preference
(`light` | `dark`, default dark) instead of the three-state `system | light | dark` cycled
from a chip in the peek row. The device's `prefers-color-scheme` is no longer an input —
ratmap is dark because that is the app's look, not because the phone happens to be — and
the chip is gone. Light lives in Settings, as the first row.

A stored `system` from the old preference resolves to dark; a stored `light` is kept, so
someone who had explicitly chosen light still gets it.

Checked in a real browser: with the device asking for light, the app starts dark
(`data-theme=dark`, theme-color `#0e1114`, basemap earth `#161a1f`), `#theme-btn` is gone,
and the toggle switches the map to the day flavour (`#ebe9e3`), stores `light`, and keeps
the app's own layers. The checkbox takes `accent-color` so it is the signal orange rather
than the browser's blue. 518 unit tests and the 14 sheet e2e tests pass.

