import { newId, ROUTES_STORE, tx } from '../db';
import type { LngLat } from './geo';
import type { LegSlot, Waypoint } from './route-model';

// Saved routes, local-first (C10).
//
// C10 in full: **persist complete coordinate arrays, never a server-side route id**. There
// is no server in this design at all, so the constraint reads slightly differently here —
// but its real content still bites: a saved route must not depend on anything we would
// have to recompute to render it. `coords` is the whole route as drawn, flattened and
// authoritative. It is what renders, what exports, and what a route follows against, and
// it does that with the network permanently off, on an app build that has forgotten how
// the route was originally computed.
//
// `legs` and `waypoints` are kept alongside so a saved route can be *reopened for editing*
// — but nothing that merely displays a route may depend on them. Treat them as optional
// even though we always write them.

export interface SavedRoute {
  id: string;
  name: string;
  /** The complete route geometry, start to finish (C10). Never derived at read time. */
  coords: LngLat[];
  distanceM: number;
  /** Null when the profile could not be computed — never 0 as a stand-in. */
  ascentM: number | null;
  descentM: number | null;
  /** True if any leg fell back to a straight line (C11). Shown, not hidden. */
  hasStraightLegs: boolean;
  /** Editing state. Optional by contract: rendering must not need it. */
  waypoints?: Waypoint[];
  legs?: LegSlot[];
  createdAt: number;
  updatedAt: number;
}

export type NewRoute = Omit<SavedRoute, 'id' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<SavedRoute, 'id' | 'createdAt' | 'updatedAt'>>;

export async function saveRoute(route: NewRoute): Promise<SavedRoute> {
  const now = Date.now();
  const record: SavedRoute = {
    ...route,
    id: route.id ?? newId('route'),
    createdAt: route.createdAt ?? now,
    updatedAt: now,
  };

  if (record.coords.length === 0) {
    throw new Error('Refusing to save a route with no geometry');
  }

  await tx(ROUTES_STORE, 'readwrite', (store) => store.put(record));
  return record;
}

export async function listRoutes(): Promise<SavedRoute[]> {
  const all = await tx<SavedRoute[]>(ROUTES_STORE, 'readonly', (store) => store.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteRoute(id: string): Promise<void> {
  await tx(ROUTES_STORE, 'readwrite', (store) => store.delete(id));
}
