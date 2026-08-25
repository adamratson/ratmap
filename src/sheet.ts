// The app's one non-map surface.
//
// There used to be five, each absolutely positioned into a screen corner and sized to its
// content: the search field, a status stack, a four-button HUD, the route-planning panel
// and a detail sheet. None of them knew about the others, none could be moved or
// collapsed, and together they cost 34% of a 375x812 screen while planning a route — with
// an empty route and no elevation profile drawn. The planning panel covered the HUD
// outright, so Locate was unreachable at exactly the moment someone wants to route from
// where they are standing.
//
// One sheet instead, dragged rather than toggled. Its resting state ("peek") carries the
// controls you reach for first, which also moves them from the top of the screen into
// thumb reach. Dragging down always gives the map back — the gesture people already try.

export type Detent = 'peek' | 'half' | 'full';

/** Ordered shallowest-first, i.e. by how much of the screen the sheet takes. */
export const DETENTS: readonly Detent[] = ['peek', 'half', 'full'] as const;

/** Fraction of the viewport each detent shows. `peek` is measured, not fixed. */
const DETENT_FRACTION: Record<Exclude<Detent, 'peek'>, number> = { half: 0.5, full: 0.92 };

/**
 * How far ahead of itself a flick is projected before snapping.
 *
 * Snapping to the nearest detent alone ignores intent: a fast flick that has only
 * travelled 40px is unmistakably a request to close, and stopping it where the finger
 * happened to lift feels like the sheet fought back.
 */
export const FLICK_PROJECTION_MS = 120;

/** Movement under this is a tap that wandered, not a drag. */
const DRAG_SLOP_PX = 4;

/**
 * Which detent a drag should settle on.
 *
 * Pure, and separated out because it is the only part of dragging with a right answer
 * worth pinning down — the rest is bookkeeping over pointer events.
 *
 * @param offsetPx how far the sheet is currently translated down from fully open.
 * @param velocityPxPerMs signed; positive is downward, i.e. towards closing.
 */
export function snapDetent(
  offsetPx: number,
  velocityPxPerMs: number,
  offsets: Record<Detent, number>,
): Detent {
  const projected = offsetPx + velocityPxPerMs * FLICK_PROJECTION_MS;

  let best: Detent = 'peek';
  let bestDistance = Infinity;
  for (const detent of DETENTS) {
    const distance = Math.abs(offsets[detent] - projected);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = detent;
    }
  }
  return best;
}

export interface BottomSheetOptions {
  element: HTMLElement;
  /**
   * Fired after every settle *and* every re-measure, not only when the detent changes.
   *
   * Things outside the sheet have to move with it — the map attribution, which is legally
   * required and must never end up underneath it, and toasts. Those need the new geometry
   * on a viewport resize too, where the detent has not changed but its height has.
   */
  onLayout?(detent: Detent): void;
}

export class BottomSheet {
  /** Always visible. Holds the controls that must never be more than a glance away. */
  readonly peek: HTMLElement;
  /** Scrollable. Whatever the sheet is currently showing. */
  readonly body: HTMLElement;

  private readonly element: HTMLElement;
  private readonly onLayout?: (detent: Detent) => void;
  private current: Detent = 'peek';

  private dragging = false;
  private pointerId: number | null = null;
  private startY = 0;
  private startOffset = 0;
  private lastY = 0;
  private lastTime = 0;
  private velocity = 0;
  private passedSlop = false;

  constructor(options: BottomSheetOptions) {
    this.element = options.element;
    this.onLayout = options.onLayout;

    this.element.classList.add('sheet');
    this.element.innerHTML = `
      <div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-peek"></div>
      <div class="sheet-body" id="sheet-body" role="region" tabindex="-1"></div>
    `;
    this.peek = this.element.querySelector<HTMLElement>('.sheet-peek')!;
    this.body = this.element.querySelector<HTMLElement>('.sheet-body')!;

    // The peek row's height is content-driven — it changes when the planner adds a chip —
    // and it defines the resting position, so it has to be re-measured rather than fixed.
    new ResizeObserver(() => this.applyDetent(this.current, false)).observe(this.peek);
    window.addEventListener('resize', () => this.applyDetent(this.current, false));

    this.element.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.element.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.element.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.element.addEventListener('pointercancel', (event) => this.onPointerUp(event));

    this.applyDetent('peek', false, false);
  }

  detent(): Detent {
    return this.current;
  }

  /**
   * How much of the screen the sheet currently covers, in px.
   *
   * Derived from the detent rather than measured off the element: during the snap
   * animation the element's rect reports where it is *now*, and callers positioning
   * things above the sheet need where it is *going*, so they can transition with it
   * rather than a beat behind.
   */
  visibleHeight(): number {
    return Math.max(0, this.element.offsetHeight - this.offsets()[this.current]);
  }

  /** Move to a detent, animated. Safe to call with the current one. */
  open(detent: Detent): void {
    this.applyDetent(detent, true);
  }

  /** Back to resting. There is no "closed": the peek row is the app's main controls. */
  collapse(): void {
    this.open('peek');
  }

  /** Offset, in px from fully open, for each detent at the current viewport size. */
  private offsets(): Record<Detent, number> {
    const height = this.element.offsetHeight;
    const peekHeight = this.peek.offsetHeight + this.gripHeight();
    return {
      peek: Math.max(0, height - peekHeight),
      half: Math.max(0, height - window.innerHeight * DETENT_FRACTION.half),
      full: 0,
    };
  }

  private gripHeight(): number {
    return this.element.querySelector<HTMLElement>('.sheet-grip')?.offsetHeight ?? 0;
  }

  /**
   * @param notify false only during construction — the callback typically closes over the
   *   sheet itself, which does not exist yet at that point.
   */
  private applyDetent(detent: Detent, animate: boolean, notify = true): void {
    this.current = detent;

    this.element.classList.toggle('sheet-animating', animate);
    this.element.style.transform = `translateY(${this.offsets()[detent]}px)`;
    for (const candidate of DETENTS) {
      this.element.classList.toggle(`at-${candidate}`, candidate === detent);
    }
    // Only scrollable once there is somewhere to scroll: at peek, a scrollable body
    // swallows the drag that is trying to open the sheet.
    this.body.style.overflowY = detent === 'peek' ? 'hidden' : 'auto';

    if (notify) this.onLayout?.(detent);
  }

  /**
   * Whether a press here should drag the sheet.
   *
   * Not on a control — the peek row is full of them, and a search field that pans the
   * sheet instead of taking focus is worse than no drag at all. Not inside a body that is
   * scrolled, either: there, the scroll is what the finger is asking for.
   */
  private canDragFrom(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target.closest('input, button, a, select, textarea, label')) return false;
    if (this.body.contains(target) && this.body.scrollTop > 0) return false;
    return true;
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!this.canDragFrom(event.target)) return;

    this.dragging = true;
    this.passedSlop = false;
    this.pointerId = event.pointerId;
    this.startY = this.lastY = event.clientY;
    this.startOffset = this.offsets()[this.current];
    this.lastTime = event.timeStamp;
    this.velocity = 0;
    this.element.classList.remove('sheet-animating');
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragging || event.pointerId !== this.pointerId) return;

    const delta = event.clientY - this.startY;
    if (!this.passedSlop) {
      if (Math.abs(delta) < DRAG_SLOP_PX) return;
      this.passedSlop = true;
      // Claimed only once this is definitely a drag, so a tap on the sheet still reaches
      // whatever it landed on.
      this.element.setPointerCapture(event.pointerId);
    }

    const elapsed = Math.max(1, event.timeStamp - this.lastTime);
    this.velocity = (event.clientY - this.lastY) / elapsed;
    this.lastY = event.clientY;
    this.lastTime = event.timeStamp;

    const offsets = this.offsets();
    const clamped = Math.min(offsets.peek, Math.max(offsets.full, this.startOffset + delta));
    this.element.style.transform = `translateY(${clamped}px)`;
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.pointerId = null;

    if (this.element.hasPointerCapture?.(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }

    if (!this.passedSlop) {
      // Never moved: leave it where it is rather than re-snapping, which would animate
      // the sheet in response to a tap.
      this.applyDetent(this.current, false);
      return;
    }

    const offsets = this.offsets();
    const offset = Math.min(
      offsets.peek,
      Math.max(offsets.full, this.startOffset + (event.clientY - this.startY)),
    );
    this.applyDetent(snapDetent(offset, this.velocity, offsets), true);
  }
}
