# Ratmap Desktop UX Review

**Audience: the implementing agent.** Findings and a redesign direction for ratmap on a
desktop browser window, produced 2026-09-18 by reading the source and running the app at
1440×900 in a real browser. See §1 for the headline problem, §2 for individual findings
(most to least severe), §3 for the redesign direction, and §4 for suggested sequencing.
Companion to [`mobile-ux-review.md`](mobile-ux-review.md), whose bottom-sheet redesign
this document takes as fixed and correct for touch — the problem here is that the exact
same layout ships unmodified to a mouse-and-keyboard window many times its target width.

---

## Status — 2026-09-18

§4 steps 1–3 are implemented:

- **Step 1, the docked panel (C1, B1).** `prefersDockedSheet()` (`src/pointer.ts`) —
  `(pointer: fine) and (hover: hover) and (min-width: 60rem)`, the same string duplicated
  into the `@media` query in `style.css`'s "Desktop (docked panel)" block. Above it,
  `#sheet` becomes a fixed 24rem left panel, full height; `sheet.ts`'s `applyDetent` forces
  the applied transform offset to 0 regardless of detent (no drag, no animation — nothing
  to snap to), while `current` keeps tracking the logical peek/content/full value so
  `main.ts`'s existing "is a view open" checks (`sheet.detent() !== 'peek'`) are untouched.
  `visibleHeight()` reports 0 when docked, which — with no extra CSS — puts the rail,
  toasts, `#detail-notice` and the MapLibre bottom controls back at their un-lifted resting
  offsets, since they all read `--sheet-visible`. Only the *left* axis needed explicit
  handling (the scale control, `#conditions`, `#toasts`, `#detail-notice`'s centring),
  since nothing else lifts for a panel on the left edge.
- **Step 2, search reachable without the mouse (B2, A2 partial).** Docking already puts
  search at the physical top of the panel for free — it's the peek row, and the peek row
  is first in DOM order. Added on top: `Cmd/Ctrl+K` (`main.ts`) focuses and selects it from
  anywhere, closing an open view first so it always lands in the same reachable place.
- **Step 3, hover and focus-visible (A1).** One rule, not one per component:
  `button:not(:disabled):hover, a:hover { filter: brightness(0.94) }` under
  `(hover: hover) and (pointer: fine)`, plus an unconditional `:focus-visible` outline —
  covers every current control and whatever gets added later, rather than enumerating
  `.region-action`, `.chip`, `#rail button`, etc. by hand. Verified via `getComputedStyle`
  in a real browser (`:hover` → `filter: brightness(0.94)` applied; Tab → `:focus-visible`
  → a 2px accent outline), not just read off the CSS.

Verified in the browser pane at 1440×900: browsing, a summit's detail sheet, the routes
list, and an in-progress planned route all render correctly inside the docked panel with
no overflow. Resizing back down to 375×812 (mobile emulation, touch) reproduces the
original bottom-sheet behaviour unchanged — detents, drag, grip all intact. Full suite
(508 tests) and `tsc --noEmit` both pass after the change.

### Continued — steps 4 and 6–7

- **Step 4, the rail (B3).** The call: merge it with the zoom cluster rather than leave it
  a second corner. Inside the same docked-panel media query, `#rail` switches from
  `bottom: calc(var(--sheet-visible, 0px) + 2.25rem)` to a fixed `top`, stacked directly
  under `NavigationControl` — `right` is untouched, so both clusters share one edge.
  The offset (`7rem`) is measured against the control's own rendered height, not derived
  from it (CSS can't read another control's box); if `NavigationControl`'s own layout
  changes, this needs a manual recheck. Mobile is untouched — the query that gates it
  never matches a coarse pointer, so the rail stays at thumb height, bottom-right.
- **Step 5, arrow-key search navigation (A2).** Scoped to the search-results combobox,
  not every list in the sheet — regions/routes/places rows are plain buttons in document
  order, already fully reachable by Tab, and giving them roving-tabindex navigation too
  is a separable, lower-value piece of work left undone. `main.ts`: `ArrowDown`/`ArrowUp`
  move a highlighted index (wrapping at the ends) while focus stays in the input — a
  search-as-you-type field has to keep filtering on every keystroke whether or not a
  result is highlighted, so moving real DOM focus into the list the way a plain menu
  would have broken that. `Enter` activates the highlighted result; a fresh render (new
  query, or the list closing) resets the index, since a stale one would point at content
  that no longer exists. Wired through `aria-activedescendant` on the input and
  `role="option"`/`role="listbox"` on the results, not just a visual highlight class.

  **Found and fixed in the process — the results dropdown was rendering off-screen on
  desktop.** `#search-results` opens *upward* from the input (`bottom: calc(100% + …)`),
  correct when search sits at the bottom of a phone screen but wrong once step 1 moved it
  to the top of the docked panel — the list was rendering above the viewport, technically
  present and fully populated but invisible, unreachable by mouse and pointless to add
  keyboard navigation to. Caught by actually driving the new navigation in the browser
  pane rather than reading the code: results existed in the DOM with the right content,
  measured at a negative `top`. Fixed with a docked-only override that reverses the
  opening direction; mobile keeps the original upward-opening rule untouched (verified at
  375×812 after the fix — still opens upward, unaffected).
- **Step 6, responsive list layouts (B4) — reassessed, not built.** B4 was written against
  a *full window width* sheet; step 1 already resolved the actual waste by capping the
  panel at 24rem (384px) rather than widening it to fit a grid. A single-column list at
  384px is a normal, readable sidebar width — the same width a native app would use —
  not a wasted one, so a multi-column region grid would need widening the panel
  specifically to fit it, trading away exactly the map space docking exists to preserve
  (§3's own C3 concern, cap the panel even on an ultrawide monitor). Not built; recorded
  here as a finding superseded by an earlier decision rather than silently dropped.
- **Step 7, peak hover tooltips (C2).** `#peak-tooltip` (`style.css`, `main.ts`): name and
  elevation, shown on `mousemove` when `peakAt()` hits and `isCoarsePointer()` is false —
  the same "is this a mouse" check `NavigationControl` already uses, not a new one.
  Positioned from the event's own container-relative point, no extra measurement.
  Hidden on `mouseout` and on click (so it never lingers over a sheet that just opened).
  Verified in the browser: hovering "Ben Wyvis" shows "Ben Wyvis 1046 m" near the cursor;
  clicking it hides the tooltip and opens the summit sheet; on a 375×812 touch emulation
  it never appears at all, and the tap sheet is unaffected.

Full suite (508 tests) and `tsc --noEmit` pass after steps 4, 5 and 7 as well.

**All of §4 is now either done or explicitly reassessed** — step 6 deliberately not built
(superseded by step 1's width decision, see above), everything else shipped. Nothing left
open from the original plan.

---

## 0. Measured baseline

At 1440×900, browsing with no summit selected:

| Element | What's on screen |
|---|---|
| Sheet (peek) | Full window width (1440px). Search field, mode chips and icon buttons all left-aligned inside it, occupying roughly the left 340px; the remaining ~1100px is blank sheet background. |
| Search field | Bottom-left corner of the window — the mobile thumb-zone position from `mobile-ux-review.md` §3, unchanged for a pointer that has no reachability constraint. |
| Zoom controls | MapLibre's stock `NavigationControl`, top-right, ~30px buttons — the only element in the whole UI that already branches on pointer type (`isCoarsePointer()`, [main.ts:618](../src/main.ts#L618)). |
| Control rail (Locate) | Bottom-right, floating independently of the zoom cluster it sits 350px below. |
| Install/status banner | Full window width, phone-status-bar proportions, a large empty band to the right of its text. |

Opening a summit (tap a peak) or the route/offline/saved views reproduces the same shape:
sheet content — a name, an elevation, two buttons; or a "New route / Import GPX" row and
an empty-state line — pinned to the left edge of a 1440px-wide strip, with everything to
the right of it doing nothing. The regions catalogue and saved-places list render as a
single mobile-width column inside that same strip.

No screenshot is embedded here; re-run `preview_start` against `ratmap-dev` at 1440×900
and open a summit or the routes view to reproduce directly — the layout is deterministic
and takes under a minute to confirm.

---

## 1. The desktop window renders the phone's interface, unmodified

Grepping `src/style.css` and `src/*.ts` for anything that branches on viewport width or
pointer precision finds exactly two things:

- `isCoarsePointer()` ([pointer.ts:11](../src/pointer.ts#L11)) gates `NavigationControl`
  ([main.ts:618](../src/main.ts#L618)) — the one place the app already asks "is this a
  mouse?" and acts on the answer.
- `(max-height: 26rem) and (orientation: landscape)` ([style.css:1705](../src/style.css#L1705),
  mirrored in [sheet.ts:53-56](../src/sheet.ts#L53-L56)) turns the sheet into a left-hand
  side panel — but the query is keyed on a *short phone held sideways*, not on desktop
  width, and a normal 900px-tall browser window never matches it.

Everything else — the sheet's full-viewport width, its drag-to-detent gesture, the
bottom-left search position, the thumb-height control rail, the single-column list
content — is the exact code the mobile review built for a 375×812 screen, with no
alternate path for a window an order of magnitude wider and comfortably taller. The
mobile redesign's own stated goal (`mobile-ux-review.md` §3: "one sheet... dragged rather
than toggled... covers 15–38% of a 375×812 screen") was never a goal for 1440×900, and
nothing currently limits it there — the sheet is full-bleed at every detent regardless of
viewport size ([style.css:744](../src/style.css#L744), no `max-width` in any of its
rules).

---

## 2. Findings

### Tier A — Actively wrong for mouse + keyboard, not just unoptimised

**A1. Almost nothing has a hover state.**
One `:hover` rule exists in the entire stylesheet
([style.css:356](../src/style.css#L356), search-result rows). Rail buttons, peek-row
icon buttons, sheet list rows, region rows — none of them give a mouse user any feedback
before the click lands. On touch this is correct (there is no hover to give); on desktop
it reads as an unresponsive UI.

Fix: `:hover` and `:focus-visible` treatments across `#rail button`, `.sheet-peek button`,
and every clickable row inside the sheet body, under a `(hover: hover) and (pointer: fine)`
query so touch is untouched.

**A2. Keyboard support is a single `Escape` handler.**
[main.ts:237-245](../src/main.ts#L237-L245) closes search results or the open view on
Escape — the one keyboard affordance in the app. There is no documented Tab order through
sheet content, no arrow-key navigation through search results or list rows, and no
shortcut to focus search (a bottom-left field is also the field hardest to *find* with a
keyboard-first workflow). A mouse-and-keyboard user has no way to drive the app without
the mouse for anything beyond dismissal.

Fix: `Cmd/Ctrl+K` (or `/`) focuses search from anywhere; arrow keys move through result
and list rows; confirm Tab order matches visual order once the panel is restructured (§3).

**A3. The sheet's only interaction model is a touch drag.**
`BottomSheet`'s detents ([sheet.ts:111](../src/sheet.ts#L111)) are driven entirely by
`onPointerDown/Move/Up` tracking a Y-delta and a flick velocity — a solution to *vertical*
space scarcity on a phone. It technically also answers to a mouse (pointer events are
pointer events), but a click-and-hold-drag on a 4px grip bar sized for a thumb
([style.css](../src/style.css), `.sheet-grip`) is not how a desktop user expects to resize
a panel, and there is no click-to-toggle fallback. On a desktop window there usually isn't
vertical space scarcity to solve in the first place — the window is often taller than the
sheet's own content needs.

Fix: desktop doesn't need detents at all — see §3.

### Tier B — Works, but wastes the window

**B1. The sheet is full window width at every detent, on every view.**
No rule in [style.css](../src/style.css) caps `#sheet`'s width. At 1440px, a summit's
name/elevation/coordinates/two-buttons — content that is ~340px wide by its own natural
sizing — sits inside a 1440px bar, 76% of it empty. This is the single largest source of
wasted space in the app and the same root cause behind B2–B5 below: one full-bleed
mobile component with no width ceiling.

**B2. Search sits in the mobile thumb zone, bottom-left of the window.**
`mobile-ux-review.md` B1 deliberately moved search to the bottom "from 804px away from
the thumb to roughly 80px" — the right call for a phone. On desktop there is no thumb and
no reason to hide the primary entry point at the bottom of a tall window a mouse user
isn't reaching down to; screen-reading conventions (and every comparable desktop map UI)
put search top-left or top-center.

**B3. The control rail duplicates the zoom cluster's job in a different corner.**
`#rail` ([style.css:224](../src/style.css#L224)) floats bottom-right at 44px/thumb size,
350px below the top-right `NavigationControl` it has no visual relationship to. On touch
this is correct (thumb reach, §B1 of the mobile review); on desktop, two unrelated control
clusters in two different corners of the same edge is just fragmented.

**B4. List content never uses the extra width.**
The regions catalogue, saved places, and route list all render as a single mobile-width
column ([regions-ui.ts](../src/regions/regions-ui.ts) and friends) regardless of how wide
the sheet actually is. A catalogue of hundreds of regions (Phase 3's global catalogue,
`docs/IMPLEMENTATION.md` §4 Phase 3) is exactly the kind of list that benefits from a
multi-column or denser desktop layout and currently gets neither.

**B5. The status/install banner keeps phone-status-bar proportions at full window width.**
Same shape as B1 — a component sized and positioned for a 375px-wide screen, stretched
to 1440px with no width cap, producing a thin bar with a large dead zone to its right.

### Tier C — Missing, and desktop specifically affords it

**C1. No docked panel mode.** The one precedent for "sheet as a side panel" —
[style.css:1697-1736](../src/style.css#L1697-L1736), [sheet.ts:53-57](../src/sheet.ts#L53-L57)
— is gated on `max-height: 26rem`, a short-screen signal that structurally cannot match a
tall desktop window. There is no equivalent "wide window" mode, even though the mechanism
(sheet becomes a fixed-width left panel, map keeps the rest) is already built and proven
for exactly this shape of layout problem.

**C2. No hover-before-click information density.**
Touch structurally can't offer a hover state, so the mobile design correctly relies on
tap-to-open. A mouse can hover, and nothing here uses it: no tooltip on a peak giving name
and elevation before a click, no preview on a region row before opening it. This is free
information density available only on desktop and currently unused.

**C3. No width ceiling exists for any future fix either.**
Worth flagging before §3 is built: whatever replaces the full-bleed sheet needs an
explicit `max-width` from the start. Nothing today caps panel width, so an ultrawide
monitor is a latent version of B1 at an even larger scale.

---

## 3. Redesign direction: dock the sheet, don't resize it

The existing landscape-phone side panel already answers "what does this app look like
when the sheet shouldn't cover the whole screen" — reuse its shape rather than inventing a
new one, gated on a different signal:

- **Breakpoint: `(pointer: fine) and (hover: hover) and (min-width: …)`**, not a phone
  orientation query. This is a mouse-and-space condition, not a device-class guess, and it
  sits next to the existing `isCoarsePointer()` check in spirit rather than duplicating a
  new one. A candidate threshold is whatever comfortably fits a docked panel plus a usable
  map — the mobile review's landscape panel used `min(24rem, 55vw)`; desktop can afford a
  fixed band (e.g. 360–420px) with a hard cap rather than a viewport fraction, addressing
  C3 directly.

- **No detents.** Vertical space isn't scarce on a desktop window the way it is on a
  phone, so "peek / content / full" (sheet.ts) has nothing to solve there. Docked mode is
  simply open, full window height, ordinarily scrollable — the drag gesture and its
  velocity/flick logic stay exactly as they are for touch and short-landscape, untouched.

- **Search moves to the top of the docked panel**, addressing B2. Consider `Cmd/Ctrl+K`
  as a global focus shortcut (A2) regardless of panel mode.

- **The rail merges toward the zoom cluster**, addressing B3 — either relocated to sit
  with `NavigationControl` in the top-right at a mouse-appropriate size, or left at its
  current size with hover/focus states added (A1). Needs a call during implementation,
  not a foregone conclusion either way.

- **Hover and focus-visible states, everywhere clickable**, under `(hover: hover)` so
  touch is unaffected — addressing A1.

- **List views go responsive inside the wider panel** — a grid for the regions catalogue,
  addressing B4 — once the panel actually has width to spend.

- **Peak hover tooltips** (name + elevation) gated on the same `pointer: fine` signal,
  addressing C2 — the tap-sheet stays the touch path unchanged.

- **Status/install banner gets the same width cap** as the panel rather than the window,
  addressing B5.

What this deliberately does *not* touch: the touch sheet, its detents, its drag gesture,
the phone-landscape side panel, or any of the Tier A/B/C fixes from the mobile review —
this is a new, additional layout mode selected by pointer/hover/width, not a replacement
for the existing ones.

---

## 4. Suggested order of work

Sequenced by dependency, matching the mobile review's approach.

1. **The docked panel breakpoint (C1, B1).** The structural fix everything else hangs off
   — sheet becomes a fixed-width, full-height left panel with no detents under
   `(pointer: fine) and (hover: hover) and (min-width: …)`. Move existing view content in
   unchanged first, same principle as the mobile review's step 3.
2. **Search to the top of the panel; `Cmd/Ctrl+K` global focus (B2, A2 partial).**
   Independent of the rest, high visibility, fixes the single worst-placed control.
3. **Hover and focus-visible states across rail, peek buttons, and list rows (A1).**
   Cheap, mechanical, no structural dependency on step 1 — could ship before it, but is
   most visible once the panel is no longer full-bleed.
4. **Rail placement relative to the zoom cluster (B3).** Needs step 1 landed so the rail's
   positioning logic (currently tied to `--sheet-visible`, [style.css:224](../src/style.css#L224))
   has a docked-mode geometry to key off.
5. **Keyboard navigation through lists and results (A2 remainder).** Natural once the
   panel's DOM order is settled by step 1.
6. **Responsive list layouts (B4) and peak hover tooltips (C2).** Independent of each
   other and of everything above except step 1's extra width being available to use.
7. **Width cap on the status/install banner (B5).** Small, can land any time after step 1
   establishes what the cap should be.
