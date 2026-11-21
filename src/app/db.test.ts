import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no IndexedDB. What is worth testing here is ratmap's own logic around it —
// which stores an upgrade creates, that the connection is shared, that a failure is not —
// so a small fake that plays the request/event protocol is enough.

interface FakeRequest {
  result?: unknown;
  error?: Error | null;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
}

function fakeDatabase(existing: string[]) {
  const stores = new Set(existing);
  const created: Array<{ name: string; keyPath: unknown; indexes: string[] }> = [];
  return {
    created,
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string, options: { keyPath: unknown }) => {
      stores.add(name);
      const entry = { name, keyPath: options.keyPath, indexes: [] as string[] };
      created.push(entry);
      return { createIndex: (index: string) => entry.indexes.push(index) };
    },
    transaction: vi.fn(),
    close: vi.fn(),
    onversionchange: null as null | (() => void),
  };
}

type Outcome = { upgradeFrom?: string[]; fail?: boolean };

function stubIndexedDb(outcomes: Outcome[]) {
  const databases: ReturnType<typeof fakeDatabase>[] = [];
  const open = vi.fn((_name: string, _version: number) => {
    const outcome = outcomes.shift() ?? {};
    const request: FakeRequest = {};
    queueMicrotask(() => {
      if (outcome.fail) {
        request.error = new Error('blocked');
        request.onerror?.();
        return;
      }
      const db = fakeDatabase(outcome.upgradeFrom ?? []);
      databases.push(db);
      request.result = db;
      if (outcome.upgradeFrom) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  return { open, databases };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openDb', () => {
  it('creates every store, keyed by id, on a first install', async () => {
    const { databases } = stubIndexedDb([{ upgradeFrom: [] }]);
    const { openDb, PLACES_STORE, ROUTES_STORE, DRAFT_STORE } = await import('./db');

    await openDb();

    expect(databases[0].created).toEqual([
      { name: PLACES_STORE, keyPath: 'id', indexes: ['savedAt'] },
      { name: ROUTES_STORE, keyPath: 'id', indexes: ['updatedAt'] },
      { name: DRAFT_STORE, keyPath: 'id', indexes: [] },
    ]);
  });

  it('adds only what an older version lacked, leaving saved places alone', async () => {
    const { databases } = stubIndexedDb([{ upgradeFrom: ['saved-places'] }]);
    const { openDb, ROUTES_STORE, DRAFT_STORE } = await import('./db');

    await openDb();

    expect(databases[0].created.map((store) => store.name)).toEqual([ROUTES_STORE, DRAFT_STORE]);
  });

  it('adds the draft store to a v2 database, leaving saved routes alone', async () => {
    const { databases } = stubIndexedDb([{ upgradeFrom: ['saved-places', 'routes'] }]);
    const { openDb, DRAFT_STORE } = await import('./db');

    await openDb();

    expect(databases[0].created.map((store) => store.name)).toEqual([DRAFT_STORE]);
  });

  it('lets go of its connection when a newer build needs to upgrade', async () => {
    const { databases, open } = stubIndexedDb([{}, {}]);
    const { openDb } = await import('./db');

    const first = await openDb();
    databases[0].onversionchange!();

    expect(databases[0].close).toHaveBeenCalled();
    // And opens a fresh one next time, rather than handing out the closed one.
    expect(await openDb()).not.toBe(first);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens one connection for everyone — two versions from two modules would deadlock', async () => {
    const { open } = stubIndexedDb([{}]);
    const { openDb } = await import('./db');

    const [a, b] = await Promise.all([openDb(), openDb()]);

    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('ratmap', 3);
  });

  it('tries again after a failure rather than failing forever', async () => {
    const { open } = stubIndexedDb([{ fail: true }, {}]);
    const { openDb } = await import('./db');

    await expect(openDb()).rejects.toThrow('blocked');
    await expect(openDb()).resolves.toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe('tx', () => {
  function withStore(request: FakeRequest) {
    const { databases } = stubIndexedDb([{}]);
    return async () => {
      const db = await import('./db');
      await db.openDb();
      databases[0].transaction.mockReturnValue({ objectStore: () => ({}) });
      const pending = db.tx('saved-places', 'readonly', () => request as unknown as IDBRequest);
      return pending;
    };
  }

  it('resolves with what the request produced', async () => {
    const request: FakeRequest = {};
    const run = withStore(request);
    const pending = run();
    await vi.waitFor(() => expect(request.onsuccess).toBeTypeOf('function'));
    request.result = ['a place'];
    request.onsuccess!();

    await expect(pending).resolves.toEqual(['a place']);
  });

  it('rejects with the request’s own error', async () => {
    const request: FakeRequest = {};
    const pending = withStore(request)();
    await vi.waitFor(() => expect(request.onerror).toBeTypeOf('function'));
    request.error = new Error('quota exceeded');
    request.onerror!();

    await expect(pending).rejects.toThrow('quota exceeded');
  });
});

describe('newId', () => {
  it('uses a UUID where the platform has one', async () => {
    const { newId } = await import('./db');
    expect(newId('place')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('still makes a unique, prefixed id on a plain-http dev server without randomUUID', async () => {
    vi.stubGlobal('crypto', {});
    const { newId } = await import('./db');

    const a = newId('route');
    const b = newId('route');

    expect(a).toMatch(/^route-/);
    expect(a).not.toBe(b);
  });
});
