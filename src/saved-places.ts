// Saved places, local-first. IndexedDB rather than localStorage: it survives eviction
// pressure better under a persisted origin (C1), stores structured records without JSON
// round-tripping, and is async so a large list never blocks the map.
//
// Same principle as C10 for routes — everything needed to render a saved place is stored
// here, so it works with the network permanently off. No server, no account, no sync.
//
// The connection itself lives in db.ts, shared with saved routes: the database name and
// version are global to the origin, so opening it from two places at two versions
// deadlocks.

import { newId, PLACES_STORE, tx } from './db';

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

export async function savePlace(
  place: Omit<SavedPlace, 'id' | 'savedAt'> & Partial<Pick<SavedPlace, 'id' | 'savedAt'>>,
): Promise<SavedPlace> {
  const record: SavedPlace = {
    id: place.id ?? newId('place'),
    name: place.name,
    lng: place.lng,
    lat: place.lat,
    ...(place.ele === undefined ? {} : { ele: place.ele }),
    savedAt: place.savedAt ?? Date.now(),
  };
  await tx(PLACES_STORE, 'readwrite', (store) => store.put(record));
  return record;
}

export async function listPlaces(): Promise<SavedPlace[]> {
  const all = await tx<SavedPlace[]>(PLACES_STORE, 'readonly', (store) => store.getAll());
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deletePlace(id: string): Promise<void> {
  await tx(PLACES_STORE, 'readwrite', (store) => store.delete(id));
}
