// One-line tips for gestures nothing on screen shows, retired for good once used.
//
// Press-and-hold for a point's coordinates was findable only by accident: the one mention
// of it was in the route planner's empty-state hint, about removing waypoints. A tip on the
// summit card — the card everyone sees first — names it, until it has been used once.

const COORDS_KEY = 'ratmap.hint.coords-used';

/** Whether the coordinates gesture (long-press, or right-click) has ever been used here. */
export function coordsGestureUsed(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(COORDS_KEY) === '1';
  } catch {
    return false;
  }
}

/** It has: stop telling them about it. */
export function markCoordsGestureUsed(storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(COORDS_KEY, '1');
  } catch {
    // Storage blocked: the tip keeps showing, which is all that is lost.
  }
}

/** The tip, worded for the pointer in hand. */
export function coordsHint(coarsePointer: boolean): string {
  return coarsePointer
    ? 'Tip: press and hold anywhere on the map for its coordinates, height and a route there.'
    : 'Tip: right-click anywhere on the map for its coordinates, height and a route there.';
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
