/**
 * Whether the primary pointer is a finger rather than a mouse.
 *
 * Several decisions turn on this and they should agree: how big a tap target has to be,
 * and whether MapLibre's 29px zoom buttons are worth the corner of the screen they take.
 *
 * Optional-chained because `matchMedia` is absent in jsdom, and a missing media-query API
 * is not evidence of a touch screen — a mouse is the safe assumption, since it only
 * costs precision rather than making anything untappable.
 */
export function isCoarsePointer(): boolean {
  return globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/**
 * The exact condition under which the sheet docks as a permanent left-hand panel instead
 * of a bottom sheet with drag detents — see `plans/desktop-ux-review.md` §3. A width
 * threshold alone would fire on a large touch tablet, which still wants the touch sheet;
 * `pointer: fine` and `hover: hover` together are what actually mean "a mouse, with room
 * to use it."
 *
 * This string must stay identical to the `@media` query in style.css's "Desktop (docked
 * panel)" block — CSS and JS each need their own copy of the condition, so it is
 * duplicated by necessity, not by accident. If one changes, change the other.
 *
 * Optional-chained for the same reason as {@link isCoarsePointer}: a missing
 * `matchMedia` is not evidence of a docked-capable browser, so it falls back to `false`,
 * i.e. the touch sheet.
 */
export function prefersDockedSheet(): boolean {
  return (
    globalThis.matchMedia?.('(pointer: fine) and (hover: hover) and (min-width: 60rem)')
      .matches ?? false
  );
}
