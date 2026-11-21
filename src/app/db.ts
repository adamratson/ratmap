// One IndexedDB database for everything local-first: saved places, and saved routes (C10).
//
// Shared rather than one database per feature because they are one database — the name and
// version are global to the origin. Two modules calling `indexedDB.open('ratmap', …)` with
// different versions is a deadlock waiting to happen: whichever opens second triggers a
// version change the first connection blocks, and the app hangs with no error. Adding a
// store means bumping DB_VERSION here and creating it in `upgrade()`, once.

const DB_NAME = 'ratmap';

/** v1: saved-places. v2: routes (Phase 4). v3: the route on screen, kept across a reload. */
const DB_VERSION = 3;

export const PLACES_STORE = 'saved-places';
export const ROUTES_STORE = 'routes';
export const DRAFT_STORE = 'route-draft';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      // A newer build opening a newer version (in another tab, or the page an update is
      // reloading into) waits for every older connection to close. Left open, this one
      // would hang that build's first read with no error at all.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });

  // Don't cache a rejected promise — a transient failure would otherwise poison every
  // later call for the lifetime of the page.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

/**
 * Create any store this version needs.
 *
 * Written as "create if absent" rather than as a chain of version steps: every store here
 * is keyed by `id` with the same shape it has always had, so there is nothing to migrate —
 * an upgrade from v1 only has to add what v1 lacked. A store whose *shape* changes would
 * need a real migration, and this is where it would go.
 */
function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(PLACES_STORE)) {
    db.createObjectStore(PLACES_STORE, { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
  }
  if (!db.objectStoreNames.contains(ROUTES_STORE)) {
    db.createObjectStore(ROUTES_STORE, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(DRAFT_STORE)) {
    db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
  }
}

export function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

/**
 * Id for a locally-created record.
 *
 * randomUUID needs a secure context; the app requires one anyway (service worker, OPFS,
 * geolocation), but fall back rather than throw so a plain-http dev server still works.
 */
export function newId(prefix: string): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
