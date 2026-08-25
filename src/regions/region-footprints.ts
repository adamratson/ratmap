import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { Region } from './manifest';

// Which parts of the world this app actually has detail for, drawn on the map.
//
// The catalogue used to be four names in a list. Nothing said which of them covered the
// blurry area you were looking at, nothing showed where they were, and the "limited
// detail" notice correctly reported the problem while offering no route to the thing that
// fixes it. On a phone the map *is* the interface; the coverage belongs on it.

export const FOOTPRINT_SOURCE_ID = 'region-footprints';
export const FOOTPRINT_FILL_LAYER_ID = 'region-footprints-fill';
export const FOOTPRINT_LINE_LAYER_ID = 'region-footprints-line';

export interface Footprint {
  region: Region;
  downloaded: boolean;
}

/**
 * The region whose box contains `point`, preferring the smallest.
 *
 * Regions nest — Lochaber sits inside Scotland — and the smaller one is both the more
 * useful answer ("download the bit you are looking at") and the cheaper download.
 */
export function regionAt(
  footprints: Footprint[],
  point: [number, number],
  { downloaded }: { downloaded?: boolean } = {},
): Region | null {
  const candidates = footprints
    .filter((f) => (downloaded === undefined ? true : f.downloaded === downloaded))
    .filter((f) => contains(f.region.bbox, point))
    .sort((a, b) => area(a.region.bbox) - area(b.region.bbox));

  return candidates[0]?.region ?? null;
}

function contains(bbox: Region['bbox'], [lng, lat]: [number, number]): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function area(bbox: Region['bbox']): number {
  return Math.abs(bbox[2] - bbox[0]) * Math.abs(bbox[3] - bbox[1]);
}

/**
 * Which footprints belong on the map: the ones on this device, plus the single region
 * currently being offered.
 *
 * Not the whole catalogue. Outlining everything answered "where could detail come from",
 * which was a real question while the catalogue was four areas of Scotland and one of
 * Montenegro. Now that it covers the globe the answer is "everywhere", and drawing it
 * tints the whole map with information nobody can act on — while burying the two things
 * that do matter: where you already have detail, and what the notice is offering you here.
 */
export function visibleFootprints(
  footprints: Footprint[],
  offeredId: string | null,
): Footprint[] {
  return footprints.filter(
    ({ region, downloaded }) => downloaded || region.id === offeredId,
  );
}

export function footprintCollection(footprints: Footprint[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: footprints.map(({ region, downloaded }) => {
      const [west, south, east, north] = region.bbox;
      return {
        type: 'Feature' as const,
        // Name and download state ride on the feature so the style expressions can key
        // off them, rather than the app maintaining two sources that must stay in sync.
        properties: { id: region.id, name: region.name, downloaded },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      };
    }),
  };
}

/**
 * Draw, or redraw, the coverage layer.
 *
 * Idempotent: called again whenever a download finishes or a region is deleted, which is
 * exactly when the fills need to change.
 */
export function renderFootprints(map: MLMap, footprints: Footprint[]): void {
  const data = footprintCollection(footprints);

  const existing = map.getSource(FOOTPRINT_SOURCE_ID);
  if (existing && existing.type === 'geojson') {
    (existing as GeoJSONSource).setData(data);
    return;
  }

  map.addSource(FOOTPRINT_SOURCE_ID, { type: 'geojson', data });

  map.addLayer({
    id: FOOTPRINT_FILL_LAYER_ID,
    type: 'fill',
    source: FOOTPRINT_SOURCE_ID,
    paint: {
      'fill-color': ['case', ['get', 'downloaded'], '#15803d', '#2563eb'],
      // Very light. This is a hint about the data, not a feature of the landscape, and it
      // sits under everything a walker is actually reading.
      'fill-opacity': ['case', ['get', 'downloaded'], 0.1, 0.05],
    },
  });

  map.addLayer({
    id: FOOTPRINT_LINE_LAYER_ID,
    type: 'line',
    source: FOOTPRINT_SOURCE_ID,
    paint: {
      'line-color': ['case', ['get', 'downloaded'], '#15803d', '#2563eb'],
      'line-width': 1.5,
      'line-opacity': 0.55,
      // Downloaded regions are solid, available ones dashed — the difference has to
      // survive being read in sunlight, where a colour difference alone may not.
      'line-dasharray': ['case', ['get', 'downloaded'], ['literal', [1]], ['literal', [2, 2]]],
    },
  });
}

export function removeFootprints(map: MLMap): void {
  for (const id of [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(FOOTPRINT_SOURCE_ID)) map.removeSource(FOOTPRINT_SOURCE_ID);
}
