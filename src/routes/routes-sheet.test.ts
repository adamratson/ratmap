import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutePlanner } from './route-planner';
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
