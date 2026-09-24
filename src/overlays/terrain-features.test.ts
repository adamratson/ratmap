import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import {
  addTerrainFeatureLayers,
  TERRAIN_FEATURE_KINDS,
  terrainFeaturesFillLayerId,
} from './terrain-features';

function addTo(minzoom: number) {
  const added: Array<{ layer: Record<string, unknown>; before?: string }> = [];
  const map = {
    addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })),
  } as unknown as MLMap;
  addTerrainFeatureLayers(map, 'region-x-terrain-features', { minzoom, before: 'labels' });
  return added;
}

describe('addTerrainFeatureLayers', () => {
  it('adds a fill for areas and circles for single points, both under the labels', () => {
    const added = addTo(10);

    expect(added.map(({ layer }) => [layer.id, layer.type])).toEqual([
      [terrainFeaturesFillLayerId('region-x-terrain-features'), 'fill'],
      ['region-x-terrain-features-points', 'circle'],
    ]);
    expect(added.every(({ before }) => before === 'labels')).toBe(true);
  });

  it('colours every kind it knows, rather than letting one fall through to grey', () => {
    const fill = addTo(10)[0].layer.paint as Record<string, unknown[]>;
    const match = fill['fill-color'];

    for (const entry of TERRAIN_FEATURE_KINDS) {
      expect(match[match.indexOf(entry.kind) + 1]).toBe(entry.fillColor);
    }
  });

  it('keeps single points off the map until z13, where one boulder means something', () => {
    expect(addTo(8)[1].layer.minzoom).toBe(13);
    // …but never below the region's own floor.
    expect(addTo(14)[1].layer.minzoom).toBe(14);
  });

  it('fades the areas in from the region floor, not all at once', () => {
    const paint = addTo(10)[0].layer.paint as Record<string, unknown[]>;
    expect(paint['fill-opacity']).toEqual(['interpolate', ['linear'], ['zoom'], 10, 0, 12, 0.55]);
  });
});

describe('TERRAIN_FEATURE_KINDS', () => {
  it('says coverage is partial on every entry — an empty hillside is not "no scree"', () => {
    for (const entry of TERRAIN_FEATURE_KINDS) expect(entry.note).toMatch(/partial/i);
  });
});
