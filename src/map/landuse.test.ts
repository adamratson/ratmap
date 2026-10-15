import { describe, expect, it } from 'vitest';
import { layers as basemapLayers } from '@protomaps/basemaps';
import { ratmapFlavor } from './flavor';
import { ratmapBasemapLayers, TOWN_LABEL_LAYER_ID } from './landuse';
import { PARKING_LAYER_ID } from './parking';

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

  it('adds car parks directly above the other POIs', () => {
    // Same failure as above if Protomaps renamed `pois`: the layer would land at the
    // bottom of the stack, under every fill.
    expect(ids).toContain('pois');
    expect(ids.indexOf(PARKING_LAYER_ID)).toBe(ids.indexOf('pois') + 1);
  });

  it('only adds those two layers', () => {
    const plain = basemapLayers('basemap', flavor, { lang: 'en' }).map((l) => l.id);
    expect(ids).toEqual([
      ...plain.slice(0, plain.indexOf('landuse_park') + 1),
      'landuse_bare_rock',
      ...plain.slice(plain.indexOf('landuse_park') + 1, plain.indexOf('pois') + 1),
      PARKING_LAYER_ID,
      ...plain.slice(plain.indexOf('pois') + 1),
    ]);
  });

  it('draws from the source it is given, so region copies read their own archive', () => {
    const layers = ratmapBasemapLayers('region-x-basemap', 'light');
    const rock = layers.find((l) => l.id === 'landuse_bare_rock');
    const parking = layers.find((l) => l.id === PARKING_LAYER_ID);
    expect(rock).toMatchObject({ source: 'region-x-basemap', 'source-layer': 'landuse' });
    expect(parking).toMatchObject({ source: 'region-x-basemap', 'source-layer': 'pois' });
  });

  it('names a town label layer the basemap actually has', () => {
    // peaks.ts and region-layers.ts both anchor to it by id.
    expect(ids).toContain(TOWN_LABEL_LAYER_ID);
  });
});
