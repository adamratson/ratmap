// Works around a real WebKit bug: in this app's installed, standalone-mode iOS PWA
// configuration, `window.innerHeight` (and `visualViewport.height`,
// `documentElement.clientHeight` — all three agree with each other) under-reports the
// true screen height by exactly the top safe-area inset. Confirmed on a real iPhone with
// a Dynamic Island: `screen.height` read 852, `innerHeight` read 793, and
// `852 - 793 === env(safe-area-inset-top)` exactly. A `position: fixed; top: 0` marker
// landed at the true top of the screen; a `position: fixed; bottom: 0` marker landed 59pt
// short of the true bottom, with white space below it — so `top: 0` resolves correctly
// and `bottom: 0` (and therefore `inset: 0`'s height, and therefore `92vh` before that,
// and therefore every fix attempted before this one) resolves against the same
// too-short reference. `#app { position: fixed; inset: 0 }` inherited exactly that bug.
//
// `screen.height`/`screen.width` are the one pair of numbers here that are OS-level, not
// page-level, and so don't share whatever WebKit quirk produces the innerHeight bug. The
// complication: browsers disagree on whether these rotate with device orientation. iOS
// Safari famously does not — `screen.height`/`screen.width` stay fixed at the portrait
// dimensions no matter how the phone is held (verified live in this codebase: resizing a
// Chromium viewport to a landscape aspect ratio rotated `screen.width`/`height` to match,
// which would have made this function report the *portrait* height while actually in
// landscape, had it assumed either property was reliably "the height"). So this never
// reads `screen.height` or `screen.width` individually as "the" height — it takes
// `Math.max`/`Math.min` of the *pair*, current values, and picks between them using the
// current orientation (from `innerHeight`/`innerWidth`, which do track real orientation
// correctly on every browser tested; only the *magnitude* of innerHeight is short on the
// affected device, not which of the two is larger). That is correct whether or not the
// browser rotates the underlying properties, because it never assumes which of the two
// holds which value — only that one of them is the long dimension and one is the short.
//
// This is deliberately narrow: it exists to give #app an explicit, correct height
// instead of trusting `bottom: 0`/`inset: 0`'s own resolution. Nothing else should need
// to read screen.height directly — #map and #sheet both derive their sizing from #app.
//
// `screen.width`/`height` are not always a meaningful signal in the first place: found
// live, in this codebase's own dev tooling, a browser pane whose `resize_window` changes
// the emulated viewport without touching `screen.width`/`height` at all, leaving them at
// the *host machine's* real monitor resolution — wildly larger than the page, and
// unrelated to it. Nothing distinguishes that case from a genuine multi-monitor desktop
// setup, so it cannot be special-cased away; the correction is capped instead. The real
// bug this module fixes is a safe-area inset, comfortably under 100px on any current
// device — a `physical` reading further from innerHeight than that is a sign the number
// is not describing this viewport at all, and is discarded in favour of innerHeight.
const MAX_CORRECTION_PX = 150;

/**
 * The screen's true height in the current orientation, taking the larger of what the
 * page itself reports and what the OS reports — never *smaller* than innerHeight, since
 * innerHeight has only ever been observed under-reporting here, never over-reporting —
 * and never more than {@link MAX_CORRECTION_PX} larger, which would mean screen.* is not
 * describing this viewport at all.
 */
export function trueViewportHeight(): number {
  const portrait = innerHeight >= innerWidth;
  const screenLong = Math.max(screen.width, screen.height);
  const screenShort = Math.min(screen.width, screen.height);
  const physical = portrait ? screenLong : screenShort;

  if (!physical || physical <= innerHeight) return innerHeight;
  if (physical - innerHeight > MAX_CORRECTION_PX) return innerHeight;
  return physical;
}

/**
 * Keep `element`'s height in sync with {@link trueViewportHeight}, for as long as the
 * returned function isn't called to stop.
 */
export function syncTrueHeight(element: HTMLElement): () => void {
  const apply = (): void => {
    element.style.height = `${trueViewportHeight()}px`;
  };
  apply();

  window.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);

  return () => {
    window.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('resize', apply);
    window.removeEventListener('orientationchange', apply);
  };
}
