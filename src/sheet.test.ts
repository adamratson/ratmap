import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './sheet';
import { FLICK_PROJECTION_MS, snapDetent } from './sheet';

// Offsets are "how far down from fully open", so peek is the largest and full is zero.
const OFFSETS = { peek: 700, content: 400, full: 0 } as const;

describe('snapDetent', () => {
  it('settles on the nearest detent when the finger is not moving', () => {
    expect(snapDetent(690, 0, OFFSETS)).toBe('peek');
    expect(snapDetent(420, 0, OFFSETS)).toBe('content');
    expect(snapDetent(40, 0, OFFSETS)).toBe('full');
  });

  it('honours a flick that has barely moved', () => {
    // 40px down from fully open is nearest to `full`, but a fast downward flick is
    // unmistakably a request to get the map back.
    const fastDown = (OFFSETS.content - 40) / FLICK_PROJECTION_MS + 0.1;
    expect(snapDetent(40, fastDown, OFFSETS)).not.toBe('full');
  });

  it('opens on an upward flick from rest', () => {
    const fastUp = -((OFFSETS.peek - OFFSETS.content) / FLICK_PROJECTION_MS + 0.1);
    expect(snapDetent(OFFSETS.peek, fastUp, OFFSETS)).not.toBe('peek');
  });

  it('does not overshoot past the ends', () => {
    expect(snapDetent(OFFSETS.peek, 10, OFFSETS)).toBe('peek');
    expect(snapDetent(0, -10, OFFSETS)).toBe('full');
  });

  it('ignores a slow drift, which is a hesitant drag rather than a flick', () => {
    expect(snapDetent(410, 0.02, OFFSETS)).toBe('content');
    expect(snapDetent(410, -0.02, OFFSETS)).toBe('content');
  });

  it('picks the midpoint detent when the sheet is dragged there and let go', () => {
    const midway = (OFFSETS.peek + OFFSETS.content) / 2;
    expect(snapDetent(midway - 1, 0, OFFSETS)).toBe('content');
    expect(snapDetent(midway + 1, 0, OFFSETS)).toBe('peek');
  });
});

/**
 * jsdom does no real layout — every element reports offsetHeight 0. This fakes it by
 * selector, which is what lets these tests simulate "the peek row was empty when the
 * sheet first measured, then grew once real content was added" — the exact sequence
 * that exposed the bug below.
 */
function stubOffsetHeights(heights: Record<string, number>): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      for (const [selector, height] of Object.entries(heights)) {
        if (this.matches(selector)) return height;
      }
      return 0;
    },
  });
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
  };
}

/** jsdom ships no ResizeObserver. Real re-measurement on content growth is covered by
 *  the `window.dispatchEvent(new Event('resize'))` path these tests already exercise —
 *  the sheet's resize listener runs the identical `applyDetent(this.current, false)`
 *  a ResizeObserver tick would. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('BottomSheet', () => {
  let container: HTMLElement;
  let heights: Record<string, number>;
  let restoreOffsetHeight: () => void;
  let restoreInnerHeight: () => void;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    container = document.createElement('div');
    container.id = 'sheet';
    document.body.append(container);

    // The peek row starts empty (0px): BottomSheet's own constructor calls its first
    // applyDetent before main.ts has populated `.sheet-peek` with any content.
    heights = { '#sheet': 700, '.sheet-grip': 20, '.sheet-peek': 0, '.sheet-body': 0 };
    restoreOffsetHeight = stubOffsetHeights(heights);

    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    restoreInnerHeight = () => {
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
    };
  });

  afterEach(() => {
    container.remove();
    restoreOffsetHeight();
    restoreInnerHeight();
  });

  function transform(): string {
    return container.style.transform;
  }

  it('does not let a same-target recompute interrupt an in-flight open', () => {
    // Reproduces the actual boot sequence: constructed against an empty peek row (wrong,
    // small offset applied instantly) — content then arrives and grows the peek row —
    // open('peek') recomputes correctly and starts a real, animated transition to the
    // new offset — and then something unrelated (a ResizeObserver tick, here simulated
    // as a window resize) fires mid-flight, landing on that *same* now-correct offset.
    //
    // Before the fix, that last call unconditionally toggled the `sheet-animating`
    // class off, which — mid-CSS-transition — freezes the box at whatever partially
    // interpolated position it happened to be at that instant, not at either endpoint.
    // That is the actual mechanism behind "the sheet is stuck showing dead space below
    // the peek row": intermittent, and dependent on exactly when the interrupting call
    // lands, which is why it never reproduced on a fast dev machine.
    const sheet = new BottomSheet({ element: container });
    void sheet;

    heights['.sheet-peek'] = 100; // content has now been added
    sheet.open('peek'); // the real, animated correction
    expect(container.classList.contains('sheet-animating')).toBe(true);
    const animatedTransform = transform();

    // The interrupting call: same detent, same measured content, so the same target
    // offset — dispatched through the sheet's own resize listener, exactly the path a
    // same-target ResizeObserver tick takes.
    window.dispatchEvent(new Event('resize'));

    expect(container.classList.contains('sheet-animating')).toBe(true);
    expect(transform()).toBe(animatedTransform);
  });

  it('still applies a genuinely different offset while animating', () => {
    // The guard must not swallow real changes — only ones that recompute to the exact
    // offset already declared.
    const sheet = new BottomSheet({ element: container });
    heights['.sheet-peek'] = 100;
    sheet.open('peek');
    const beforeGrow = transform();

    heights['.sheet-peek'] = 160; // the peek row grew again — a genuinely new target
    window.dispatchEvent(new Event('resize'));

    expect(transform()).not.toBe(beforeGrow);
  });

  it('still reports layout changes through onLayout when the transform is unchanged', () => {
    // Toasts and the map attribution read the sheet's geometry on every onLayout call,
    // not only when the detent changes — the guard skips the DOM write, not the callback.
    const onLayout = vi.fn();
    const sheet = new BottomSheet({ element: container, onLayout });
    heights['.sheet-peek'] = 100;
    sheet.open('peek');
    onLayout.mockClear();

    window.dispatchEvent(new Event('resize'));

    expect(onLayout).toHaveBeenCalledWith('peek');
  });
});
