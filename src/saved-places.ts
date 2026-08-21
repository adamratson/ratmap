// Saved places, local-first. IndexedDB rather than localStorage: it survives eviction
// pressure better under a persisted origin (C1), stores structured records without JSON
// round-tripping, and is async so a large list never blocks the map.
//
// Same principle as C10 for routes — everything needed to render a saved place is stored
// here, so it works with the network permanently off. No server, no account, no sync.

const DB_NAME = 'ratmap';
const DB_VERSION = 1;
const STORE = 'saved-places';

export interface SavedPlace {
  /** Stable id; generated on save if absent. */
  id: string;
  name: string;
  lng: number;
  lat: number;
  /** Metres, when the place came from a peak that had one. */
  ele?: number;
  /** Epoch millis. */
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });

  // Don't cache a rejected promise — a transient failure would otherwise poison every
  // later call for the lifetime of the page.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

function newId(): string {
  // randomUUID needs a secure context; the app requires one anyway (service worker, OPFS,
  // geolocation), but fall back rather than throw so a plain-http dev server still works.
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `place-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function savePlace(place: Omit<SavedPlace, 'id' | 'savedAt'> & Partial<Pick<SavedPlace, 'id' | 'savedAt'>>): Promise<SavedPlace> {
  const record: SavedPlace = {
    id: place.id ?? newId(),
    name: place.name,
    lng: place.lng,
    lat: place.lat,
    ...(place.ele === undefined ? {} : { ele: place.ele }),
    savedAt: place.savedAt ?? Date.now(),
  };
  await tx('readwrite', (store) => store.put(record));
  return record;
}

export async function listPlaces(): Promise<SavedPlace[]> {
  const all = await tx<SavedPlace[]>('readonly', (store) => store.getAll());
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deletePlace(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id));
}

export async function clearPlaces(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
}
