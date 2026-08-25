// The app's two ways of saying something, deliberately separated.
//
// They used to be one component: `showStatus` prepended a card that stayed until it was
// individually dismissed, with no timeout anywhere. So "Saved “Ben Nevis”" was still
// covering the map ten minutes later, stacked under however many other cards had
// accumulated — and MapLibre emits one error per failed tile, so going offline needed a
// bespoke dedupe key to avoid burying the map entirely.
//
// The split is by lifetime, which is the thing that actually differs:
//
//   toast()        — something just happened. Auto-dismisses. Carries an undo where one
//                    exists, which is why it sits within thumb reach at the bottom.
//   setCondition() — something is *currently true*: no signal, storage not persistent, an
//                    update waiting. Keyed, so re-reporting replaces rather than stacks,
//                    and it disappears when the condition does rather than when the user
//                    tidies up after it.

export type StatusKind = 'ok' | 'warn' | 'error';

export interface StatusAction {
  label: string;
  onSelect(): void;
}

export interface ToastOptions {
  kind?: StatusKind;
  action?: StatusAction;
  /** Overrides the kind's default lifetime. */
  durationMs?: number;
}

export interface Condition {
  message: string;
  kind?: StatusKind;
  action?: StatusAction;
}

/**
 * How long a toast stays up, by severity.
 *
 * Graded because the cost of missing one is graded: a confirmation you miss cost you
 * nothing, an error you miss leaves you wondering why the app did not do the thing.
 */
export const TOAST_MS: Record<StatusKind, number> = { ok: 4000, warn: 6000, error: 8000 };

/**
 * Floor for a toast carrying an action.
 *
 * An "Undo" that expires while you are still reaching for it is worse than no undo at
 * all, because you have already stopped looking for another way back.
 */
export const ACTIONABLE_TOAST_MS = 7000;

/** Newest first; beyond this the oldest are dropped rather than filling the screen. */
const MAX_TOASTS = 3;

const SEVERITY: Record<StatusKind, number> = { ok: 0, warn: 1, error: 2 };

export interface StatusCentreElements {
  /** Transient messages. Bottom of the screen, above whatever else is down there. */
  toasts: HTMLElement;
  /** Ongoing conditions. One line, near the top, out of the way of the map. */
  conditions: HTMLElement;
}

export class StatusCentre {
  private readonly toastHost: HTMLElement;
  private readonly conditionHost: HTMLElement;
  private readonly conditions = new Map<string, Condition & { ordinal: number }>();
  private ordinal = 0;
  private expanded = false;

  constructor(elements: StatusCentreElements) {
    this.toastHost = elements.toasts;
    this.conditionHost = elements.conditions;
    // Announced, not just drawn. Screen-reader users previously got no signal at all that
    // a save succeeded or a download finished.
    this.toastHost.setAttribute('aria-live', 'polite');
    this.conditionHost.setAttribute('aria-live', 'polite');
  }

  /** Report something that just happened. */
  toast(message: string, options: ToastOptions = {}): void {
    const kind = options.kind ?? 'ok';
    const element = document.createElement('div');
    element.className = `toast ${kind}`;

    const text = document.createElement('p');
    // textContent throughout this file: messages interpolate OSM names and user-entered
    // route names, both of which are arbitrary text.
    text.textContent = message;
    element.append(text);

    let dismiss: () => void;

    if (options.action) {
      const { label, onSelect } = options.action;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = label;
      button.addEventListener('click', () => {
        dismiss();
        onSelect();
      });
      element.append(button);
    }

    const timer = setTimeout(
      () => element.remove(),
      options.durationMs ?? Math.max(TOAST_MS[kind], options.action ? ACTIONABLE_TOAST_MS : 0),
    );

    dismiss = () => {
      clearTimeout(timer);
      element.remove();
    };

    this.toastHost.prepend(element);
    while (this.toastHost.children.length > MAX_TOASTS) this.toastHost.lastElementChild?.remove();
  }

  /**
   * Declare, or withdraw, an ongoing condition.
   *
   * @param key identifies the condition, not the occurrence — calling this again with the
   *   same key replaces what is shown. Pass null when it stops being true.
   */
  setCondition(key: string, condition: Condition | null): void {
    if (!condition) {
      this.conditions.delete(key);
      this.renderConditions();
      return;
    }

    // The ordinal only moves when what the condition *says* changes. Re-reporting the
    // same thing — which the offline-tiles case does dozens of times a second — must not
    // make the strip churn.
    const existing = this.conditions.get(key);
    const unchanged = existing?.message === condition.message && existing?.kind === condition.kind;
    this.conditions.set(key, {
      ...condition,
      ordinal: unchanged ? existing.ordinal : ++this.ordinal,
    });
    this.renderConditions();
  }

  /**
   * Currently-true conditions, most severe first and most recent within that.
   *
   * Recency breaks the tie because two warnings at once is normal — no signal and no
   * persistent storage travel together — and the one that just changed is the one worth
   * a line of the map.
   */
  private ranked(): (Condition & { ordinal: number })[] {
    return [...this.conditions.values()].sort(
      (a, b) => SEVERITY[b.kind ?? 'warn'] - SEVERITY[a.kind ?? 'warn'] || b.ordinal - a.ordinal,
    );
  }

  private renderConditions(): void {
    const ranked = this.ranked();
    this.conditionHost.innerHTML = '';

    if (ranked.length === 0) {
      this.conditionHost.hidden = true;
      this.expanded = false;
      return;
    }

    this.conditionHost.hidden = false;
    // Only the worst one is shown by default. Several at once is normal — no signal and
    // no persistent storage travel together — and stacking them is how the old panel
    // buried the map.
    const shown = this.expanded ? ranked : ranked.slice(0, 1);
    for (const condition of shown) this.conditionHost.append(this.conditionRow(condition));

    const hidden = ranked.length - shown.length;
    if (hidden > 0 || this.expanded) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'condition-toggle';
      toggle.textContent = this.expanded ? 'Show less' : `+${hidden} more`;
      toggle.addEventListener('click', () => {
        this.expanded = !this.expanded;
        this.renderConditions();
      });
      this.conditionHost.append(toggle);
    }
  }

  private conditionRow(condition: Condition): HTMLElement {
    const row = document.createElement('div');
    row.className = `condition ${condition.kind ?? 'warn'}`;

    const text = document.createElement('p');
    text.textContent = condition.message;
    row.append(text);

    if (condition.action) {
      const { label, onSelect } = condition.action;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'condition-action';
      button.textContent = label;
      button.addEventListener('click', onSelect);
      row.append(button);
    }

    return row;
  }
}
