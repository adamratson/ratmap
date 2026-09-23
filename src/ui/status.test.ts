import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONABLE_TOAST_MS, StatusCentre, TOAST_MS } from './status';

describe('StatusCentre', () => {
  let toasts: HTMLElement;
  let conditions: HTMLElement;
  let status: StatusCentre;

  beforeEach(() => {
    vi.useFakeTimers();
    toasts = document.createElement('div');
    conditions = document.createElement('div');
    document.body.append(toasts, conditions);
    status = new StatusCentre({ toasts, conditions });
  });

  afterEach(() => {
    toasts.remove();
    conditions.remove();
    vi.useRealTimers();
  });

  describe('toasts', () => {
    it('clears itself without the user having to tidy up', () => {
      status.toast('Saved “Ben Nevis”');
      expect(toasts.textContent).toContain('Ben Nevis');

      vi.advanceTimersByTime(TOAST_MS.ok);
      expect(toasts.children).toHaveLength(0);
    });

    it('keeps an error up longer than a confirmation', () => {
      status.toast('Could not save', { kind: 'error' });
      vi.advanceTimersByTime(TOAST_MS.ok);
      expect(toasts.children).toHaveLength(1);

      vi.advanceTimersByTime(TOAST_MS.error - TOAST_MS.ok);
      expect(toasts.children).toHaveLength(0);
    });

    it('gives an undo long enough to be reached for', () => {
      status.toast('Deleted', { action: { label: 'Undo', onSelect: () => {} } });

      vi.advanceTimersByTime(TOAST_MS.ok);
      expect(toasts.children).toHaveLength(1);

      vi.advanceTimersByTime(ACTIONABLE_TOAST_MS - TOAST_MS.ok);
      expect(toasts.children).toHaveLength(0);
    });

    it('runs the action and dismisses on the first tap, not the second', () => {
      const onSelect = vi.fn();
      status.toast('Deleted', { action: { label: 'Undo', onSelect } });

      toasts.querySelector<HTMLButtonElement>('.toast-action')!.click();

      expect(onSelect).toHaveBeenCalledOnce();
      expect(toasts.children).toHaveLength(0);
    });

    it('drops the oldest rather than filling the screen', () => {
      for (const n of [1, 2, 3, 4, 5]) status.toast(`Message ${n}`);

      expect(toasts.children).toHaveLength(3);
      expect(toasts.textContent).toContain('Message 5');
      expect(toasts.textContent).not.toContain('Message 1');
    });

    it('announces itself to a screen reader', () => {
      expect(toasts.getAttribute('aria-live')).toBe('polite');
    });
  });

  describe('conditions', () => {
    it('replaces rather than stacks when the same condition recurs', () => {
      // MapLibre raises one error per failed tile; an offline map produced dozens.
      for (let i = 0; i < 20; i++) {
        status.setCondition('offline', { message: 'No connection', kind: 'warn' });
      }

      expect(conditions.querySelectorAll('.condition')).toHaveLength(1);
    });

    it('disappears when the condition stops being true', () => {
      status.setCondition('offline', { message: 'No connection' });
      expect(conditions.hidden).toBe(false);

      status.setCondition('offline', null);
      expect(conditions.hidden).toBe(true);
    });

    it('shows the most severe first and collapses the rest', () => {
      status.setCondition('storage', { message: 'Storage not persistent', kind: 'warn' });
      status.setCondition('tiles', { message: 'Map failed to load', kind: 'error' });

      expect(conditions.querySelectorAll('.condition')).toHaveLength(1);
      expect(conditions.querySelector('.condition')!.textContent).toContain('Map failed');
      expect(conditions.querySelector('.condition-toggle')!.textContent).toBe('+1 more');
    });

    it('expands to show the ones it collapsed', () => {
      status.setCondition('storage', { message: 'Storage not persistent', kind: 'warn' });
      status.setCondition('tiles', { message: 'Map failed to load', kind: 'error' });

      conditions.querySelector<HTMLButtonElement>('.condition-toggle')!.click();

      expect(conditions.querySelectorAll('.condition')).toHaveLength(2);
      expect(conditions.textContent).toContain('Storage not persistent');
    });

    it('does not auto-dismiss — the condition is still true', () => {
      status.setCondition('offline', { message: 'No connection' });
      vi.advanceTimersByTime(60_000);

      expect(conditions.querySelectorAll('.condition')).toHaveLength(1);
    });

    it('offers an action without dismissing itself when it is taken', () => {
      const onSelect = vi.fn();
      status.setCondition('update', {
        message: 'New version ready',
        action: { label: 'Reload', onSelect },
      });

      conditions.querySelector<HTMLButtonElement>('.condition-action')!.click();

      expect(onSelect).toHaveBeenCalledOnce();
      expect(conditions.querySelectorAll('.condition')).toHaveLength(1);
    });
  });
});

describe('StatusCentre condition ordering', () => {
  let toasts: HTMLElement;
  let conditions: HTMLElement;
  let status: StatusCentre;

  beforeEach(() => {
    toasts = document.createElement('div');
    conditions = document.createElement('div');
    status = new StatusCentre({ toasts, conditions });
  });

  it('shows the one that changed most recently, among equals', () => {
    status.setCondition('storage', { message: 'Downloads are off', kind: 'warn' });
    status.setCondition('offline', { message: 'No connection', kind: 'warn' });

    expect(conditions.querySelector('.condition')!.textContent).toContain('No connection');
  });

  it('does not churn when the same condition is re-reported', () => {
    status.setCondition('offline', { message: 'No connection', kind: 'warn' });
    status.setCondition('storage', { message: 'Downloads are off', kind: 'warn' });
    for (let i = 0; i < 12; i++) {
      status.setCondition('offline', { message: 'No connection', kind: 'warn' });
    }

    // Storage still on top: nothing about the offline condition actually changed.
    expect(conditions.querySelector('.condition')!.textContent).toContain('Downloads are off');
  });

  it('lets severity beat recency', () => {
    status.setCondition('tiles', { message: 'Map failed to load', kind: 'error' });
    status.setCondition('offline', { message: 'No connection', kind: 'warn' });

    expect(conditions.querySelector('.condition')!.textContent).toContain('Map failed');
  });
});
