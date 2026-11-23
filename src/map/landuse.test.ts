import { describe, expect, it } from 'vitest';
import { layers as basemapLayers } from '@protomaps/basemaps';
import type { LayerSpecification } from 'maplibre-gl';
import { ROAD_CLASS_FILL, STREAM_INK, ratmapFlavor } from './flavor';
import {
  isOverGroundLayer,
  OVER_GROUND_FROM_LAYER_ID,
  ratmapBasemapLayers,
  TOWN_LABEL_LAYER_ID,
} from './landuse';
import { contrast, paintValue, styleColor } from '../test-support/paint-value';
import { PROTOMAPS_HUTS_WATER_KINDS } from '../overlays/huts-water';

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

  it('leaves drinking water and every other huts-and-water kind to huts-water.ts', () => {
    // Upstream draws drinking_water itself; kept, every tap would show twice.
    const upstream = basemapLayers('basemap', flavor, { lang: 'en' }).find((l) => l.id === 'pois')!;
    const pois = ratmapBasemapLayers('basemap', 'light', { lang: 'en' }).find((l) => l.id === 'pois')!;
    const filter = (pois as { filter?: unknown }).filter;
    expect(filter).toEqual([
      'all',
      (upstream as { filter?: unknown }).filter,
      ['!', ['in', ['get', 'kind'], ['literal', PROTOMAPS_HUTS_WATER_KINDS]]],
    ]);
    expect(PROTOMAPS_HUTS_WATER_KINDS).toContain('drinking_water');
    // Anchored by id, like the rock: a rename upstream would silently skip the wrap.
    expect(JSON.stringify((upstream as { filter?: unknown }).filter)).toContain('drinking_water');
  });

  it('names a town label layer the basemap actually has', () => {
    // peaks.ts and region-layers.ts both anchor to it by id.
    expect(ids).toContain(TOWN_LABEL_LAYER_ID);
  });

  it('splits the ground from what is built on it at a layer the basemap actually has', () => {
    // Relief and contours go beneath this; a rename upstream would put them under the earth.
    expect(ids).toContain(OVER_GROUND_FROM_LAYER_ID);
    for (const ground of ['earth', 'landcover', 'landuse_park', 'landuse_bare_rock']) {
      expect(isOverGroundLayer(ground), ground).toBe(false);
    }
    for (const built of ['water', 'buildings', 'buildings_outline', 'roads_minor_casing', 'roads_major', 'roads_bridges_major']) {
      expect(isOverGroundLayer(built), built).toBe(true);
    }
    // Labels have their own place, above everything.
    expect(isOverGroundLayer(TOWN_LABEL_LAYER_ID)).toBe(false);
    expect(isOverGroundLayer('roads_labels_minor')).toBe(false);
  });
});

describe('roads', () => {
  const layers = ratmapBasemapLayers('basemap', 'light', { lang: 'en' });
  const paint = (id: string) => (layers.find((l) => l.id === id) as LayerSpecification & { paint: Record<string, unknown> }).paint;
  const at = (id: string, property: string, zoom: number, properties: Record<string, unknown> = {}) =>
    paintValue('line', property, paint(id)[property], zoom, properties);

  it('draws a minor road wide enough to hold its own against the contours', () => {
    // Upstream's 2 px at z15 was a hairline the 10 m contours outdrew.
    expect(at('roads_minor', 'line-width', 15)).toBeCloseTo(3.2);
    expect(at('roads_major', 'line-width', 15)).toBeCloseTo(4.6);
  });

  it('edges each road exactly where its fill ends, bridges and tunnels too', () => {
    for (const [fill, casing] of [
      ['roads_minor', 'roads_minor_casing'],
      ['roads_major', 'roads_major_casing_late'],
      ['roads_highway', 'roads_highway_casing_early'],
      ['roads_bridges_minor', 'roads_bridges_minor_casing'],
      ['roads_tunnels_major', 'roads_tunnels_major_casing'],
      ['roads_minor_service', 'roads_minor_service_casing'],
    ]) {
      for (const zoom of [12, 14, 16]) {
        expect(at(casing, 'line-gap-width', zoom), `${casing} z${zoom}`).toBeCloseTo(
          at(fill, 'line-width', zoom) as number,
        );
      }
    }
  });

  it('colours main roads by class', () => {
    const fill = (kind_detail: string) => at('roads_major', 'line-color', 15, { kind_detail });
    expect(fill('primary')).toEqual(styleColor(ROAD_CLASS_FILL.light.primary));
    expect(fill('trunk')).toEqual(styleColor(ROAD_CLASS_FILL.light.primary));
    expect(fill('secondary')).toEqual(styleColor(ROAD_CLASS_FILL.light.secondary));
    expect(fill('tertiary')).toEqual(styleColor(ratmapFlavor('light').major));
  });

  it('gives roads an edge that holds against the ground, day and night', () => {
    const day = ratmapFlavor('light');
    // Above the 10 m contours' 1.6:1 and the index contours' 2.9:1.
    expect(contrast(day.minor_casing, day.earth)).toBeGreaterThan(4.5);
    expect(contrast(day.major_casing_late, day.earth)).toBeGreaterThan(5.5);
    // At night the fill carries the road: above the index contours' 3.2:1.
    const night = ratmapFlavor('dark');
    expect(contrast(night.minor_a, night.earth)).toBeGreaterThan(4);
    expect(contrast(night.major, night.earth)).toBeGreaterThan(4);
  });

  it('draws streams in an ink that holds against the ground, and rivers in it until they fill', () => {
    // The water fill is near the ground's own tone: a stream drawn in it was 1.1–1.5:1,
    // gone on the open hill, which is where a stream is a navigation feature.
    for (const theme of ['light', 'dark'] as const) {
      const layers = ratmapBasemapLayers('basemap', theme, { lang: 'en' });
      const stream = layers.find((l) => l.id === 'water_stream')!;
      expect(paintValue('line', 'line-color', stream.paint!['line-color' as never], 14)).toEqual(
        styleColor(STREAM_INK[theme]),
      );
      expect(paintValue('line', 'line-width', stream.paint!['line-width' as never], 14)).toBe(1);

      const river = layers.find((l) => l.id === 'water_river')!;
      expect(paintValue('line', 'line-color', river.paint!['line-color' as never], 12)).toEqual(
        styleColor(STREAM_INK[theme]),
      );

      const flavor = ratmapFlavor(theme);
      for (const ground of [flavor.earth, flavor.wood_a, flavor.park_a]) {
        expect(contrast(STREAM_INK[theme], ground!)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
