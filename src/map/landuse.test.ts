import { describe, expect, it } from 'vitest';
import { layers as basemapLayers } from '@protomaps/basemaps';
import { ratmapFlavor } from './flavor';
import { ratmapBasemapLayers, TOWN_LABEL_LAYER_ID } from './landuse';

describe('ratmapBasemapLayers', () => {
  const flavor = ratmapFlavor('light');
  const ids = ratmapBasemapLayers('basemap', 'light', { lang: 'en' }).map((l) => l.id);

  it('adds a bare rock layer directly above the parks', () => {
    // The anchor is looked up by id. If Protomaps ever renamed `landuse_park`, findIndex
    // would return -1 and the rock would land at position 0 — beneath the background,
    // drawn and never seen, with nothing to say so. This is the check that says so.
    expect(ids).toContain('landuse_park');
    expect(ids.indexOf('landuse_bare_rock')).toBe(ids.indexOf('landuse_park') + 1);
  });

  it('outlines buildings directly above their fill', () => {
    // Same anchor-by-id risk as the rock: a rename upstream would drop it to position 0.
    expect(ids).toContain('buildings');
    expect(ids.indexOf('buildings_outline')).toBe(ids.indexOf('buildings') + 1);
  });

  it('outlines exactly what the fill paints', () => {
    const layers = ratmapBasemapLayers('region-x-basemap', 'dark');
    const fill = layers.find((l) => l.id === 'buildings')!;
    const outline = layers.find((l) => l.id === 'buildings_outline')!;
    expect(outline).toMatchObject({ type: 'line', source: 'region-x-basemap', 'source-layer': 'buildings' });
    expect(fill).toMatchObject({ 'source-layer': 'buildings' });
    expect((outline as { filter?: unknown }).filter).toEqual((fill as { filter?: unknown }).filter);
    expect((outline as { filter?: unknown }).filter).toBeDefined();
  });

  it('only adds those layers, car parks being drawn from their own artifact', () => {
    const plain = basemapLayers('basemap', flavor, { lang: 'en' }).map((l) => l.id);
    const withRock = [
      ...plain.slice(0, plain.indexOf('landuse_park') + 1),
      'landuse_bare_rock',
      ...plain.slice(plain.indexOf('landuse_park') + 1),
    ];
    expect(ids).toEqual([
      ...withRock.slice(0, withRock.indexOf('buildings') + 1),
      'buildings_outline',
      ...withRock.slice(withRock.indexOf('buildings') + 1),
    ]);
  });

  it('draws from the source it is given, so region copies read their own archive', () => {
    const layers = ratmapBasemapLayers('region-x-basemap', 'light');
    const rock = layers.find((l) => l.id === 'landuse_bare_rock');
    expect(rock).toMatchObject({ source: 'region-x-basemap', 'source-layer': 'landuse' });
  });

  it('names a town label layer the basemap actually has', () => {
    // peaks.ts and region-layers.ts both anchor to it by id.
    expect(ids).toContain(TOWN_LABEL_LAYER_ID);
  });
});
