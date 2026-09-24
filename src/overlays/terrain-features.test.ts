import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import {
  addTerrainFeatureLayers,
  SCREE_STIPPLE,
  SHINGLE_STIPPLE,
  stippleImage,
  TERRAIN_FEATURE_KINDS,
} from './terrain-features';

function addTo(minzoom: number, theme: 'light' | 'dark' = 'light') {
  const added: Array<{ layer: Record<string, unknown>; before?: string }> = [];
  const images = new Map<string, unknown>();
  const map = {
    addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })),
    hasImage: vi.fn((id: string) => images.has(id)),
    addImage: vi.fn((id: string, image: unknown) => images.set(id, image)),
  } as unknown as MLMap;
  addTerrainFeatureLayers(map, 'region-x-terrain-features', {
    minzoom,
    before: 'labels',
    ink: mapInk(theme),
  });
  return { added, map, images };
}

describe('addTerrainFeatureLayers', () => {
  it('draws stippled scree and shingle and an outlined rock, all under the labels', () => {
    const { added } = addTo(10);

    expect(added.map(({ layer }) => [layer.id, layer.type])).toEqual([
      ['region-x-terrain-features-scree', 'fill'],
      ['region-x-terrain-features-shingle', 'fill'],
      ['region-x-terrain-features-rock', 'fill'],
      ['region-x-terrain-features-rock-outline', 'line'],
    ]);
    expect(added.every(({ before }) => before === 'labels')).toBe(true);
  });

  it('draws no circles: individual boulders buried the Lake District', () => {
    expect(addTo(10).added.some(({ layer }) => layer.type === 'circle')).toBe(false);
  });

  it('gives each kind a filter of its own, with boulder fields treated as rock', () => {
    const filters = addTo(10).added.map(({ layer }) => JSON.stringify(layer.filter));
    expect(filters[0]).toContain('"scree"');
    expect(filters[1]).toContain('"shingle"');
    expect(filters[2]).toContain('"stone"');
    expect(filters[3]).toBe(filters[2]);
  });

  it('registers one pattern image per kind, in the theme’s ink, and reuses it', () => {
    const light = addTo(10, 'light');
    const dark = addTo(10, 'dark');
    expect([...light.images.keys()]).toHaveLength(2);
    expect([...light.images.keys()]).not.toEqual([...dark.images.keys()]);

    addTerrainFeatureLayers(light.map, 'region-y-terrain-features', {
      minzoom: 10,
      ink: mapInk('light'),
    });
    expect(light.map.addImage).toHaveBeenCalledTimes(2);
  });

  it('fades everything in from the region floor, not all at once', () => {
    const paint = addTo(10).added[0].layer.paint as Record<string, unknown[]>;
    expect(paint['fill-opacity']).toEqual(['interpolate', ['linear'], ['zoom'], 10, 0, 12, 1]);
  });
});

describe('stippleImage', () => {
  it('is deterministic, so the map looks the same on every launch', () => {
    const a = stippleImage(SCREE_STIPPLE, '#5a5048');
    const b = stippleImage(SCREE_STIPPLE, '#5a5048');
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('paints dots but leaves most of the tile clear, in the colour asked for', () => {
    const { width, height, data } = stippleImage(SCREE_STIPPLE, '#c2b8a8');
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        inked++;
        expect([data[i], data[i + 1], data[i + 2]]).toEqual([0xc2, 0xb8, 0xa8]);
      }
    }
    const coverage = inked / (width * height);
    expect(coverage).toBeGreaterThan(0.03);
    expect(coverage).toBeLessThan(0.3);
  });

  it('tiles without a seam: a dot crossing an edge wraps to the opposite one', () => {
    // A dot that reaches past the right edge must reappear on the left, or the pattern
    // shows a visible grid line at every tile boundary.
    const { width, height, data } = stippleImage(SHINGLE_STIPPLE, '#000000');
    const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];
    for (let y = 0; y < height; y++) {
      const right = alphaAt(width - 1, y);
      const left = alphaAt(0, y);
      // Soft edges only: neighbouring columns of a wrapped dot differ, never jump 0 -> full.
      expect(Math.abs(right - left)).toBeLessThan(200);
    }
  });

  it('rejects a colour it cannot read rather than painting black', () => {
    expect(() => stippleImage(SCREE_STIPPLE, 'red')).toThrow(/#rrggbb/);
  });
});

describe('TERRAIN_FEATURE_KINDS', () => {
  it('says coverage is partial on every entry — an empty hillside is not "no scree"', () => {
    for (const entry of TERRAIN_FEATURE_KINDS) expect(entry.note).toMatch(/partial/i);
  });
});
