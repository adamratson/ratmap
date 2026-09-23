// An opt-in overlay that prints the sheet's own geometry and the viewport metrics it
// depends on, directly on screen.
//
// Exists because a real device has twice disagreed with every dev-tool viewport emulator
// available in this environment: `92vh` and `position:fixed;inset:0` measured different
// references on an iPhone with a Dynamic Island (fixed in f437c8b), and after that fix
// the same symptom — dead space below the sheet's peek row — was still reported. Guessing
// blind against tooling that cannot reproduce iOS Safari standalone mode wastes a
// round-trip per guess; this instead asks the device directly. Off by default, toggled
// from Settings — not an always-on tax on everyone else's screen.

const STORAGE_KEY = 'ratmap.debug-overlay';

export function isDebugOverlayEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDebugOverlayEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not being able to remember the setting is survivable; the overlay just needs
    // re-enabling next launch.
  }
}

/**
 * Prints the sheet's geometry, plus every "how tall is the screen" number this app's
 * layout leans on, so a mismatch between them is visible without doing the transform
 * arithmetic by hand from a screenshot.
 *
 * Also draws two pure-CSS marker lines, `bottom: 0` and `top: 0`, with no JS-computed
 * position at all. Every number this class prints — innerHeight, visualViewport.height,
 * documentElement.clientHeight, #app's own offsetHeight — comes from *inside* the page,
 * so if the page's own rendering surface (the WKWebView's frame, as composited onto the
 * physical screen) is itself shorter than the true screen, every one of those numbers can
 * agree with each other and still be wrong: the whole page would think it fills the
 * screen while a strip of screen below or above it is native OS backdrop, not web
 * content, and nothing measured from JS can see that. The marker lines are the direct
 * test — if there is still a visible gap between the bottom line and the true bottom of
 * a screenshot, the problem is outside the page, not in this app's CSS.
 */
export class DebugOverlay {
  private readonly sheetElement: HTMLElement;
  private readonly box: HTMLElement;
  private readonly probeTop: HTMLElement;
  private readonly probeBottom: HTMLElement;
  private readonly markerTop: HTMLElement;
  private readonly markerBottom: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly onTick = (): void => this.render();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(sheetElement: HTMLElement) {
    this.sheetElement = sheetElement;

    this.box = document.createElement('pre');
    this.box.className = 'debug-overlay';

    // env() can only be read back out of a real box's computed style; there is no direct
    // JS accessor for it.
    this.probeTop = document.createElement('div');
    this.probeTop.className = 'debug-probe';
    this.probeTop.style.paddingTop = 'env(safe-area-inset-top)';

    this.probeBottom = document.createElement('div');
    this.probeBottom.className = 'debug-probe';
    this.probeBottom.style.paddingBottom = 'env(safe-area-inset-bottom)';

    this.markerTop = document.createElement('div');
    this.markerTop.className = 'debug-marker debug-marker-top';
    this.markerBottom = document.createElement('div');
    this.markerBottom.className = 'debug-marker debug-marker-bottom';

    this.observer = new ResizeObserver(this.onTick);
  }

  start(): void {
    document.body.append(
      this.box,
      this.probeTop,
      this.probeBottom,
      this.markerTop,
      this.markerBottom,
    );
    this.observer.observe(this.sheetElement);
    window.addEventListener('resize', this.onTick);
    window.visualViewport?.addEventListener('resize', this.onTick);
    // Catches anything the observers miss — a CSS transition settling, a status-bar
    // height change with nothing DOM-observable attached to it.
    this.timer = setInterval(this.onTick, 500);
    this.render();
  }

  stop(): void {
    this.observer.disconnect();
    window.removeEventListener('resize', this.onTick);
    window.visualViewport?.removeEventListener('resize', this.onTick);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.box.remove();
    this.probeTop.remove();
    this.probeBottom.remove();
    this.markerTop.remove();
    this.markerBottom.remove();
  }

  private render(): void {
    const el = this.sheetElement;
    const grip = el.querySelector<HTMLElement>('.sheet-grip');
    const peek = el.querySelector<HTMLElement>('.sheet-peek');
    const scroller = el.querySelector<HTMLElement>('.sheet-scroll');
    const app = document.querySelector<HTMLElement>('#app');
    const map = document.querySelector<HTMLElement>('#map');
    if (!grip || !peek || !scroller || !app || !map) return;

    const rect = el.getBoundingClientRect();
    const peekRect = peek.getBoundingClientRect();
    const appRect = app.getBoundingClientRect();
    const vv = window.visualViewport;

    // The two numbers that actually answer "is there a gap and how big" — everything
    // else is here to explain *why*, once one of these is non-zero.
    const gapVsInnerHeight = innerHeight - peekRect.bottom;
    const gapVsVisualViewport = vv ? vv.height - peekRect.bottom : null;

    this.box.textContent = [
      `standalone=${matchMedia?.('(display-mode: standalone)').matches ?? 'n/a'}`,
      `gap vs innerHeight=${gapVsInnerHeight.toFixed(1)}`,
      `gap vs visualViewport=${gapVsVisualViewport === null ? 'n/a' : gapVsVisualViewport.toFixed(1)}`,
      '',
      `innerHeight=${innerHeight} dpr=${devicePixelRatio}`,
      `visualViewport height=${vv?.height ?? 'n/a'} offsetTop=${vv?.offsetTop ?? 'n/a'}`,
      `documentElement.clientHeight=${document.documentElement.clientHeight}`,
      // OS-level, not page-level — independent of anything the WKWebView reports about
      // its own viewport, so a divergence here points outside the page entirely.
      `screen.height=${screen.height} screen.availHeight=${screen.availHeight}`,
      `scrollY=${scrollY} documentElement.scrollTop=${document.documentElement.scrollTop}`,
      `safe-area top=${getComputedStyle(this.probeTop).paddingTop} bottom=${getComputedStyle(this.probeBottom).paddingBottom}`,
      '',
      `#app offsetHeight=${app.offsetHeight} rectTop=${appRect.top.toFixed(1)} rectBottom=${appRect.bottom.toFixed(1)}`,
      `#map offsetHeight=${map.offsetHeight}`,
      '',
      `#sheet class=${el.className}`,
      `#sheet offsetHeight=${el.offsetHeight} rectTop=${rect.top.toFixed(1)} rectBottom=${rect.bottom.toFixed(1)}`,
      `#sheet inline-transform=${el.style.transform}`,
      `#sheet computed-transform=${getComputedStyle(el).transform}`,
      `.sheet-grip offsetHeight=${grip.offsetHeight}`,
      `.sheet-peek offsetHeight=${peek.offsetHeight} rectBottom=${peekRect.bottom.toFixed(1)}`,
      `.sheet-scroll offsetHeight=${scroller.offsetHeight} visibility=${getComputedStyle(scroller).visibility}`,
    ].join('\n');
  }
}
