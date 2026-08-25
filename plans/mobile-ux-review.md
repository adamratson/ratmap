# Ratmap Mobile UX Review

**Audience: the implementing agent.** Findings and a redesign direction for ratmap's
mobile interface, produced 2026-08-24 by reading the source, running the app at
375×812 and 812×375, and probing the live DOM. See §1 for the headline problem, §2 for
individual findings (numbered, most to least severe), §3 for the redesign direction,
and §4 for suggested sequencing.

Rendered version with wireframes: https://claude.ai/code/artifact/7b2853e0-5b3b-402d-b028-c932b73d7820

---

## Status — 2026-08-25

All seven steps in §4 are implemented on branch `mobile-ux`. Findings A1–A3, B1–B6 and
C1–C5 are addressed; §3's redesign is in place.

Two things worth carrying forward:

- **A1 is still unconfirmed on a real device.** The iOS `contextmenu` behaviour is
  documented upstream, not device-tested. The replacement gesture (a pointer-event
  press-and-hold, `src/routes/press-hold.ts`) works on every platform regardless, so
  this is a matter of closing the finding rather than of the fix being at risk.
- **The region footprints (C4) were never seen in a browser.** The remote tile host
  stopped responding to the dev session partway through, so the map style never finished
  loading. The geometry, nesting and render wiring are covered by
  `src/regions/region-footprints.test.ts`; the on-map appearance is not.

Two corrections to this document are marked inline: the `showUserHeading` claim under C2,
and B4's suggestion that `Done` become a downward drag — it stayed as a button, because
while planning a map tap means "waypoint" rather than "open this summit" and the mode
needs an obvious exit.

Measured after the change, at 375×812, as a fraction of the screen the sheet covers:
15% at rest, 27% for a summit or the saved-places list, 29% for the planner, 38% for the
region catalogue — against the 34% the old planning panel took and could not give back.
In landscape the sheet becomes a left-hand side panel, so the map keeps the full
right-hand side rather than a 150px band.

---

## 0. Measured baseline

Sampling occluded screen area against the live DOM at 375×812:

| State | Chrome coverage |
|---|---|
| Browsing, no banners | 12% |
| Browsing with install banner (default state in a browser tab) | 18% |
| Route planner open, zero waypoints, no profile chart | 34% |

The route panel's `max-height: 60vh` caps it at 487px of the 812px screen once a
profile chart and straight-leg warning are showing. In landscape (812×375) the panel,
banner, and zoom cluster together leave roughly a 150px horizontal band of visible map.

The route panel also covers the entire HUD — **Locate cannot be tapped while planning a
route**, which is the moment a route is most likely to start from the user's current
position.

---

## 1. The map is competing with its own interface

Every surface in the app (`#search`, `#status-panel`, `#hud`, `#route-panel`, `#sheet`)
is absolutely positioned over the map and sized to its content
([src/main.ts](../src/main.ts), [src/style.css](../src/style.css)). Nothing collapses,
nothing is draggable, nothing yields to another surface. Five independent floating
panels, each owning a screen corner, none aware of the others. §3 proposes replacing
this with one draggable bottom sheet plus one control rail.

---

## 2. Findings

### Tier A — Doesn't work on the target platform

The spec states "build for iOS, enhance for Android." These three fail on iOS
specifically.

**A1. Waypoints cannot be removed on an iPhone.**
Deletion is wired to the `contextmenu` event
([route-planner.ts:480](../src/routes/route-planner.ts#L480), sole call site of
`removeWaypoint`). iOS Safari has not fired `contextmenu` on long-press since iOS 13 —
it shows the touch callout instead, and `.route-waypoint` sets
`-webkit-touch-callout: none`, so nothing happens at all. The hint text at
[routes-ui.ts:78](../src/routes/routes-ui.ts#L78) tells the user to long-press to
remove a waypoint; this is not actionable on iOS. `Undo` only removes the most recent
waypoint, so a mis-dropped waypoint in the middle of a route is permanent short of
clearing the whole route.

*Note: the iOS `contextmenu` behaviour is documented upstream
([mdn/browser-compat-data#6376](https://github.com/mdn/browser-compat-data/issues/6376),
[Leaflet#6817](https://github.com/Leaflet/Leaflet/issues/6817)), not device-tested in
this session — confirm on a real device before treating this as closed.*

Fix: detect long-press with a `touchstart` timer (~500ms, cancelled by `touchmove`), or
replace long-press with a tap-to-open popover (`Remove` / `Make start`) on the marker.
A visible affordance beats a hidden gesture on touch regardless of platform.

**A2. Summit taps are unreliable.**
`peakAt()` ([peaks.ts:150](../src/peaks.ts#L150)) queries a single pixel via
`queryRenderedFeatures(point, ...)`. Probed against a rendered peak in the running app:
a probe 18px from the peak's screen centre returns 0 hits; a 22px box returns 2 hits,
and the nearest peak is not first in the result array. A miss is not a no-op — while
browsing it calls `hideSheet()`; while planning a route it drops a waypoint at the
tapped coordinate instead of snapping to the summit.

Fix: query a padded box (~22px) instead of a point, gated on
`matchMedia('(pointer: coarse)')`; sort results by distance from the tap centre and
take the closest, since `hits[0]` is not guaranteed to be nearest.

**A3. Waypoint markers are 22px and are the drag handle.**
`.route-waypoint` is `1.4rem` (22px) square — the sole way to reposition a route,
smaller than Apple's 44pt minimum, on a surface (the map) that pans if the drag misses.

Fix: keep the 22px visual, wrap it in a 44px transparent hit area via padding and a
negative margin on the marker element, without moving its anchor point.

### Tier B — Costly on a phone

Works, but demands two hands, a stationary user, or tolerance for clutter.

**B1. Primary controls sit outside the one-handed thumb arc.**
Search sits 8px from the top of an 812px screen; MapLibre's `NavigationControl`
(zoom + pitch) sits beside it. Both are unreachable one-handed on a 6.1"+ device, and
the zoom buttons duplicate a pinch gesture that already works.

Fix: move search to the bottom (§3). Drop `NavigationControl` on coarse pointers;
surface a compass-reset button only when `bearing !== 0`, positioned at thumb height.

**B2. Status cards never auto-dismiss.**
No `setTimeout` anywhere in `showStatus()` ([main.ts:684](../src/main.ts#L684)).
"Saved 'Ben Nevis'" is a permanent banner over the map until manually dismissed.
Transient confirmations and ongoing conditions (offline, downloading) share one
component and stack in the same corner indefinitely.

Fix: split them. Confirmations become an auto-dismissing toast (~4s). Ongoing
conditions become a single-line strip reflecting current state, not an accumulating
stack.

**B3. Destructive actions have no confirmation and no undo.**
No `confirm()` call anywhere in `src/`. Deleting a downloaded region — potentially
hundreds of MB over a long transfer — is one tap on a button in the same grid slot
where every other row says "Download"
([regions-ui.ts](../src/regions/regions-ui.ts)). Deleting a saved place or route is one
tap on a `×`. Nothing is recoverable.

Fix: for places/routes, delete immediately but show a 5s "Undo" toast. For regions, a
real confirmation naming the region and its size — the cost of a mistake there is a
re-download, not a click.

**B4. Five equal-weight route-planning buttons, one of which is destructive.**
`Undo · Save · Follow · Clear · Done` render as identically styled grey pills
([style.css](../src/style.css), `.route-actions button`). `Clear` sits immediately
beside `Done` with no visual distinction between finishing and destroying.

Fix: one primary action (state-dependent: `Follow` or `Save`), `Undo` as an icon,
`Clear` moved to an overflow. `Done` becomes a downward drag on the sheet (§3).

**Correction (2026-08-25):** `Done` stayed a button. Dragging the sheet down reveals the
map but does not leave planning mode, and while planning a tap on the map means
"waypoint" rather than "open this summit" — so the mode needs an exit that is visibly an
exit. `Clear` moved to its own row instead, at the opposite end and coloured
destructively.

**B5. Search results don't show distance.**
Results are ordered by distance from the viewport centre
([search.ts:118](../src/search.ts#L118)) but display only `kind · elevation`
([main.ts:596](../src/main.ts#L596)). Scotland has several "Ben More"s; the ranking
that resolves the ambiguity is invisible to the user.

Fix: surface distance and bearing, e.g. `Summit · 1174 m · 12 km SW`. The query already
computes the ordering distance — return it instead of discarding it.

**B6. Internal constraint IDs leak into user-facing copy.**
Three strings end in "(C1)", referencing a row in
[docs/IMPLEMENTATION.md](../docs/IMPLEMENTATION.md). One is the first thing shown on
first launch.

Fix: rewrite for the reader, e.g. *"Add ratmap to your Home Screen to download maps. In
a browser tab, iOS can delete them without warning."* Same information, no decoder ring.

### Tier C — Missing for the way the app is actually used

Not defects — gaps between what the app does and what standing on a hill with it
requires.

**C1. No screen wake lock while following a route.**
The spec states following means "app foregrounded and screen on." A working
`WakeLock` class already exists ([downloader.ts:42](../src/regions/downloader.ts#L42))
and is correctly re-acquired on `visibilitychange`, but its only consumer is region
downloads. The one mode that structurally depends on the screen staying awake doesn't
take the lock.

Fix: acquire in `startFollowing()`, release in `stopFollowing()` — a small change
against an existing, tested class.

**C2. The location dot has no heading.**
The dot answers "where am I"; on a mountain the more urgent question is "which way am I
facing." `LocationController` ([location.ts](../src/location.ts)) renders a plain
circle with an accuracy halo, no bearing.

Fix: add a heading cone from `deviceorientation`.

**Correction (2026-08-25):** this finding originally said to review MapLibre's own
`GeolocateControl` (`showUserHeading`) first. That option does not exist in MapLibre —
it is Mapbox GL JS. Checked against the installed v5 bundle: `GeolocateControlOptions`
has no such field and the bundle contains no reference to `deviceorientation` at all.
There is nothing upstream to borrow, so this has to be written from scratch, handling
Safari's `webkitCompassHeading` (already true-north referenced) and Chromium's absolute
`alpha` (which runs the opposite way) separately, plus the iOS motion-permission prompt,
which must be raised from a user gesture. Implemented in `src/heading.ts`.

**C3. No dark mode.**
`color-scheme: light` is hard-coded ([style.css](../src/style.css)), the basemap is
pinned to `namedFlavor('light')` ([main.ts](../src/main.ts)), and there is no
`prefers-color-scheme` query anywhere in the stylesheet. A full-white screen at dusk is
both unpleasant and a real night-vision problem for the app's actual use case.

Fix: Protomaps ships a dark flavour — swap it and reload the style. The chrome is
already largely token-shaped. A manual in-app override matters more than following the
system setting: people are likely to want the map dark before the phone.

**C4. Offline regions have no relationship to the map.**
Four named regions render as a plain list in a sheet
([regions-ui.ts](../src/regions/regions-ui.ts)). Nothing draws a region's footprint on
the map, nothing indicates which region covers the area currently being viewed, and the
detail-limit notice ([detail-limit.ts](../src/detail-limit.ts)) correctly reports
"limited detail here" but offers no path to the region that would fix it.

Fix: draw the catalogue's bounding boxes as a map layer (filled for downloaded,
outlined for available). Make the detail notice tappable, resolving to the region
containing the viewport centre. Keep the sheet list as the manage/delete surface.

**C5. Sheets lack dialog semantics; status isn't announced.**
No `role="dialog"`, no focus trap, no Escape-to-close on `#sheet`/`#route-panel`; no
`aria-live` on `#status-panel`. Screen-reader users get no announcement when a download
finishes or a save succeeds, and keyboard focus can fall through an open sheet into the
map behind it.

Fix: `aria-live="polite"` on the status container is a low-cost, high-value change that
can land independently. Full dialog semantics fit naturally once the sheet is rebuilt
as a `<dialog>`-backed component under §3.

---

## 3. Redesign direction: one sheet, one rail

Findings B1 and B4, and the coverage problem in §0, are one root cause — five
independently positioned panels — not five separate layout bugs. Proposal:

- **One bottom sheet**, three detents (peek ~96px / half ~50% / full ~92%), dragged
  rather than toggled. Every non-map surface — search, summit detail, route planning,
  following, regions, saved places — lives inside it. A downward flick from any state
  returns the map, which is the gesture people already try today and which currently
  does nothing. Peek carries the search field and mode chips; this moves search from
  804px away from the thumb to roughly 80px, and puts it next to the keyboard rather
  than 700px above it.
  Replaces: `#sheet`, `#route-panel`, `#hud`, persistent `#status-panel` cards.

- **One control rail**, right edge, 55–75% down the screen, thumb height, 44pt targets:
  `Locate` (carrying the heading cone from C2) and a conditional `Compass` button that
  appears only when the map is rotated. `NavigationControl` is dropped on coarse
  pointers — pinch and two-finger rotate already cover it, at full-screen size. The
  rail sits above the sheet in stacking order and is never covered by it, which
  structurally removes the "can't tap Locate while planning" problem rather than
  patching around it.

- **Three explicit modes — Browse, Plan, Follow.** A map tap currently means different
  things depending on invisible planner state, signalled only by a blue tint on a
  button hidden behind the panel that produced it. Making the mode explicit in the peek
  row lets it own both tap behaviour and sheet contents. `Follow` gets its own layout
  rather than a variant of the planning panel — the one mode used one-handed while
  moving, possibly in rain: distance/ascent/off-route as three large numbers, high
  contrast, dark by default, wake lock held for the duration (C1).

- **Status, split.** Confirmations become auto-dismissing toasts just above the sheet,
  `aria-live="polite"`, carrying `Undo` where applicable (B2, B3, C5). Ongoing
  conditions become a one-line strip at the very top — offline / downloading 42% /
  limited detail here — reflecting current state, tappable to act on it. The install
  prompt is the exception: it deserves a proper first-run onboarding screen rather than
  a banner that reappears indefinitely because a browser tab can never satisfy C1's
  persistence gate.

- **Regions, on the map.** Bounding boxes as a layer; the detail notice becomes a
  button resolving from viewport centre (C4). The sheet's region list remains the
  manage/delete surface.

---

## 4. Suggested order of work

Sequenced by dependency, not size.

1. **Touch correctness (A1–A3).** Box-query for summits, a real long-press or
   tap-popover for waypoint removal, 44pt hit areas. The app currently instructs users
   to perform a gesture (long-press to delete) that does not work on its primary
   platform; nothing else should ship ahead of this.
2. **Status split and copy pass (B2, B3, B6).** Toasts with undo, a persistent strip,
   the C-numbers removed from user-facing text. Independent of everything else, and
   removes the 6%-of-screen banner that's up on every default launch.
3. **The sheet.** The structural change (§3). Move the existing sheet/panel *contents*
   in unchanged first — they're fine; it's the positioning that isn't.
4. **The rail; drop `NavigationControl` on touch (B1).** Cheap once the sheet owns the
   bottom of the screen, and is what frees the top corners.
5. **Modes, and a real Follow layout (B4, C1).** Turns the route planner into something
   usable while actually walking.
6. **Heading, dark mode, region footprints (C2–C4).** Independent of each other and of
   everything above; each is a self-contained unit of work, each is visible to the user
   on first use.
7. **Accessibility pass (C5).** Best finished last because the sheet rebuild in step 3
   is where dialog semantics naturally land — but `aria-live` on the status panel can
   land today, independently.
