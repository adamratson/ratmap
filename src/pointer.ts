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
