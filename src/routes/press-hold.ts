// Press-and-hold, built on pointer events rather than `contextmenu`.
//
// `contextmenu` is the conventional "remove this pin" gesture and it is what this app
// used, but iOS Safari has not fired it on long-press since iOS 13 — it shows the touch
// callout instead, and suppressing the callout with `-webkit-touch-callout: none` does not
// bring the event back. On an iPhone, which is the platform this app is built for first,
// the gesture simply did nothing.
//
// Pointer events are unaffected: `pointerdown` fires ahead of `touchstart`, and
// preventDefault on the touch event (which MapLibre's marker drag calls) does not cancel
// it. So the timer below runs on every platform, and `contextmenu` stays wired up
// alongside it for right-click on a desktop.

/** How long a press must be held. Matches the platform long-press on iOS and Android. */
export const PRESS_HOLD_MS = 500;

/**
 * How far the pointer may drift and still count as a press.
 *
 * Deliberately larger than MapLibre's 3 px drag tolerance: a finger resting on a target
 * wobbles, and a hold that aborts at 3 px of wobble reads as the gesture not working.
 * Moving further than this is a drag, and the drag handler owns it from there.
 */
export const PRESS_HOLD_SLOP_PX = 10;

export interface PressHoldOptions {
  /** The press has begun and is now running its timer. Use it to show progress. */
  onStart?(): void;
  /** The press ended without completing — released early, or turned into a drag. */
  onCancel?(): void;
  /** Held for the full duration. Fires while the pointer is still down. */
  onHold(): void;
  holdMs?: number;
  slopPx?: number;
}

/**
 * Fire `onHold` when `element` is pressed and held still.
 *
 * @returns a disposer that clears any running timer and unbinds every listener.
 */
export function onPressHold(element: HTMLElement, options: PressHoldOptions): () => void {
  const holdMs = options.holdMs ?? PRESS_HOLD_MS;
  const slopPx = options.slopPx ?? PRESS_HOLD_SLOP_PX;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;

  function stop(notify: boolean): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    origin = null;
    if (notify) options.onCancel?.();
  }

  function onDown(event: PointerEvent): void {
    // A secondary mouse button is a right-click: `contextmenu` already handles that, and
    // running a timer for it too would remove the waypoint twice.
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    stop(true);
    origin = { x: event.clientX, y: event.clientY };
    options.onStart?.();
    timer = setTimeout(() => {
      timer = null;
      origin = null;
      options.onHold();
    }, holdMs);
  }

  function onMove(event: PointerEvent): void {
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (dx * dx + dy * dy > slopPx * slopPx) stop(true);
  }

  const onRelease = (): void => stop(true);

  element.addEventListener('pointerdown', onDown);
  // Touch pointers are implicitly captured by the element that received `pointerdown`, so
  // a finger sliding off the marker still reports here. A mouse is not captured, which is
  // what `pointerleave` covers.
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onRelease);
  element.addEventListener('pointercancel', onRelease);
  element.addEventListener('pointerleave', onRelease);

  return () => {
    stop(false);
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onRelease);
    element.removeEventListener('pointercancel', onRelease);
    element.removeEventListener('pointerleave', onRelease);
  };
}
