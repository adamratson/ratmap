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
  it('writes a burst of changes once', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => DRAFT);
    const keeper = new DraftKeeper(read, vi.fn(), 500);

    keeper.changed();
    keeper.changed();
    keeper.changed();
    expect(read).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readDraft()).toEqual(DRAFT);
  });

  it('writes at once when the page is hidden, before iOS can end it', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => DRAFT);
    const keeper = new DraftKeeper(read, vi.fn(), 500);
    keeper.changed();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('says once, not on every edit, when it cannot write', async () => {
    vi.useFakeTimers();
    db.current!.tx.mockRejectedValue(new Error('QuotaExceededError'));
    const onError = vi.fn();
    const keeper = new DraftKeeper(() => DRAFT, onError, 10);

    keeper.changed();
    await vi.advanceTimersByTimeAsync(10);
    keeper.changed();
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
