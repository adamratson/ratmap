import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import {
  LAYER_GROUP_ORDER,
  applyAllStoredVisibility,
  applyLayerVisibility,
  isLayerVisible,
  matchesGroup,
  setLayerVisible,
  type LayerGroup,
} from './layers';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

/**
 * One real id per group, as the app actually builds them — the global singletons, and a
 * downloaded region's prefixed copies (both path flavours included).
 */
const IDS_BY_GROUP: Record<LayerGroup, string[]> = {
  peaks: ['peaks-symbol', 'peaks-symbol-marker'],
  hillshade: ['hillshade', 'region-lochaber-terrain-hillshade'],
  contours: [
    'region-lochaber-contours-lines-index',
    'region-lochaber-contours-lines',
    'region-lochaber-contours-labels',
  ],
  paths: [
    'region-lochaber-basemap-paths-casing',
    'region-lochaber-basemap-paths',
    'region-lochaber-paths-paths-casing',
    'region-lochaber-paths-paths',
  ],
  sac: ['region-lochaber-sac-band', 'region-lochaber-sac-labels'],
  terrainFeatures: [
    'region-lochaber-terrain-features-fill',
    'region-lochaber-terrain-features-points',
  ],
  avalanche: ['region-lochaber-avalanche-shade'],
  footprints: ['region-footprints-fill', 'region-footprints-line'],
};

/** Layers no toggle may ever touch: the basemap, both copies, and the user's own route. */
const NEVER_TOGGLED = [
  'earth',
  'roads_minor',
  'places_locality',
  'region-lochaber-basemap-earth',
  'region-lochaber-basemap-roads_minor_casing',
  'region-lochaber-basemap-places_locality',
  'route-casing',
  'route-line',
  'route-off-route-line',
];

describe('matchesGroup', () => {
  it('claims every layer the app builds for each group, and nothing from any other', () => {
    for (const group of LAYER_GROUP_ORDER) {
      for (const [owner, ids] of Object.entries(IDS_BY_GROUP)) {
        for (const id of ids) {
          expect(matchesGroup(id, group), `${id} vs ${group}`).toBe(owner === group);
        }
      }
    }
  });

  it('does not let contours and SAC share their -labels layers', () => {
    // The one real collision risk: both emit a `…-labels` layer.
    expect(matchesGroup('region-lochaber-sac-labels', 'contours')).toBe(false);
    expect(matchesGroup('region-lochaber-contours-labels', 'sac')).toBe(false);
  });

  it('never claims a basemap or route layer', () => {
    for (const id of NEVER_TOGGLED) {
      for (const group of LAYER_GROUP_ORDER) {
        expect(matchesGroup(id, group), `${id} vs ${group}`).toBe(false);
      }
    }
  });
});

describe('layer visibility preference', () => {
  it('shows everything but avalanche terrain until told otherwise', () => {
    for (const group of LAYER_GROUP_ORDER) {
      expect(isLayerVisible(group), group).toBe(group !== 'avalanche');
    }
  });

  it('remembers each group independently', () => {
    setLayerVisible('peaks', false);
    setLayerVisible('avalanche', true);

    expect(isLayerVisible('peaks')).toBe(false);
    expect(isLayerVisible('avalanche')).toBe(true);
    expect(isLayerVisible('contours')).toBe(true);

    setLayerVisible('peaks', true);
    expect(isLayerVisible('peaks')).toBe(true);
    expect(isLayerVisible('avalanche')).toBe(true);
  });

  it('falls back to the defaults on a stored value it cannot read', () => {
    store.set('ratmap:visible-layers', '{not json');
    expect(isLayerVisible('peaks')).toBe(true);
    expect(isLayerVisible('avalanche')).toBe(false);
  });

  it('survives storage being unavailable rather than failing startup over it', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });

    expect(() => setLayerVisible('peaks', false)).not.toThrow();
    expect(isLayerVisible('peaks')).toBe(true);
  });
});

function fakeMap(ids: string[]) {
  const visibility = new Map<string, unknown>();
  return {
    visibility,
    getStyle: () => ({ layers: ids.map((id) => ({ id })) }),
    getLayersOrder: () => [...ids],
    getLayer: (id: string) => (ids.includes(id) ? { id } : undefined),
    setLayoutProperty: vi.fn((id: string, name: string, value: unknown) => {
      if (name === 'visibility') visibility.set(id, value);
    }),
  };
}

describe('applying visibility to the map', () => {
  const everything = [...Object.values(IDS_BY_GROUP).flat(), ...NEVER_TOGGLED];

  it("switches one group's layers, in every region, and leaves the rest alone", () => {
    const map = fakeMap(everything);
    setLayerVisible('contours', false);

    applyLayerVisibility(map as unknown as MLMap, 'contours');

    for (const id of IDS_BY_GROUP.contours) expect(map.visibility.get(id)).toBe('none');
    expect([...map.visibility.keys()].sort()).toEqual([...IDS_BY_GROUP.contours].sort());
  });

  it('re-asserts every stored state at once, never touching the basemap or route', () => {
    const map = fakeMap(everything);
    setLayerVisible('peaks', false);

    applyAllStoredVisibility(map as unknown as MLMap);

    for (const id of IDS_BY_GROUP.peaks) expect(map.visibility.get(id)).toBe('none');
    for (const id of IDS_BY_GROUP.avalanche) expect(map.visibility.get(id)).toBe('none');
    for (const id of IDS_BY_GROUP.hillshade) expect(map.visibility.get(id)).toBe('visible');
    for (const id of NEVER_TOGGLED) expect(map.visibility.has(id)).toBe(false);
  });
});
