import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { LngLat } from './geo';
import type { LegSlot } from './route-model';

// Map rendering for the planned route. Geometry only — the planner owns the waypoint
// markers, because those are interactive DOM elements rather than style layers.

export const ROUTE_SOURCE_ID = 'route-geometry';
export const ROUTE_LINE_LAYER_ID = 'route-line';
export const ROUTE_CASING_LAYER_ID = 'route-casing';
export const ROUTE_OFF_ROUTE_SOURCE_ID = 'route-off-route';
export const ROUTE_OFF_ROUTE_LAYER_ID = 'route-off-route-line';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Add the route layers, on top of everything.
 *
 * Deliberately above the labels, unlike the hillshade and contours in region-layers.ts.
 * Relief under a place name is context; the route is the thing being read, and a place
 * name drawn over it would break the line exactly where the map is busiest.
 */
export function addRouteLayers(map: MLMap): void {
  if (map.getSource(ROUTE_SOURCE_ID)) return;

  map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: EMPTY });
  map.addSource(ROUTE_OFF_ROUTE_SOURCE_ID, { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: ROUTE_CASING_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': 'rgba(255,255,255,0.9)',
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 5, 16, 11],
    },
  });

  map.addLayer({
    id: ROUTE_LINE_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      // Straight legs are drawn differently on purpose. C11 allows a waypoint that could
      // not be snapped to the path network, and the resulting leg is a guess at a line
      // across country — possibly across a cliff. Rendering it identically to a real
      // routed leg would present that guess as a path.
      'line-color': ['case', ['==', ['get', 'kind'], 'straight'], '#b45309', '#1d4ed8'],
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 3, 16, 7],
      'line-dasharray': [
        'case',
        ['==', ['get', 'kind'], 'straight'],
        ['literal', [1.5, 1.2]],
        ['literal', [1, 0]],
      ],
    },
  });

  // The leader line from the user's position to the route while off-route: it answers
  // "which way back", which a distance figure alone does not.
  map.addLayer({
    id: ROUTE_OFF_ROUTE_LAYER_ID,
    type: 'line',
    source: ROUTE_OFF_ROUTE_SOURCE_ID,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': '#dc2626',
      'line-width': 2,
      'line-dasharray': [2, 2],
    },
  });
}

/** Draw the current legs. Pending (null) legs simply do not render. */
export function setRouteGeometry(map: MLMap, legs: readonly LegSlot[]): void {
  const source = geoJsonSource(map, ROUTE_SOURCE_ID);
  if (!source) return;

  const features: Feature<LineString>[] = [];
  for (const leg of legs) {
    if (!leg || leg.coords.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { kind: leg.kind },
      geometry: { type: 'LineString', coordinates: leg.coords.map(([lng, lat]) => [lng, lat]) },
    });
  }

  source.setData({ type: 'FeatureCollection', features });
}

/** Draw (or clear) the off-route leader line. */
export function setOffRouteLine(map: MLMap, from: LngLat | null, to: LngLat | null): void {
  const source = geoJsonSource(map, ROUTE_OFF_ROUTE_SOURCE_ID);
  if (!source) return;

  if (!from || !to) {
    source.setData(EMPTY);
    return;
  }

  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [from, to] },
      },
    ],
  });
}

/** The source, or undefined if the style was reloaded out from under us. */
function geoJsonSource(map: MLMap, id: string): GeoJSONSource | undefined {
  const source = map.getSource(id);
  return source?.type === 'geojson' ? (source as GeoJSONSource) : undefined;
}

export function clearRouteGeometry(map: MLMap): void {
  setRouteGeometry(map, []);
  setOffRouteLine(map, null, null);
}

export function removeRouteLayers(map: MLMap): void {
  for (const id of [ROUTE_CASING_LAYER_ID, ROUTE_LINE_LAYER_ID, ROUTE_OFF_ROUTE_LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [ROUTE_SOURCE_ID, ROUTE_OFF_ROUTE_SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}
