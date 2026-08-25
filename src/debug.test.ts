import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugOverlay, isDebugOverlayEnabled, setDebugOverlayEnabled } from './debug';

describe('debug overlay preference', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is off until explicitly turned on', () => {
    expect(isDebugOverlayEnabled()).toBe(false);
  });

  it('remembers being turned on, and off again', () => {
    setDebugOverlayEnabled(true);
    expect(isDebugOverlayEnabled()).toBe(true);

    setDebugOverlayEnabled(false);
    expect(isDebugOverlayEnabled()).toBe(false);
  });

  it('survives storage being unavailable rather than failing startup over it', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });

    expect(() => setDebugOverlayEnabled(true)).not.toThrow();
    expect(isDebugOverlayEnabled()).toBe(false);
  });
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('DebugOverlay', () => {
  let sheetEl: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.useFakeTimers();

    document.body.innerHTML = `
      <div id="app">
        <div id="map"></div>
        <div id="sheet">
          <div class="sheet-grip"></div>
          <div class="sheet-peek"></div>
          <div class="sheet-scroll"></div>
        </div>
      </div>
    `;
    sheetEl = document.querySelector<HTMLElement>('#sheet')!;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the sheet geometry once started', () => {
    const overlay = new DebugOverlay(sheetEl);
    overlay.start();

    const box = document.querySelector('.debug-overlay')!;
    expect(box.textContent).toContain('#sheet offsetHeight=');
    expect(box.textContent).toContain('gap vs innerHeight=');

    overlay.stop();
  });

  it('removes everything it added, on stop', () => {
    const overlay = new DebugOverlay(sheetEl);
    overlay.start();
    overlay.stop();

    expect(document.querySelector('.debug-overlay')).toBeNull();
    expect(document.querySelector('.debug-probe')).toBeNull();
  });

  it('keeps refreshing on a timer without needing a DOM mutation to trigger it', () => {
    const overlay = new DebugOverlay(sheetEl);
    overlay.start();
    const box = document.querySelector('.debug-overlay')!;
    const first = box.textContent;

    sheetEl.getBoundingClientRect = () =>
      ({ top: 42, bottom: 42, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
    vi.advanceTimersByTime(500);

    expect(box.textContent).not.toBe(first);
    overlay.stop();
  });

  it('does not throw when the timer fires after stop', () => {
    const overlay = new DebugOverlay(sheetEl);
    overlay.start();
    overlay.stop();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});
