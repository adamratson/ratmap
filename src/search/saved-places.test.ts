import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from '../test-support/memory-db';

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof memoryDb> | null }));

vi.mock('../app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/db')>()),
  tx: (...args: Parameters<ReturnType<typeof memoryDb>['tx']>) => db.current!.tx(...args),
}));

const { deletePlace, listPlaces, savePlace } = await import('./saved-places');

beforeEach(() => {
  db.current = memoryDb();
});

describe('saved places', () => {
  it('gives a new place an id and a time', async () => {
    const saved = await savePlace({ name: 'Ben Nevis', lng: -5.0036, lat: 56.7969, ele: 1345 });

    expect(saved.id).toBeTruthy();
    expect(saved.savedAt).toBeTypeOf('number');
    expect(await listPlaces()).toEqual([saved]);
  });

  it('keeps an explicit id and time, so undoing a delete restores the same record', async () => {
    const original = await savePlace({ name: 'Ben Nevis', lng: -5, lat: 56.8 });
    await deletePlace(original.id);

    await savePlace(original);

    expect(await listPlaces()).toEqual([original]);
  });

  it('stores no elevation at all, rather than undefined, for a place that has none', async () => {
    const saved = await savePlace({ name: '56.80000, -5.00000', lng: -5, lat: 56.8 });

    expect(saved).not.toHaveProperty('ele');
  });

  it('lists the most recently saved first', async () => {
    await savePlace({ name: 'Older', lng: 0, lat: 0, savedAt: 1 });
    await savePlace({ name: 'Newer', lng: 0, lat: 0, savedAt: 2 });

    expect((await listPlaces()).map((place) => place.name)).toEqual(['Newer', 'Older']);
  });

  it('deletes by id', async () => {
    const keep = await savePlace({ name: 'Keep', lng: 0, lat: 0 });
    const drop = await savePlace({ name: 'Drop', lng: 0, lat: 0 });

    await deletePlace(drop.id);

    expect(await listPlaces()).toEqual([keep]);
  });
});
