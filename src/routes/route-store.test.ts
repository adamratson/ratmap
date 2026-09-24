import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from '../test-support/memory-db';
import type { LngLat } from './geo';

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof memoryDb> | null }));

vi.mock('../app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/db')>()),
  tx: (...args: Parameters<ReturnType<typeof memoryDb>['tx']>) => db.current!.tx(...args),
}));

const { deleteRoute, listRoutes, saveRoute } = await import('./route-store');

const COORDS: LngLat[] = [
  [-5.1, 56.8],
  [-5.0, 56.79],
];

function route(name: string) {
  return {
    name,
    coords: COORDS,
    distanceM: 6500,
    ascentM: 1300,
    descentM: 20,
    hasStraightLegs: false,
  };
}

beforeEach(() => {
  db.current = memoryDb();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('saved routes', () => {
  it('stores the whole geometry, so it renders with nothing recomputed (C10)', async () => {
    const saved = await saveRoute(route('Ben Nevis'));

    const [listed] = await listRoutes();
    expect(listed.coords).toEqual(COORDS);
    expect(listed).toEqual(saved);
  });

  it('refuses a route with no geometry rather than saving something that cannot render', async () => {
    await expect(saveRoute({ ...route('Empty'), coords: [] })).rejects.toThrow(/no geometry/);
    expect(await listRoutes()).toEqual([]);
  });

  it('updates in place on a re-save, keeping when it was first made', async () => {
    const first = await saveRoute(route('Ben Nevis'));
    vi.setSystemTime(5_000);

    const again = await saveRoute({ ...first, name: 'Ben Nevis via CMD' });

    expect(again.id).toBe(first.id);
    expect(again.createdAt).toBe(1_000);
    expect(again.updatedAt).toBe(5_000);
    expect(await listRoutes()).toHaveLength(1);
  });

  it('lists the most recently changed first', async () => {
    await saveRoute(route('Older'));
    vi.setSystemTime(2_000);
    await saveRoute(route('Newer'));

    expect((await listRoutes()).map((r) => r.name)).toEqual(['Newer', 'Older']);
  });

  it('keeps an unknown ascent as null, never as 0', async () => {
    const saved = await saveRoute({ ...route('No terrain'), ascentM: null, descentM: null });
    expect(saved.ascentM).toBeNull();
  });

  it('deletes by id', async () => {
    const drop = await saveRoute(route('Drop'));
    await deleteRoute(drop.id);
    expect(await listRoutes()).toEqual([]);
  });
});
