import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { toGpx } from './gpx';
import type { LoadableRoute, RoutePlanner } from './route-planner';
import type { SavedRoute } from './route-store';

// The saved-routes list (renderRoutesSheet), with the IndexedDB-backed store stood in for.
// routes-ui.test.ts covers the planning panel; this covers the list's deletes and undo.

const store = vi.hoisted(() => ({
  routes: [] as SavedRoute[],
  listRoutes: vi.fn(),
  deleteRoute: vi.fn(),
  saveRoute: vi.fn(),
}));
vi.mock('./route-store', () => ({
  listRoutes: store.listRoutes,
  deleteRoute: store.deleteRoute,
  saveRoute: store.saveRoute,
}));

const { renderRoutesSheet } = await import('./routes-ui');

const ROUTE: SavedRoute = {
  id: 'r1',
  name: 'Ben Nevis',
  coords: [
    [-5.09, 56.81],
    [-5.0, 56.8],
  ],
  distanceM: 8200,
  ascentM: 1300,
  descentM: 20,
  hasStraightLegs: false,
  createdAt: 1,
  updatedAt: 1,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLElement;
let onStatus: ReturnType<typeof vi.fn<(message: string, kind: 'ok' | 'warn' | 'error') => void>>;
let onUndoableStatus: ReturnType<typeof vi.fn<(message: string, action: { label: string; onSelect(): void }) => void>>;

async function render(): Promise<void> {
  await renderRoutesSheet({
    planner: {} as RoutePlanner,
    container,
    onPlanStarted: vi.fn(),
    onPlanFinished: vi.fn(),
    onStatus,
    onUndoableStatus,
  });
}

const deleteButton = () => container.querySelector<HTMLButtonElement>('.place-delete')!;

beforeEach(() => {
  store.routes = [ROUTE];
  store.listRoutes.mockImplementation(async () => [...store.routes]);
  store.deleteRoute.mockImplementation(async (id: string) => {
    store.routes = store.routes.filter((r) => r.id !== id);
  });
  store.saveRoute.mockImplementation(async (route: SavedRoute) => {
    store.routes = [...store.routes, route];
    return route;
  });
  container = document.createElement('div');
  onStatus = vi.fn();
  onUndoableStatus = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the saved routes list', () => {
  it('shows the Naismith time beside the climb', async () => {
    await render();
    expect(container.querySelector('.route-meta')?.textContent).toBe('8.20 km · ↑ 1300 m · ~3 hr 50 min');
  });

  it('gives no time for a route saved without a climb figure', async () => {
    store.routes = [{ ...ROUTE, ascentM: null, descentM: null }];
    await render();
    expect(container.querySelector('.route-meta')?.textContent).toBe('8.20 km');
  });

  it('deletes at once, with an Undo that brings the same route back', async () => {
    await render();
    deleteButton().click();
    await flush();

    const [message, action] = onUndoableStatus.mock.calls[0];
    expect(message).toBe('Deleted “Ben Nevis”');

    action.onSelect();
    await flush();
    expect(store.saveRoute).toHaveBeenCalledWith(ROUTE);
  });

  it('says so when the delete fails', async () => {
    store.deleteRoute.mockRejectedValue(new Error('transaction aborted'));
    await render();
    deleteButton().click();
    await flush();

    expect(onStatus).toHaveBeenCalledWith('Could not delete “Ben Nevis”: transaction aborted', 'error');
  });

  it('says so when an Undo fails, rather than letting it look restored', async () => {
    await render();
    deleteButton().click();
    await flush();
    store.saveRoute.mockRejectedValue(new Error('quota exceeded'));

    onUndoableStatus.mock.calls[0][1].onSelect();
    await flush();

    expect(onStatus).toHaveBeenLastCalledWith('Could not restore “Ben Nevis”: quota exceeded', 'error');
  });

  it('reports a store that will not open', async () => {
    store.listRoutes.mockRejectedValue(new Error('IndexedDB unavailable'));
    await render();

    expect(onStatus).toHaveBeenCalledWith('Could not read saved routes: IndexedDB unavailable', 'error');
  });
});

describe('opening a route over the one being planned', () => {
  // Opening used to discard whatever was being planned, with no way back.
  let load: Mock<(route: LoadableRoute) => (() => boolean) | null>;

  async function renderWith(putBack: (() => boolean) | null): Promise<void> {
    load = vi.fn(() => putBack);
    await renderRoutesSheet({
      planner: { load, activate: vi.fn() } as unknown as RoutePlanner,
      container,
      onPlanStarted: vi.fn(),
      onPlanFinished: vi.fn(),
      onStatus,
      onUndoableStatus,
    });
  }

  async function importFile(text: string, name: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('.route-import input')!;
    Object.defineProperty(input, 'files', { value: [new File([text], name)], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await flush();
  }

  it('offers the replaced plan back when a saved route is opened', async () => {
    const putBack = vi.fn(() => true);
    await renderWith(putBack);

    container.querySelector<HTMLButtonElement>('.route-open')!.click();

    const [message, action] = onUndoableStatus.mock.calls[0];
    expect(message).toBe('Opened “Ben Nevis”');
    action.onSelect();
    expect(putBack).toHaveBeenCalled();
  });

  it('says nothing when there was no plan to replace', async () => {
    await renderWith(null);

    container.querySelector<HTMLButtonElement>('.route-open')!.click();

    expect(onUndoableStatus).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('says so when the Undo is declined, rather than looking as if it worked', async () => {
    await renderWith(() => false);

    container.querySelector<HTMLButtonElement>('.route-open')!.click();
    onUndoableStatus.mock.calls[0][1].onSelect();

    expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/^Can’t undo/), 'warn');
  });

  it('opens a file ratmap wrote as the legs it was planned as, with the replaced plan on Undo', async () => {
    const coords: Array<[number, number]> = [
      [-5.076, 56.8094],
      [-5.04, 56.803],
      [-5.0037, 56.7969],
    ];
    const gpx = toGpx({
      name: 'Round',
      coords,
      legs: [
        { coords: [coords[0], coords[1]], distanceM: 2400, kind: 'snapped', wayNames: [] },
        { coords: [coords[1], coords[2]], distanceM: 2600, kind: 'straight', wayNames: [] },
      ],
    });
    await renderWith(vi.fn(() => true));

    await importFile(gpx, 'round.gpx');

    const opened = load.mock.calls[0][0];
    expect(opened.legs?.map((leg) => leg?.kind)).toEqual(['snapped', 'straight']);
    expect(opened.waypoints).toHaveLength(3);
    expect(onUndoableStatus).toHaveBeenCalledWith('Opened “Round”', expect.anything());
  });

  it('says plainly when an import with nothing to replace opens', async () => {
    await renderWith(null);

    await importFile(
      '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' +
        '<trkpt lat="56.8" lon="-5.07" /><trkpt lat="56.79" lon="-5.0" /></trkseg></trk></gpx>',
      'walk.gpx',
    );

    expect(onStatus).toHaveBeenCalledWith('Opened “walk”', 'ok');
    expect(onUndoableStatus).not.toHaveBeenCalled();
  });
});
