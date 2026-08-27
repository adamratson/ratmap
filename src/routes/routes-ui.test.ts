import { describe, expect, it, vi } from 'vitest';
import { renderRoutePanel } from './routes-ui';
import type { RoutePlanner, RouteSummary } from './route-planner';

function deps(container: HTMLElement) {
  return {
    planner: { } as unknown as RoutePlanner,
    container,
    onPlanStarted: vi.fn(),
    onPlanFinished: vi.fn(),
    onStatus: vi.fn(),
  };
}

const BASE: RouteSummary = {
  active: true,
  waypointCount: 2,
  distanceM: 8200,
  pendingLegs: 0,
  hasStraightLegs: false,
  canUndo: true,
  profile: null,
  profileNote: null,
  follow: null,
  following: false,
  currentDistanceM: null,
};

function render(summary: Partial<RouteSummary>): HTMLElement {
  const container = document.createElement('div');
  renderRoutePanel({ ...BASE, ...summary }, deps(container));
  return container;
}

describe('the planning panel', () => {
  it('leads with one action rather than five identical pills', () => {
    const panel = render({});
    const primary = panel.querySelectorAll('.route-actions button.primary');

    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toBe('Follow');
  });

  it('keeps Clear away from Done', () => {
    // They used to sit next to each other, styled identically — one finishes, one wipes
    // the route, and nothing distinguished them.
    const panel = render({});
    const inRow = [...panel.querySelectorAll('.route-actions button')].map((b) => b.textContent);

    expect(inRow).toContain('Done');
    expect(inRow).not.toContain('Clear route');
    expect(panel.querySelector('.route-destroy button')!.textContent).toBe('Clear route');
  });

  it('keeps the mode exit available even on an empty route', () => {
    // While planning, a tap on the map means "waypoint" rather than "open this summit".
    // There must always be a way back.
    const panel = render({ waypointCount: 0, canUndo: false });
    const done = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Done');

    expect(done).toBeDefined();
    expect(done!.disabled).toBe(false);
  });

  it('does not offer to clear a route that has nothing in it', () => {
    const panel = render({ waypointCount: 0 });
    expect(panel.querySelector<HTMLButtonElement>('.route-destroy button')!.disabled).toBe(true);
  });
});

describe('the follow screen', () => {
  const following = (offRouteM: number, isOffRoute: boolean) =>
    render({
      following: true,
      follow: { remainingM: 3400, fraction: 0.58, offRouteM, isOffRoute },
    } as Partial<RouteSummary>);

  it('says on or off route in words, not only in colour', () => {
    // Gloves, glare and colour-blindness each defeat colour on its own, and this is the
    // one thing on the screen that changes what you do next.
    expect(following(180, true).querySelector('.follow-state')!.textContent).toMatch(/off route/i);
    expect(following(4, false).querySelector('.follow-state')!.textContent).toMatch(/on route/i);
  });

  it('shows two figures, not a panel full of them', () => {
    const panel = following(4, false);
    expect(panel.querySelectorAll('.follow-figure')).toHaveLength(2);
  });

  it('points back to the route only when there is somewhere to point', () => {
    expect(following(180, true).textContent).toMatch(/dashed red line/i);
    expect(following(4, false).textContent).not.toMatch(/dashed red line/i);
  });

  it('states the background limitation, and that the screen is kept awake', () => {
    // §7 says to state this in the product, not only in the plan.
    const text = following(4, false).textContent ?? '';
    expect(text).toMatch(/background/i);
    expect(text).toMatch(/screen awake/i);
  });

  it('waits visibly rather than showing zeroes before the first fix', () => {
    const panel = render({ following: true, follow: null });
    expect(panel.querySelector('.follow-waiting')).not.toBeNull();
    expect(panel.querySelectorAll('.follow-figure')).toHaveLength(0);
  });

  it('offers one control, and it is the way out', () => {
    const panel = following(4, false);
    const buttons = [...panel.querySelectorAll('.route-actions button')];

    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Stop following');
  });
});
