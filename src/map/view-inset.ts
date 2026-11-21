// How much of the map is covered by the app's own chrome — the sheet, mostly — so a camera
// move can put what it is moving to in the middle of what is left showing.
//
// Passed to each move as an offset (or, for fitBounds, padding) rather than set once with
// `map.setPadding`. Transform padding persists, and changing it as the sheet moves would
// either slide the whole map every time the sheet did or need correcting on every change,
// cancelling whatever animation was under way. An offset belongs to the one move.

export interface ViewInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSET: ViewInset = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The easeTo/flyTo `offset` that lands the target in the middle of the uncovered area:
 * MapLibre's offset is from the middle of the whole map, in screen px.
 */
export function insetOffset(inset: ViewInset): [number, number] {
  return [(inset.left - inset.right) / 2, (inset.top - inset.bottom) / 2];
}

/** fitBounds padding: the inset, plus `margin` all round inside it. */
export function insetPadding(inset: ViewInset, margin: number): ViewInset {
  return {
    top: inset.top + margin,
    right: inset.right + margin,
    bottom: inset.bottom + margin,
    left: inset.left + margin,
  };
}
