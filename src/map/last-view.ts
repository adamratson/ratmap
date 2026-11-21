import type { Map as MLMap } from 'maplibre-gl';

// Where the map was when ratmap was last closed, so it opens there again — not over the
// whole of Scotland at z6, with the walk you were looking at a search and a zoom away.
//
// localStorage rather than IndexedDB: it has to be there synchronously, before the map is
// made, or the map draws Scotland for a frame and then jumps.

const STORAGE_KEY = 'ratmap.view';

export interface MapView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Where the map opens with nothing remembered: the Scottish Highlands, whole. */
export const DEFAULT_VIEW: MapView = { center: [-4.5, 56.8], zoom: 6, bearing: 0, pitch: 0 };

/**
 * The view last saved, or the default. Anything stored that is not a sane view — another
 * build's shape, a hand-edited value, a NaN — is ignored rather than handed to MapLibre,
 * where a bad zoom breaks the map until a reload.
 */
export function readLastView(storage: Pick<Storage, 'getItem'> | null = safeStorage()): MapView {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<MapView> | null;
    if (!stored) return DEFAULT_VIEW;
    const [lng, lat] = Array.isArray(stored.center) ? stored.center : [];
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
    if (!finite(lng) || !finite(lat) || !finite(stored.zoom)) return DEFAULT_VIEW;
    if (Math.abs(lat) > 85 || stored.zoom < 0 || stored.zoom > 24) return DEFAULT_VIEW;
    return {
      // Wrapped only when out of range: the arithmetic would otherwise nudge every
      // longitude by a rounding error.
      center: [Math.abs(lng) <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180, lat],
      zoom: stored.zoom,
      bearing: finite(stored.bearing) ? stored.bearing : 0,
      pitch: finite(stored.pitch) ? Math.min(85, Math.max(0, stored.pitch)) : 0,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

/**
 * Save the view each time the map comes to rest. Every `moveend`, which a pinch or a fling
 * fires once at its end, not per frame — and so whatever closed the app, an iOS eviction
 * included, the view saved is the last one the map settled on.
 */
export function rememberView(map: MLMap, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  map.on('moveend', () => {
    const { lng, lat } = map.getCenter();
    const view: MapView = {
      center: [round(lng, 6), round(lat, 6)],
      zoom: round(map.getZoom(), 2),
      bearing: round(map.getBearing(), 1),
      pitch: round(map.getPitch(), 1),
    };
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      // Private mode or full storage: the map opens at the default next time, which is
      // where it always used to open.
    }
  });
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** localStorage, where reading it does not throw (it can, with storage blocked). */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
