import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from '../test-support/memory-db';
import type { DraftSnapshot } from './route-planner';

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof memoryDb> | null }));

vi.mock('../app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/db')>()),
  tx: (...args: Parameters<ReturnType<typeof memoryDb>['tx']>) => db.current!.tx(...args),
}));

const { DraftKeeper, readDraft, writeDraft } = await import('./draft-store');

const DRAFT: DraftSnapshot = {
  waypoints: [
    { id: 'a', lng: -5.09, lat: 56.81 },
    { id: 'b', lng: -5.0, lat: 56.8, name: 'Ben Nevis' },
  ],
  legs: [
    {
      coords: [
        [-5.09, 56.81],
        [-5.0, 56.8],
      ],
      distanceM: 6000,
      kind: 'snapped',
      wayNames: [],
    },
  ],
  routeId: null,
  name: null,
  savedSignature: null,
  snapToPath: true,
  following: true,
  received: null,
};

beforeEach(() => {
  db.current = memoryDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the route kept across a reload', () => {
  it('comes back as it was written', async () => {
    await writeDraft(DRAFT);
    expect(await readDraft()).toEqual(DRAFT);
  });

  it('is forgotten when there is no route on screen', async () => {
    await writeDraft(DRAFT);
    await writeDraft(null);
    expect(await readDraft()).toBeNull();
  });

  it('is nothing at all before anything was written', async () => {
    expect(await readDraft()).toBeNull();
  });
});

describe('DraftKeeper', () => {
  it('writes a change at once, so a save followed straight away by a reload keeps it', async () => {
    const read = vi.fn(() => DRAFT);
    const keeper = new DraftKeeper(read, vi.fn());

    keeper.changed();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await readDraft()).toEqual(DRAFT));
  });

  it('folds changes made during a write into one more, of the latest state', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tx = db.current!.tx;
    tx.mockImplementationOnce(async (...args: Parameters<typeof tx>) => {
      await held;
      return memoryDb().tx(...args);
    });
    let latest = { ...DRAFT, name: 'first' };
    const read = vi.fn(() => latest);
    const keeper = new DraftKeeper(read, vi.fn());

    keeper.changed();
    latest = { ...DRAFT, name: 'second' };
    keeper.changed();
    latest = { ...DRAFT, name: 'third' };
    keeper.changed();
    expect(read).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await readDraft())?.name).toBe('third'));
  });

  it('says once, not on every edit, when it cannot write', async () => {
    db.current!.tx.mockRejectedValue(new Error('QuotaExceededError'));
    const onError = vi.fn();
    const keeper = new DraftKeeper(() => DRAFT, onError);

    keeper.changed();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    keeper.changed();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
