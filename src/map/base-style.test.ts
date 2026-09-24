import { describe, expect, it, vi } from 'vitest';
import type { HillshadeLayerSpecification } from 'maplibre-gl';
import { BASEMAP_MAX_ZOOM, BASEMAP_PMTILES_URL, GLYPHS_URL, SPRITE_URL, TERRAIN_MAX_ZOOM } from '../app/config';
import { buildBaseStyle } from './base-style';
import { mapInk } from './flavor';
import type { TileSourceRegistry } from './tile-source-registry';

const registry = { sourceUrl: (key: string) => `pmtiles://${key}` } as unknown as TileSourceRegistry;

describe('buildBaseStyle', () => {
  const style = buildBaseStyle('dark', registry);

  it('reads the basemap through the registry, never straight off the network (C17)', () => {
    expect(style.sources.basemap).toMatchObject({
      type: 'vector',
      url: `pmtiles://${BASEMAP_PMTILES_URL}`,
    });
  });

  it('caps each source at its archive’s real top zoom, so nothing vanishes when overzoomed', () => {
    expect(style.sources.basemap).toMatchObject({ maxzoom: BASEMAP_MAX_ZOOM });
    expect(style.sources.terrain).toMatchObject({ maxzoom: TERRAIN_MAX_ZOOM, encoding: 'terrarium' });
  });

  it('credits OpenStreetMap on the basemap (ODbL)', () => {
    expect((style.sources.basemap as { attribution: string }).attribution).toContain(
      'openstreetmap.org/copyright',
    );
  });

  it('serves glyphs and sprites locally, so labels survive offline (C7)', () => {
    expect(style.glyphs).toBe(GLYPHS_URL);
    expect(style.sprite).toBe(SPRITE_URL);
  });

  it('shades relief in the theme’s own inks', () => {
    for (const theme of ['light', 'dark'] as const) {
      const hillshade = buildBaseStyle(theme, registry).layers.find(
        (layer) => layer.id === 'hillshade',
      ) as HillshadeLayerSpecification;
      expect(hillshade.paint?.['hillshade-shadow-color']).toBe(mapInk(theme).hillshadeShadow);
      expect(hillshade.paint?.['hillshade-highlight-color']).toBe(mapInk(theme).hillshadeHighlight);
    }
  });

  it('has exactly one background, from the basemap', () => {
    expect(style.layers.filter((layer) => layer.type === 'background')).toHaveLength(1);
  });

  it('includes the bare rock layer the plain Protomaps flavour lacks', () => {
    expect(style.layers.some((layer) => layer.id === 'landuse_bare_rock')).toBe(true);
  });
});

describe('buildBaseStyle with the fallback terrain switched on', () => {
  it('uses the AWS terrarium tiles instead of our archive — the debugging escape hatch', async () => {
    vi.resetModules();
    vi.doMock('../app/config', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../app/config')>()),
      USE_FALLBACK_TERRAIN: true,
    }));
    const { buildBaseStyle: build } = await import('./base-style');

    const terrain = build('light', registry).sources.terrain as { tiles?: string[]; url?: string };

    expect(terrain.url).toBeUndefined();
    expect(terrain.tiles?.[0]).toContain('terrarium/{z}/{x}/{y}.png');
    vi.doUnmock('../app/config');
  });
});
