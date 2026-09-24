import { describe, expect, it } from 'vitest';
import { layers as basemapLayers } from '@protomaps/basemaps';
import { ratmapFlavor } from './flavor';
import { basemapLayersWithBareRock, TOWN_LABEL_LAYER_ID } from './landuse';

describe('basemapLayersWithBareRock', () => {
  const flavor = ratmapFlavor('light');
  const ids = basemapLayersWithBareRock('basemap', flavor, { lang: 'en' }).map((l) => l.id);

  it('adds a bare rock layer directly above the parks', () => {
    // The anchor is looked up by id. If Protomaps ever renamed `landuse_park`, findIndex
    // would return -1 and the rock would land at position 0 — beneath the background,
    // drawn and never seen, with nothing to say so. This is the check that says so.
    expect(ids).toContain('landuse_park');
    expect(ids.indexOf('landuse_bare_rock')).toBe(ids.indexOf('landuse_park') + 1);
  });

  it('only adds that one layer', () => {
    const plain = basemapLayers('basemap', flavor, { lang: 'en' }).map((l) => l.id);
    expect(ids).toEqual([
      ...plain.slice(0, plain.indexOf('landuse_park') + 1),
      'landuse_bare_rock',
      ...plain.slice(plain.indexOf('landuse_park') + 1),
    ]);
  });

  it('draws from the source it is given, so region copies read their own archive', () => {
    const rock = basemapLayersWithBareRock('region-x-basemap', flavor).find(
      (l) => l.id === 'landuse_bare_rock',
    );
    expect(rock).toMatchObject({ source: 'region-x-basemap', 'source-layer': 'landuse' });
  });

  it('names a town label layer the basemap actually has', () => {
    // peaks.ts and region-layers.ts both anchor to it by id.
    expect(ids).toContain(TOWN_LABEL_LAYER_ID);
  });
});
