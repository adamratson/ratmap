# Ratmap Signature Style — "Technical alpine"

**Audience: the implementing agent.** A visual identity for ratmap, written 2026-09-19 after
reading `src/style.css`, `src/theme.ts` and `src/main.ts`'s `buildStyle`, and after viewing
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

**Map labels stay Noto Sans.** Map glyphs are PBF ranges vendored by
`infra/scripts/vendor-assets.sh`. Barlow on the map would mean generating glyph PBFs
(e.g. with `font-maker`) and precaching roughly 256 more files per weight. Deferred to §7 step 6.

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

Add a new `src/flavor.ts`: `ratmapFlavor(theme: Theme): Flavor` spreads Protomaps' exported
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

`src/peaks.ts`: the label goes to ink (day) / `#e6e9ed` (night) with a matching halo. The dot is
ink/white with a hairline halo, replacing purple `#6d28d9`. Munro gold stays.

### 6.3 Icon, theme colour, splash

- **Mark:** a summit triangle with one contour line cut through it, orange on graphite. The
  source is `public/icons/icon.svg`. A script renders the 192/512 `any` icons and maskable
  variants (content inside the 80% safe zone) and the apple-touch icon. It replaces
  `scripts/gen-placeholder-icons.py`.
- **Theme colour** `#0e1114` goes in `index.html`, `vite.config.ts` (`background_color` and
  `theme_color`) and `src/theme.ts`'s `apply()`. These are three places, and each gets a comment
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
4. **Map:** `src/flavor.ts`, the region-layer flavour fix, the peaks recolour and the magenta route.
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
