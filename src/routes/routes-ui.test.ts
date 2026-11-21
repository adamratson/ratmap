import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRouteLink, renderRoutePanel, renderRoutesSheet } from './routes-ui';
import { encodeRouteLink, LinkDamaged } from './share-link';
import { summariseAvalancheTerrain } from './avalanche-sampler';
import { pathLengthMetres } from './geo';
import type { LngLat } from './geo';

const avalancheLayerOn = vi.hoisted(() => ({ value: false }));
vi.mock('../map/layers', () => ({ isLayerVisible: () => avalancheLayerOn.value }));

const installed = vi.hoisted(() => ({ value: false }));
vi.mock('../app/storage', () => ({ isStandalone: () => installed.value }));
vi.mock('./route-store', () => ({
  deleteRoute: vi.fn(),
  listRoutes: vi.fn(async () => []),
  saveRoute: vi.fn(),
}));

// jsdom has no <dialog> behaviour. What matters here is what goes in it.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};
import type { RoutePlanner, RouteSummary } from './route-planner';

function deps(container: HTMLElement) {
  return {
    planner: { } as unknown as RoutePlanner,
    container,
    onPlanStarted: vi.fn(),
    onStatus: vi.fn(),
  };
}

const BASE: RouteSummary = {
  active: true,
  waypointCount: 2,
  distanceM: 8200,
  pendingLegs: 0,
  hasStraightLegs: false,
  hasFreehandLegs: false,
  hasUnroutedLegs: false,
  snapToPath: true,
  canCloseLoop: true,
  canUndo: true,
  profile: null,
  profileNote: null,
  follow: null,
  following: false,
  currentDistanceM: null,
  sac: null,
  sacNote: null,
  avalanche: null,
  avalancheNote: null,
  received: null,
  name: 'Ben Nevis',
  saved: false,
  unsaved: true,
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

  it('marks Clear as destructive rather than styling it like Close', () => {
    // They used to be identical grey pills sitting side by side — one finishes, one
    // wipes the route, and nothing distinguished them. Sharing a row again (finding a
    // dedicated row cost real vertical space for one short link), but the styling still
    // has to keep them apart.
    const panel = render({});
    const inRow = [...panel.querySelectorAll('.route-actions button')].map((b) => b.textContent);

    expect(inRow).toEqual(['Undo', 'Save', 'Share', 'Follow', 'Close', 'Clear']);
    const clear = panel.querySelector('.route-actions button.destructive')!;
    expect(clear.textContent).toBe('Clear');
    expect(clear.classList.contains('primary')).toBe(false);
  });

  it('keeps the way out available even on an empty route', () => {
    // While planning, a tap on the map means "waypoint" rather than "open this summit".
    // There must always be a way back.
    const panel = render({ waypointCount: 0, canUndo: false, unsaved: false });
    const close = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Close');

    expect(close).toBeDefined();
    expect(close!.disabled).toBe(false);
  });

  it('says whether the route is saved', () => {
    const status = (summary: Partial<RouteSummary>) =>
      render(summary).querySelector('.route-status')?.textContent;
    expect(status({ saved: false, unsaved: true })).toBe('Ben NevisNot saved');
    expect(status({ saved: true, unsaved: true })).toBe('Ben NevisUnsaved changes');
    expect(status({ saved: true, unsaved: false })).toBe('Ben NevisSaved');
    expect(status({ waypointCount: 0, unsaved: false })).toBeUndefined();
  });

  describe('closing the route', () => {
    afterEach(() => document.querySelectorAll('dialog').forEach((d) => d.remove()));

    function renderClosable(summary: Partial<RouteSummary>) {
      const container = document.createElement('div');
      const putBack = vi.fn(() => true);
      const planner = {
        close: vi.fn(() => putBack),
        getName: () => 'Ben Nevis',
      } as unknown as RoutePlanner;
      const onUndoableStatus = vi.fn();
      const onPlanStarted = vi.fn();
      renderRoutePanel(
        { ...BASE, ...summary },
        { planner, container, onPlanStarted, onStatus: vi.fn(), onUndoableStatus },
      );
      const close = [...container.querySelectorAll<HTMLButtonElement>('.route-actions button')].find(
        (b) => b.textContent === 'Close',
      )!;
      return { close, planner, putBack, onUndoableStatus, onPlanStarted };
    }

    const dialogButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) => b.textContent === label);

    it('takes a saved, unedited route off the map without asking', () => {
      const { close, planner, onUndoableStatus } = renderClosable({ saved: true, unsaved: false });
      close.click();
      expect(planner.close).toHaveBeenCalled();
      expect(document.querySelector('dialog')).toBeNull();
      expect(onUndoableStatus).not.toHaveBeenCalled();
    });

    it('asks before closing a route that was never saved', () => {
      const { close, planner } = renderClosable({ saved: false, unsaved: true });
      close.click();
      expect(planner.close).not.toHaveBeenCalled();
      expect(document.querySelector('dialog h2')?.textContent).toBe('Save “Ben Nevis”?');
      expect(dialogButton('Save')).toBeDefined();
      expect(dialogButton('Discard')).toBeDefined();
      expect(dialogButton('Keep editing')).toBeDefined();
    });

    it('asks about the changes to a saved route', () => {
      const { close } = renderClosable({ saved: true, unsaved: true });
      close.click();
      expect(document.querySelector('dialog h2')?.textContent).toBe('Save changes to “Ben Nevis”?');
      expect(dialogButton('Discard changes')).toBeDefined();
    });

    it('discards with an Undo that brings the route back', () => {
      const { close, planner, putBack, onUndoableStatus, onPlanStarted } = renderClosable({});
      close.click();
      dialogButton('Discard')!.click();

      expect(planner.close).toHaveBeenCalled();
      expect(onUndoableStatus).toHaveBeenCalledWith('Discarded “Ben Nevis”', expect.objectContaining({ label: 'Undo' }));
      onUndoableStatus.mock.calls[0][1].onSelect();
      expect(putBack).toHaveBeenCalled();
      expect(onPlanStarted).toHaveBeenCalled();
    });

    it('keeps editing when asked to', () => {
      const { close, planner } = renderClosable({});
      close.click();
      dialogButton('Keep editing')!.click();
      expect(planner.close).not.toHaveBeenCalled();
    });

    it('will not save a route with a leg still being worked out', () => {
      const { close } = renderClosable({ pendingLegs: 1 });
      close.click();
      expect(dialogButton('Save')!.disabled).toBe(true);
    });

    it('drops a lone waypoint without a question, but with an Undo', () => {
      const { close, planner, onUndoableStatus } = renderClosable({ waypointCount: 1 });
      close.click();
      expect(document.querySelector('dialog')).toBeNull();
      expect(planner.close).toHaveBeenCalled();
      expect(onUndoableStatus).toHaveBeenCalled();
    });
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

describe('round trip in the panel', () => {
  const roundTrip = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLButtonElement>('.route-tools button')].find(
      (b) => b.textContent === 'Round trip',
    )!;

  it('closes the route back to its start', () => {
    const container = document.createElement('div');
    const planner = { closeLoop: vi.fn() } as unknown as RoutePlanner;
    renderRoutePanel(BASE, { ...deps(container), planner });

    roundTrip(container).click();

    expect(planner.closeLoop).toHaveBeenCalled();
  });

  it('is off when there is nothing to close', () => {
    expect(roundTrip(render({ canCloseLoop: false })).disabled).toBe(true);
  });

  it('stays out of the action row, which only just fits a phone', () => {
    const inRow = [...render({}).querySelectorAll('.route-actions button')].map((b) => b.textContent);
    expect(inRow).not.toContain('Round trip');
  });
});

describe('snap to paths in the panel', () => {
  it('shows the switch as set, and flips the planner when touched', () => {
    const container = document.createElement('div');
    const planner = { setSnapToPath: vi.fn() } as unknown as RoutePlanner;
    renderRoutePanel(BASE, { ...deps(container), planner });

    const toggle = container.querySelector<HTMLInputElement>('.route-snap input[type=checkbox]')!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));

    expect(planner.setSnapToPath).toHaveBeenCalledWith(false);
  });

  it('shows the switch off while new legs are drawn straight, with no note under it', () => {
    const panel = render({ snapToPath: false });
    expect(panel.querySelector<HTMLInputElement>('.route-snap input')!.checked).toBe(false);
    expect(panel.querySelector('.route-snap .settings-row-note')).toBeNull();
  });

  const note = (panel: HTMLElement) => panel.querySelector('.route-note.warn')?.textContent ?? '';

  it('does not blame the map for a leg drawn freehand', () => {
    const panel = render({ hasStraightLegs: true, hasFreehandLegs: true });
    expect(note(panel)).toContain('drawn freehand');
    expect(note(panel)).not.toContain('no route was found');
  });

  it('still says when no route was found', () => {
    const panel = render({ hasStraightLegs: true, hasUnroutedLegs: true });
    expect(note(panel)).toContain('no route was found');
    expect(note(panel)).not.toContain('freehand');
  });

  it('names both causes when a route has both', () => {
    const panel = render({ hasStraightLegs: true, hasUnroutedLegs: true, hasFreehandLegs: true });
    expect(note(panel)).toContain('drawn freehand, or no route was found');
  });
});

describe('redrawing the panel under someone using it', () => {
  // The panel is redrawn on every GPS fix while a route is open, not only on edits. With
  // the location dot on, the save form — and whatever had been typed into it — was gone
  // within a second, so a route could not be saved at all.
  function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const panelDeps = {
      ...deps(container),
      planner: { getName: () => '8.20 km route' } as unknown as RoutePlanner,
    };
    const draw = (summary: Partial<RouteSummary> = {}) =>
      renderRoutePanel({ ...BASE, ...summary }, panelDeps);
    draw();
    return { container, draw };
  }

  const nameInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('.route-save-form input');

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps a half-typed name, where the cursor was, through a redraw', () => {
    const { container, draw } = mount();
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click();
    nameInput(container)!.value = 'Ben Nevis by the arête';
    nameInput(container)!.setSelectionRange(4, 4);

    draw({ currentDistanceM: 1200 }); // a GPS fix

    const input = nameInput(container);
    expect(input?.value).toBe('Ben Nevis by the arête');
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(4);
  });

  it('closes the form once the route no longer stands to be saved', () => {
    // An edit leaves a leg pending; saving then would store a route with a hole in it.
    const { container, draw } = mount();
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click();

    draw({ pendingLegs: 1 });

    expect(nameInput(container)).toBeNull();
  });

  it('keeps keyboard focus on the button it was on', () => {
    const { container, draw } = mount();
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'Undo')!
      .focus();

    draw({ currentDistanceM: 1200 });

    expect((document.activeElement as HTMLElement).textContent).toBe('Undo');
    expect(container.contains(document.activeElement)).toBe(true);
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

describe('Naismith time in the panel', () => {
  const profile = {
    points: [],
    ascentM: 1300,
    descentM: 20,
    minEle: 20,
    maxEle: 1345,
    coverage: 1,
  };
  const stats = (panel: HTMLElement) =>
    Object.fromEntries(
      [...panel.querySelectorAll('.route-stat')].map((n) => [
        n.querySelector('dt')!.textContent,
        n.querySelector('dd')!.textContent,
      ]),
    );

  it('estimates from distance and climb', () => {
    // 8.2 km / 5 km/h + 1300 m / 600 m/h = 3.8 hr.
    expect(stats(render({ profile }))['Naismith']).toBe('3 hr 50 min');
  });

  it('gives no time without a climb figure, rather than a flat-ground guess', () => {
    expect(stats(render({ profile: null }))).not.toHaveProperty('Naismith');
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

    expect(panel.textContent).toContain('Graded along the whole route');
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

describe('avalanche terrain in the panel', () => {
  const along = (n: number): LngLat[] =>
    Array.from({ length: n }, (_, i) => [-5.0, 56.8 + i * 0.001] as LngLat);
  const steep = summariseAvalancheTerrain(along(4), [
    { slope: 0, aspect: null },
    { slope: 33, aspect: 1 },
    { slope: 41, aspect: 1 },
    { slope: 0, aspect: null },
  ]);
  const gentle = summariseAvalancheTerrain(along(3), [
    { slope: 0, aspect: null },
    { slope: 0, aspect: null },
    { slope: 0, aspect: null },
  ]);

  afterEach(() => {
    avalancheLayerOn.value = false;
  });

  it('stays out of the panel while the layer is off', () => {
    const panel = render({ avalanche: steep });
    expect(panel.querySelector('.route-avalanche')).toBeNull();
  });

  it('breaks the route down by slope class, with the steepest slope and the caveat', () => {
    avalancheLayerOn.value = true;
    const block = render({ avalanche: steep }).querySelector('.route-avalanche')!;

    const grades = [...block.querySelectorAll('.sac-chip-grade')].map((chip) => chip.textContent);
    expect(grades).toEqual(['30–34°', '40–44°']);
    expect(block.textContent).toMatch(/Steepest slope crossed: 41°\./);
    expect(block.textContent).toMatch(/never seen the snow/);
  });

  it('says nothing reaches 25° — not that the route is safe — on gentle ground', () => {
    avalancheLayerOn.value = true;
    const block = render({ avalanche: gentle }).querySelector('.route-avalanche')!;
    expect(block.textContent).toMatch(/Nowhere on this route reaches 25°\./);
    expect(block.textContent).not.toMatch(/safe/i);
    expect(block.textContent).toMatch(/slide onto you from above/);
  });

  it('reports a read failure instead of an empty breakdown', () => {
    avalancheLayerOn.value = true;
    const panel = render({ avalancheNote: 'Could not read avalanche terrain: boom' });
    expect(panel.textContent).toMatch(/Could not read avalanche terrain: boom/);
  });
});

describe('a route that arrived as a link', () => {
  const line: LngLat[] = [
    [-5.09, 56.81],
    [-5.05, 56.8],
    [-5.0, 56.797],
  ];
  const planner = (name = 'Ben Nevis') =>
    ({
      getDraft: () => ({
        coordinates: () => line,
        getWaypoints: () => [],
        getLegs: () => [],
        hasStraightLegs: () => false,
      }),
      getProfile: () => null,
      getName: () => name,
    }) as unknown as RoutePlanner;

  function panel(summary: Partial<RouteSummary>, extra: Partial<Parameters<typeof renderRoutePanel>[1]> = {}) {
    const container = document.createElement('div');
    renderRoutePanel({ ...BASE, ...summary }, { ...deps(container), planner: planner(), ...extra });
    return container;
  }
  const received = { payload: 'abc', stats: { ascentM: 1340, descentM: 12 } };

  it('shows nothing extra for a route planned here', () => {
    expect(panel({}).querySelector('.route-received')).toBeNull();
  });

  it('labels the sender’s climb as theirs until there is a profile of its own', () => {
    expect(panel({ received }).querySelector('.route-received')!.textContent).toMatch(
      /Their figures: 1340 m up, 12 m down, measured on the sender’s map\./,
    );

    const measured = panel({
      received,
      profile: { points: [], ascentM: 1, descentM: 1, minEle: 0, maxEle: 1, coverage: 1 },
    });
    expect(measured.querySelector('.route-received')!.textContent).not.toMatch(/Their figures/);
  });

  it('offers the region that covers it, with its size', () => {
    const onGetRegion = vi.fn();
    const region = { id: 'scotland', name: 'Scotland', totalBytes: 1_412_000_000 } as never;
    const container = panel(
      { received },
      { regionOffer: () => ({ kind: 'region', region }), onGetRegion },
    );
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Get Scotland'),
    )!;
    expect(button.textContent).toBe('Get Scotland (1.4 GB)');
    button.click();
    expect(onGetRegion).toHaveBeenCalledWith('Scotland');
  });

  it('says when no one region holds the route', () => {
    const container = panel({ received }, { regionOffer: () => ({ kind: 'spans' }) });
    expect(container.textContent).toMatch(/crosses more than one region/);
  });

  it('offers no region when one is already here', () => {
    const container = panel({ received }, { regionOffer: () => null });
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      expect.stringMatching(/^Get /),
    );
  });

  it('turns itself into a file for someone who never installs ratmap', () => {
    const labels = [...panel({ received }).querySelectorAll('.route-received button')].map((b) => b.textContent);
    expect(labels).toContain('Save as GPX');
  });

  it('offers to copy the link in the browser, where the installed app can’t be reached', () => {
    const buttons = () =>
      [...panel({ received }).querySelectorAll('.route-received button')].map((b) => b.textContent);
    expect(buttons()).toContain('Copy link');

    installed.value = true;
    expect(buttons()).not.toContain('Copy link');
    installed.value = false;
  });
});

describe('sharing from the panel', () => {
  const line: LngLat[] = [
    [-5.09, 56.81],
    [-5.0, 56.797],
  ];
  const planner = {
    getDraft: () => ({
      coordinates: () => line,
      getWaypoints: () => [
        { id: 'a', lng: line[0][0], lat: line[0][1] },
        { id: 'b', lng: line[1][0], lat: line[1][1] },
      ],
      getLegs: () => [{ coords: line, distanceM: pathLengthMetres(line), kind: 'snapped', wayNames: [] }],
    }),
    getProfile: () => null,
    getName: () => 'Ben Nevis',
  } as unknown as RoutePlanner;

  function shareButton(summary: Partial<RouteSummary> = {}) {
    const container = document.createElement('div');
    renderRoutePanel({ ...BASE, ...summary }, { ...deps(container), planner });
    return [...container.querySelectorAll('button')].find((b) => b.textContent === 'Share')!;
  }

  afterEach(() => {
    document.querySelectorAll('dialog').forEach((dialog) => dialog.remove());
  });

  it('waits until the route is complete', () => {
    expect(shareButton({ pendingLegs: 1 }).disabled).toBe(true);
    expect(shareButton().disabled).toBe(false);
  });

  it('says a link can’t be taken back before anything is sent', () => {
    shareButton().click();
    expect(document.querySelector('dialog')!.textContent).toMatch(
      /Anyone with this link can see this route, and it can’t be taken back\./,
    );
  });

  it('offers a link and both file formats', () => {
    shareButton().click();
    const labels = [...document.querySelectorAll('dialog button')].map((b) => b.textContent);
    expect(labels).toEqual(['Send link', 'GPX', 'GeoJSON', 'Cancel']);
  });

  it('falls back to the clipboard where there is no share sheet', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, share: undefined, clipboard: { writeText } });
    shareButton().click();
    (document.querySelector('.share-actions button.primary') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]).toEqual([expect.stringContaining('#r=')]);
    vi.unstubAllGlobals();
  });
});

describe('opening a link', () => {
  const coords: LngLat[] = [
    [-5.09, 56.81],
    [-5.0, 56.797],
  ];
  const payload = encodeRouteLink({
    name: 'Ben Nevis',
    waypoints: coords.map(([lng, lat]) => ({ lng, lat })),
    legs: [{ coords, distanceM: pathLengthMetres(coords), kind: 'straight' }],
    stats: null,
  });

  function plannerStub() {
    return {
      load: vi.fn((): (() => boolean) | null => null),
      activate: vi.fn(),
      clear: vi.fn(),
    };
  }

  it('loads the route with its link attached, and saves nothing', () => {
    const planner = plannerStub();
    const opened = deps(document.createElement('div'));
    openRouteLink(payload, { ...opened, planner: planner as unknown as RoutePlanner });

    expect(planner.load).toHaveBeenCalledTimes(1);
    expect(planner.load.mock.calls[0]).toEqual([
      expect.objectContaining({ name: 'Ben Nevis', received: { payload, stats: null } }),
    ]);
    expect(opened.onPlanStarted).toHaveBeenCalled();
    expect(opened.onStatus).toHaveBeenCalledWith('Opened “Ben Nevis”', 'ok');
  });

  it('offers back the plan it replaced', () => {
    const planner = plannerStub();
    planner.load.mockReturnValue(() => true);
    const onUndoableStatus = vi.fn();
    openRouteLink(payload, {
      ...deps(document.createElement('div')),
      planner: planner as unknown as RoutePlanner,
      onUndoableStatus,
    });
    expect(onUndoableStatus).toHaveBeenCalledWith(
      'Opened “Ben Nevis”',
      expect.objectContaining({ label: 'Undo' }),
    );
  });

  it('loads nothing from a damaged link', () => {
    const planner = plannerStub();
    expect(() =>
      openRouteLink(payload.slice(0, -3), {
        ...deps(document.createElement('div')),
        planner: planner as unknown as RoutePlanner,
      }),
    ).toThrow(LinkDamaged);
    expect(planner.load).not.toHaveBeenCalled();
  });
});

describe('pasting a route', () => {
  const coords: LngLat[] = [
    [-5.09, 56.81],
    [-5.0, 56.797],
  ];

  async function sheet() {
    const container = document.createElement('div');
    const planner = { load: vi.fn(() => null), activate: vi.fn(), clear: vi.fn() };
    const opened = { ...deps(container), planner: planner as unknown as RoutePlanner };
    await renderRoutesSheet(opened);
    const paste = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Paste a route')!;
    paste.click();
    return { container, planner, opened };
  }

  function submit(container: HTMLElement, text: string) {
    container.querySelector('textarea')!.value = text;
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  it('opens a pasted link', async () => {
    const { container, planner } = await sheet();
    const payload = encodeRouteLink({
      name: 'Pasted',
      waypoints: coords.map(([lng, lat]) => ({ lng, lat })),
      legs: [{ coords, distanceM: pathLengthMetres(coords), kind: 'straight' }],
      stats: null,
    });
    submit(container, `  https://elsewhere.example/ratmap/#r=${payload}\n`);
    expect(planner.load).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pasted' }));
  });

  it('opens pasted GPX text', async () => {
    const { container, planner } = await sheet();
    submit(
      container,
      `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Filed</name><trkseg>
        <trkpt lat="56.81" lon="-5.09"></trkpt><trkpt lat="56.797" lon="-5.0"></trkpt>
      </trkseg></trk></gpx>`,
    );
    expect(planner.load).toHaveBeenCalledWith(expect.objectContaining({ name: 'Filed' }));
  });

  it('says what is wrong with a damaged link, and opens nothing', async () => {
    const { container, planner, opened } = await sheet();
    submit(container, 'https://example.org/#r=AAAA');
    expect(planner.load).not.toHaveBeenCalled();
    expect(opened.onStatus).toHaveBeenCalledWith(expect.stringMatching(/damaged/), 'error');
  });

  it('ignores an empty field', async () => {
    const { container, planner, opened } = await sheet();
    submit(container, '   ');
    expect(planner.load).not.toHaveBeenCalled();
    expect(opened.onStatus).not.toHaveBeenCalled();
  });
});
