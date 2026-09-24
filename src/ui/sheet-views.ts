import type { BottomSheet, Detent } from './sheet';

// What the bottom sheet is showing, and the peek row's chips that switch it.

/** What the sheet body is currently showing. `null` is the resting state. */
export type View =
  | 'peak'
  | 'path'
  | 'coords'
  | 'places'
  | 'regions'
  | 'routes'
  | 'plan'
  | 'install'
  | 'settings'
  | 'legend'
  | 'layers';

/** What a screen reader should call the sheet's contents, per view. */
const VIEW_LABEL: Record<View, string> = {
  peak: 'Summit details',
  path: 'Path grade',
  coords: 'Coordinates',
  places: 'Saved places',
  regions: 'Offline regions',
  routes: 'Routes',
  plan: 'Route planner',
  install: 'Add to Home Screen',
  settings: 'Settings',
  legend: 'Map legend',
  layers: 'Map layers',
};

/**
 * One of the peek row's destinations.
 *
 * These are what the four-button HUD used to be, moved off the map and into the one
 * surface — and now they also report which view is open, which the HUD could not do
 * because the planning panel covered it.
 */
export interface Destination {
  view: View;
  label: string;
  open: () => void;
}

export class SheetViews {
  private readonly sheet: BottomSheet;
  private readonly chipsHost: HTMLElement;
  /** Icon buttons outside the chip row that open a view, lit while it is open. */
  private readonly iconButtons: Partial<Record<View, HTMLElement>>;
  private destinations: Destination[] = [];
  private current: View | null = null;

  /**
   * Whether the `plan` view is planning or following.
   *
   * They are different modes with different rules — one takes map taps as waypoints, the
   * other does not — so the peek row has to name which one is on, or the mode is invisible
   * whenever the sheet is at rest.
   */
  private planMode: 'Planning' | 'Following' = 'Planning';

  constructor(options: {
    sheet: BottomSheet;
    chipsHost: HTMLElement;
    iconButtons: Partial<Record<View, HTMLElement>>;
  }) {
    this.sheet = options.sheet;
    this.chipsHost = options.chipsHost;
    this.iconButtons = options.iconButtons;
    this.chipsHost.addEventListener('scroll', () => this.updateOverflowCue(), { passive: true });
    this.chipsHost.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement) this.revealChip(event.target);
    });
  }

  view(): View | null {
    return this.current;
  }

  setDestinations(destinations: Destination[]): void {
    this.destinations = destinations;
    this.renderChips();
  }

  setPlanMode(mode: 'Planning' | 'Following'): void {
    this.planMode = mode;
  }

  /**
   * Show something in the sheet.
   *
   * The detent is only set when the view *changes*. A view that re-renders — the planner
   * does so on every waypoint drag — must not haul the sheet back up over a map the user
   * has just dragged it off.
   *
   * `focus` moves keyboard focus into the sheet, which announces it by its label. For
   * views opened from outside the peek row — a search result, a banner's button — where
   * focus would otherwise stay on a control that has nothing more to do with what just
   * opened, and a screen reader would say nothing had. Chips don't use it: they toggle
   * their view, so focus belongs on the chip.
   */
  open(
    name: View,
    render: (body: HTMLElement) => void,
    { detent = 'content', focus = false }: { detent?: Detent; focus?: boolean } = {},
  ): void {
    const entering = this.current !== name;
    this.current = name;
    this.sheet.body.setAttribute('aria-label', VIEW_LABEL[name]);
    render(this.sheet.body);
    if (entering) {
      this.sheet.scrollToTop();
      this.sheet.open(detent);
    }
    this.renderChips();
    if (focus) this.sheet.body.focus({ preventScroll: true });
  }

  close(): void {
    if (this.current === null) return;
    this.current = null;
    this.sheet.body.removeAttribute('aria-label');
    this.sheet.body.innerHTML = '';
    this.sheet.collapse();
    this.renderChips();
  }

  /** Same rule as every destination chip: tapping the one that's already open closes it. */
  toggle(name: View, open: () => void): void {
    if (this.current === name && this.sheet.detent() !== 'peek') this.close();
    else open();
  }

  /**
   * A summit or path sheet is a detail card, not a destination: it should not swallow half
   * the map you tapped it on. The coordinates sheet gets the same courtesy.
   */
  closeDetailCard(): void {
    if (this.current === 'peak' || this.current === 'path' || this.current === 'coords') {
      this.close();
    }
  }

  renderChips(): void {
    // Rebuilt rather than patched, so the chip holding keyboard focus is about to be
    // destroyed — and focus with it, to <body>, back at the top of the page. That happened
    // on every chip press (opening a view re-renders the row) and on every sheet layout
    // change. Remember which chip it was and hand focus to its replacement.
    const focused = this.chipsHost.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.chip
      : undefined;

    this.chipsHost.innerHTML = '';

    // Planning is a mode, not a destination: it is entered from the routes list and left
    // with Done, so its chip only exists while it is on. Without it the mode is invisible
    // at peek, and a tap on the map silently means something different.
    if (this.current === 'plan') {
      const chip = chipEl('plan', this.planMode, true, () =>
        this.sheet.detent() === 'peek' ? this.sheet.open('content') : this.sheet.collapse(),
      );
      chip.classList.add('chip-mode');
      this.chipsHost.append(chip);
    }

    for (const entry of this.destinations) {
      const active = this.current === entry.view;
      this.chipsHost.append(
        chipEl(entry.view, entry.label, active, () => {
          // Tapping the open one puts the map back, so every chip is its own way out.
          if (active && this.sheet.detent() !== 'peek') this.close();
          else entry.open();
        }),
      );
    }

    for (const [name, button] of Object.entries(this.iconButtons)) {
      button.classList.toggle('active', this.current === name);
    }

    if (focused) {
      this.chipsHost
        .querySelector<HTMLElement>(`[data-chip="${focused}"]`)
        ?.focus({ preventScroll: true });
    }

    this.updateOverflowCue();
  }

  /**
   * Scroll a chip that has keyboard focus wholly into view, clear of the edge fade.
   *
   * Measured, not left to the browser: on a phone-width row Chromium left a focused chip
   * half past the edge, under the fade — "LAYE…", ring and all — rather than scrolling
   * to it. At the far end the browser clamps the scroll, and the fade goes with it.
   */
  private revealChip(chip: HTMLElement): void {
    const host = this.chipsHost;
    const row = host.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    if (box.right > row.right - CHIP_FADE_PX) {
      host.scrollLeft += box.right - (row.right - CHIP_FADE_PX);
    } else if (box.left < row.left + CHIP_RING_PX) {
      host.scrollLeft -= row.left + CHIP_RING_PX - box.left;
    }
    this.updateOverflowCue();
  }

  /**
   * Fade the chip row's right edge while a chip is past it. The row scrolls with its
   * scrollbar hidden, so otherwise nothing says there is more — see `#chips.overflowing`.
   * Runs on every render, which the sheet also triggers on resize, and on scroll.
   */
  private updateOverflowCue(): void {
    const host = this.chipsHost;
    const hidden = host.scrollWidth - host.clientWidth - host.scrollLeft;
    host.classList.toggle('overflowing', hidden > 1);
  }
}

/** Width of `#chips.overflowing`'s edge fade (2rem), in px. */
const CHIP_FADE_PX = 32;
/** Room the focus ring needs around a chip: 2px outline + 2px offset. */
const CHIP_RING_PX = 4;

function chipEl(view: View, label: string, active: boolean, onSelect: () => void): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  // Which chip this is, across re-renders — see renderChips's focus handling.
  chip.dataset.chip = view;
  // A disclosure, not a tab. Tabs imply a panel that is always showing one of a set;
  // here the sheet is usually showing nothing at all, and each chip both opens and
  // closes its own view.
  chip.setAttribute('aria-expanded', String(active));
  chip.setAttribute('aria-controls', 'sheet-body');
  chip.classList.toggle('active', active);
  chip.textContent = label;
  chip.addEventListener('click', onSelect);
  return chip;
}
