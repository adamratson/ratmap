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
  sac: null,
  sacNote: null,
};

function render(summary: Partial<RouteSummary>): HTMLElement {
  const container = document.createElement('div');
  renderRoutePanel({ ...BASE, ...summary }, deps(container));
  return container;
}

/** For the Clear-route tests, which need to inspect what the button actually triggers —
 *  `render()`'s deps are write-only from the test's point of view. */
function renderClearable(summary: Partial<RouteSummary>) {
  const container = document.createElement('div');
  const planner = { clear: vi.fn(), undo: vi.fn() } as unknown as RoutePlanner;
  const onUndoableStatus = vi.fn();
  renderRoutePanel(
    { ...BASE, ...summary },
    {
      planner,
      container,
      onPlanStarted: vi.fn(),
      onPlanFinished: vi.fn(),
      onStatus: vi.fn(),
      onUndoableStatus,
    },
  );
  const button = container.querySelector<HTMLButtonElement>('.route-actions button.destructive')!;
  return { button, planner, onUndoableStatus };
}

describe('the planning panel', () => {
  it('leads with one action rather than five identical pills', () => {
    const panel = render({});
    const primary = panel.querySelectorAll('.route-actions button.primary');

    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toBe('Follow');
  });

  it('marks Clear as destructive rather than styling it like Done', () => {
    // They used to be identical grey pills sitting side by side — one finishes, one
    // wipes the route, and nothing distinguished them. Sharing a row again (finding a
    // dedicated row cost real vertical space for one short link), but the styling still
    // has to keep them apart.
    const panel = render({});
    const inRow = [...panel.querySelectorAll('.route-actions button')].map((b) => b.textContent);

    expect(inRow).toEqual(['Undo', 'Save', 'Follow', 'Done', 'Clear']);
    const clear = panel.querySelector('.route-actions button.destructive')!;
    expect(clear.textContent).toBe('Clear');
    expect(clear.classList.contains('primary')).toBe(false);
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
    expect(panel.querySelector<HTMLButtonElement>('.route-actions button.destructive')!.disabled).toBe(
      true,
    );
  });

  describe('clearing a route', () => {
    it('clears immediately, not behind a confirmation dialog', () => {
      const { button, planner } = renderClearable({ waypointCount: 8, distanceM: 4200 });
      button.click();

      expect(planner.clear).toHaveBeenCalledOnce();
    });

    it('names what was cleared, so the toast alone answers "did I lose the good one"', () => {
      const { button, onUndoableStatus } = renderClearable({ waypointCount: 8, distanceM: 4200 });
      button.click();

      const [message] = onUndoableStatus.mock.calls[0];
      expect(message).toBe('Cleared 8 waypoints · 4.20 km');
    });

    it('says "1 waypoint", not "1 waypoints"', () => {
      const { button, onUndoableStatus } = renderClearable({ waypointCount: 1, distanceM: 0 });
      button.click();

      const [message] = onUndoableStatus.mock.calls[0];
      expect(message).toBe('Cleared 1 waypoint');
    });

    it('omits the distance when there is none yet — a lone waypoint has no legs', () => {
      const { button, onUndoableStatus } = renderClearable({ waypointCount: 1, distanceM: 0 });
      button.click();

      const [message] = onUndoableStatus.mock.calls[0];
      expect(message).not.toContain('·');
    });

    it('wires the toast\'s Undo to the same recovery the panel\'s own Undo button uses', () => {
      // RouteDraft.clear() snapshots before wiping, so planner.undo() is a full recovery,
      // not a reconstruction — the toast exists to make that already-correct mechanism
      // discoverable, not to build a new one.
      const { button, planner, onUndoableStatus } = renderClearable({
        waypointCount: 3,
        distanceM: 1000,
      });
      button.click();

      const [, action] = onUndoableStatus.mock.calls[0];
      expect(action.label).toBe('Undo');
      action.onSelect();

      expect(planner.undo).toHaveBeenCalledOnce();
    });
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

describe('SAC grades in the panel', () => {
  const graded = (over: Partial<import('./sac-sampler').SacSummary> = {}) => ({
    hardest: 3,
    metresByGrade: new Map([
      [1, 1400],
      [3, 600],
    ]),
    gradedM: 2000,
    totalM: 8200,
    coverage: 2000 / 8200,
    ...over,
  });

  it('shows the hardest graded section, labelled as graded', () => {
    const panel = render({ sac: graded() });

    const labels = [...panel.querySelectorAll('.route-stat dt')].map((n) => n.textContent);
    expect(labels).toContain('Hardest graded');
    expect(panel.textContent).toContain('T3');
  });

  it('breaks the distance down by grade', () => {
    const panel = render({ sac: graded() });

    const chips = [...panel.querySelectorAll('.sac-chip')].map((n) => n.textContent);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toContain('T1');
    expect(chips[1]).toContain('T3');
  });

  it('says how much of the route is graded at all', () => {
    const panel = render({ sac: graded() });

    // The whole point: "T3" on a route where three quarters of the ground carries no
    // grade must not read as "this route is T3".
    expect(panel.textContent).toContain('24%');
  });

  it('does not claim partial coverage when the whole route is graded', () => {
    const panel = render({
      sac: graded({ gradedM: 8200, coverage: 1, metresByGrade: new Map([[2, 8200]]), hardest: 2 }),
    });

    expect(panel.textContent).toContain('Every part of this route carries a grade');
    expect(panel.textContent).not.toContain('%');
  });

  it('distinguishes an ungraded route from an easy one', () => {
    const panel = render({
      sac: graded({ hardest: null, metresByGrade: new Map(), gradedM: 0, coverage: 0 }),
    });

    expect(panel.querySelectorAll('.sac-chip')).toHaveLength(0);
    expect(panel.textContent).toContain('No SAC grades');
    // Never a grade for a route we know nothing about.
    expect(panel.textContent).not.toContain('T1');
  });

  it('says nothing at all when no grade archive covers the route', () => {
    const panel = render({ sac: null });

    expect(panel.querySelector('.route-sac')).toBeNull();
    expect([...panel.querySelectorAll('.route-stat dt')].map((n) => n.textContent)).not.toContain(
      'Hardest graded',
    );
  });
});
