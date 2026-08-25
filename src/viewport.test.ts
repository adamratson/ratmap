import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncTrueHeight, trueViewportHeight } from './viewport';

function stub(target: object, values: Record<string, unknown>): () => void {
  const originals = Object.keys(values).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(target, key),
  ]) as [string, PropertyDescriptor | undefined][];

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, { configurable: true, value });
  }

  return () => {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(target, key, original);
    }
  };
}

describe('trueViewportHeight', () => {
  let restore: () => void;

  afterEach(() => restore?.());

  it('trusts innerHeight when it already agrees with the OS', () => {
    restore = stub(window, { innerHeight: 852, innerWidth: 393 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 852 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 });

    expect(trueViewportHeight()).toBe(852);
  });

  it('falls back to screen.height when innerHeight under-reports, in portrait', () => {
    // The actual bug this module exists to work around: measured on a real iPhone with
    // a Dynamic Island, innerHeight (793) was exactly screen.height (852) minus the top
    // safe-area inset (59).
    restore = stub(window, { innerHeight: 793, innerWidth: 393 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 852 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 });

    expect(trueViewportHeight()).toBe(852);
  });

  it('takes the short physical dimension in landscape, when screen.* does not rotate (iOS)', () => {
    // iOS Safari famously keeps screen.width/height fixed at the portrait dimensions
    // regardless of how the phone is actually held — screen.height stays the long
    // (portrait) dimension even in landscape. The short physical dimension is the one
    // that is "height" now, and it could be sitting in either property, so this must not
    // read `screen.height` or `screen.width` individually as "the" height.
    restore = stub(window, { innerHeight: 393, innerWidth: 793 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 852 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 });

    expect(trueViewportHeight()).toBe(393);
  });

  it('takes the short physical dimension in landscape, when screen.* does rotate (Chromium)', () => {
    // The opposite convention, and a real regression caught live in this codebase: a
    // Chromium viewport resized to a landscape aspect ratio rotates screen.width/height
    // to match, so `screen.height` itself is now the *short* dimension. A version of this
    // function that trusted `screen.height` specifically as "the height" reported the
    // portrait height (852) while genuinely in landscape.
    restore = stub(window, { innerHeight: 375, innerWidth: 812 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 375 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 812 });

    expect(trueViewportHeight()).toBe(375);
  });

  it('never reports less than innerHeight, even if screen.* looks smaller or missing', () => {
    // innerHeight has only ever been observed under-reporting, never over-reporting —
    // so it is always a safe floor, and screen.* is the fallback, not an override.
    restore = stub(window, { innerHeight: 900, innerWidth: 400 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 852 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 });

    expect(trueViewportHeight()).toBe(900);
  });

  it('discards a screen.* reading that is not describing this viewport at all', () => {
    // Found live: a browser pane whose resize_window changes the emulated viewport
    // without touching screen.width/height, leaving them at the host machine's real
    // monitor resolution — 1107x1710 against a 375x812 page. Nothing distinguishes that
    // from a genuine multi-monitor desktop setup, so the fix is a cap, not a special
    // case: the real bug this module corrects for is a safe-area inset, comfortably
    // under 100px on any current device.
    restore = stub(window, { innerHeight: 375, innerWidth: 812 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 1107 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 1710 });

    expect(trueViewportHeight()).toBe(375);
  });

  it('accepts a correction right at the boundary of plausible', () => {
    restore = stub(window, { innerHeight: 793, innerWidth: 393 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 793 + 100 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 });

    expect(trueViewportHeight()).toBe(793 + 100);
  });
});

describe('syncTrueHeight', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = stub(window, { innerHeight: 793, innerWidth: 393 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 852 });
    Object.defineProperty(screen, 'width', { configurable: true, value: 393 });
  });

  afterEach(() => restore());

  it('applies the corrected height immediately', () => {
    const el = document.createElement('div');
    syncTrueHeight(el);
    expect(el.style.height).toBe('852px');
  });

  it('reapplies on resize', () => {
    const el = document.createElement('div');
    syncTrueHeight(el);

    Object.defineProperty(screen, 'height', { configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));

    expect(el.style.height).toBe('900px');
  });

  it('stops listening once disposed', () => {
    const el = document.createElement('div');
    const stop = syncTrueHeight(el);
    stop();

    Object.defineProperty(screen, 'height', { configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));

    expect(el.style.height).toBe('852px');
  });
});
