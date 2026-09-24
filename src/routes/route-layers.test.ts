import { beforeEach, describe, expect, it } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { mapInk } from '../map/flavor';
import { fakeStyleMap } from '../test-support/fake-map';
import type { LngLat } from './geo';
import type { ComputedLeg } from './router';
import {
  addRouteLayers,
  clearRouteGeometry,
  ROUTE_CASING_LAYER_ID,
  ROUTE_LINE_LAYER_ID,
  ROUTE_OFF_ROUTE_LAYER_ID,
  ROUTE_OFF_ROUTE_SOURCE_ID,
  ROUTE_SOURCE_ID,
  setOffRouteLine,
  setRouteGeometry,
} from './route-layers';

const A: LngLat = [-5.1, 56.8];
const B: LngLat = [-5.0, 56.79];
const C: LngLat = [-4.9, 56.78];

const leg = (coords: LngLat[], kind: 'snapped' | 'straight' = 'snapped'): ComputedLeg => ({
  coords,
  distanceM: 1000,
  kind,
  wayNames: [],
});

let map: ReturnType<typeof fakeStyleMap>;
const drawn = (id: string) => map.sources.get(id)!.data as FeatureCollection;

beforeEach(() => {
  map = fakeStyleMap();
});

describe('addRouteLayers', () => {
  it('draws the route on top of everything, casing under line, then the off-route line', () => {
    map.layers.push({ id: 'places_locality' });
    addRouteLayers(map as unknown as MLMap, 'dark');

    expect(map.layers.map((l) => l.id)).toEqual([
      'places_locality',
      ROUTE_CASING_LAYER_ID,
      ROUTE_LINE_LAYER_ID,
      ROUTE_OFF_ROUTE_LAYER_ID,
    ]);
  });

  it('is idempotent, so a style event arriving twice does not throw on a duplicate', () => {
    addRouteLayers(map as unknown as MLMap, 'dark');
    addRouteLayers(map as unknown as MLMap, 'dark');

    expect(map.addSource).toHaveBeenCalledTimes(2);
    expect(map.layers).toHaveLength(3);
  });

  it('draws a straight leg differently from a routed one (C11)', () => {
    addRouteLayers(map as unknown as MLMap, 'light');
    const line = map.layers.find((l) => l.id === ROUTE_LINE_LAYER_ID)!.paint as Record<string, unknown>;
    const ink = mapInk('light');

    expect(line['line-color']).toEqual(['case', ['==', ['get', 'kind'], 'straight'], ink.routeStraight, ink.routeLine]);
  });
});

describe('route geometry', () => {
  beforeEach(() => addRouteLayers(map as unknown as MLMap, 'dark'));

  it('draws each computed leg, tagged with its kind', () => {
    setRouteGeometry(map as unknown as MLMap, [leg([A, B]), leg([B, C], 'straight')]);

    expect(drawn(ROUTE_SOURCE_ID).features.map((f) => f.properties)).toEqual([
      { kind: 'snapped' },
      { kind: 'straight' },
    ]);
  });

  it('leaves out legs still being computed — a gap, not a guess', () => {
    setRouteGeometry(map as unknown as MLMap, [leg([A, B]), null, leg([C])]);

    expect(drawn(ROUTE_SOURCE_ID).features).toHaveLength(1);
  });

  it('draws the off-route leader line, and clears it', () => {
    setOffRouteLine(map as unknown as MLMap, A, B);
    expect(drawn(ROUTE_OFF_ROUTE_SOURCE_ID).features[0].geometry).toEqual({
      type: 'LineString',
      coordinates: [A, B],
    });

    setOffRouteLine(map as unknown as MLMap, A, null);
    expect(drawn(ROUTE_OFF_ROUTE_SOURCE_ID).features).toEqual([]);
  });

  it('clears both at once', () => {
    setRouteGeometry(map as unknown as MLMap, [leg([A, B])]);
    setOffRouteLine(map as unknown as MLMap, A, B);

    clearRouteGeometry(map as unknown as MLMap);

    expect(drawn(ROUTE_SOURCE_ID).features).toEqual([]);
    expect(drawn(ROUTE_OFF_ROUTE_SOURCE_ID).features).toEqual([]);
  });

  it('does nothing, rather than throwing, when a style swap has taken the source away', () => {
    const bare = fakeStyleMap();
    expect(() => setRouteGeometry(bare as unknown as MLMap, [leg([A, B])])).not.toThrow();
    expect(() => setOffRouteLine(bare as unknown as MLMap, A, B)).not.toThrow();
  });
});
