import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import { shapeImage, shapePart } from './icon-shapes';
import {
  addHutsWaterLayer,
  HUTS_WATER_LEGEND,
  HUTS_WATER_SHAPES,
  hutsWaterLayer,
  hutsWaterSwatch,
  type HutsWaterIcon,
} from './huts-water';

function fakeMap() {
  const added: Array<{ layer: Record<string, unknown>; before?: string }> = [];
  const images = new Map<string, unknown>();
  const map = {
    addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })),
    hasImage: vi.fn((id: string) => images.has(id)),
    addImage: vi.fn((id: string, image: unknown) => images.set(id, image)),
  } as unknown as MLMap;
  return { map, added, images };
}

const ICONS = Object.keys(HUTS_WATER_SHAPES) as HutsWaterIcon[];

describe('huts and water shapes', () => {
  const ink = mapInk('light');

  it('draws huts in the landmark ink and water in the ford blue, haloed, corners clear', () => {
    for (const icon of ICONS) {
      const water = icon === 'water' || icon === 'spring';
      const image = shapeImage(
        HUTS_WATER_SHAPES[icon],
        { glyph: water ? ink.ford : ink.landmark, rim: ink.landmarkRim },
        16,
      );
      const colors = new Set<string>();
      for (let at = 0; at < image.data.length; at += 4) {
        if (image.data[at + 3] === 255) colors.add(Array.from(image.data.slice(at, at + 3)).join(','));
      }
      expect(colors, icon).toContain(water ? '47,107,134' : '43,39,36'); // #2f6b86 / #2b2724
      expect(colors, icon).toContain('255,255,255');
      expect(image.data[3], icon).toBe(0);
    }
  });

  it('tells a hut from a shelter: solid walls against an open roof on posts', () => {
    expect(shapePart(HUTS_WATER_SHAPES.hut, 16, 22)).toBe('glyph');
    expect(shapePart(HUTS_WATER_SHAPES.shelter, 16, 22)).toBe('none');
    expect(shapePart(HUTS_WATER_SHAPES.shelter, 8, 22)).toBe('glyph'); // a post
  });

  it('tells drinking water from a spring: a spring rises from a ground line', () => {
    expect(shapePart(HUTS_WATER_SHAPES.water, 16, 20)).toBe('glyph');
    expect(shapePart(HUTS_WATER_SHAPES.spring, 16, 26)).toBe('glyph');
    expect(shapePart(HUTS_WATER_SHAPES.water, 4.5, 26)).toBe('none');
  });

  it('shows the tent door as a dark triangle inside a haloed tent', () => {
    expect(shapePart(HUTS_WATER_SHAPES.campsite, 16, 24)).toBe('glyph'); // the door
    expect(shapePart(HUTS_WATER_SHAPES.campsite, 9, 24)).toBe('rim'); // the tent's side
  });
});

describe('hutsWaterLayer', () => {
  const icons = { hut: 'h', shelter: 's', campsite: 'c', water: 'w', spring: 'p' };
  const layer = hutsWaterLayer('region-z13-15-huts', { minzoom: 9, icons, ink: mapInk('light') });

  it('reads the huts archive, from z13, its own floor, however low the region allows', () => {
    expect(layer).toMatchObject({
      id: 'region-z13-15-huts-symbols',
      type: 'symbol',
      source: 'region-z13-15-huts',
      'source-layer': 'huts',
      minzoom: 13,
    });
    expect(layer.filter).toBeUndefined();
    expect(hutsWaterLayer('s', { minzoom: 14, icons, ink: mapInk('light') }).minzoom).toBe(14);
  });

  it('gives each of the artifact’s kinds its own symbol', () => {
    expect(layer.layout!['icon-image']).toEqual([
      'match',
      ['get', 'kind'],
      'shelter',
      's',
      'campsite',
      'c',
      'water',
      'w',
      'spring',
      'p',
      'h',
    ]);
  });

  it('places huts first and campsites last, named before unnamed', () => {
    expect(JSON.stringify(layer.layout!['symbol-sort-key'])).toBe(
      JSON.stringify([
        '+',
        ['match', ['get', 'kind'], 'hut', 0, 'shelter', 1, 'water', 2, 'spring', 3, 4],
        ['case', ['has', 'name'], 0, 5],
      ]),
    );
  });

  it('names from z15 and keeps the symbol when its name has no room', () => {
    expect(layer.layout).toMatchObject({ 'text-optional': true });
    expect(layer.layout!['text-field']).toEqual(['step', ['zoom'], '', 15, ['coalesce', ['get', 'name'], '']]);
  });
});

describe('addHutsWaterLayer', () => {
  it('adds the layer before the anchor, with a symbol per icon in the theme’s ink', () => {
    const { map, added, images } = fakeMap();
    addHutsWaterLayer(map, 'region-x-huts', { minzoom: 9, before: 'region-x-basemap-pois-next', ink: mapInk('light') });
    expect(added).toHaveLength(1);
    expect(added[0].before).toBe('region-x-basemap-pois-next');
    expect(images.size).toBe(ICONS.length);
  });

  it('reuses registered symbols, and draws night ones under their own ids', () => {
    const { map, images } = fakeMap();
    addHutsWaterLayer(map, 'a', { minzoom: 9, ink: mapInk('light') });
    addHutsWaterLayer(map, 'b', { minzoom: 9, ink: mapInk('light') });
    expect(map.addImage).toHaveBeenCalledTimes(ICONS.length);
    addHutsWaterLayer(map, 'c', { minzoom: 9, ink: mapInk('dark') });
    expect(images.size).toBe(ICONS.length * 2);
  });
});

describe('hutsWaterSwatch', () => {
  it('has a legend entry per symbol, each drawn in the inks the map uses', () => {
    const ink = mapInk('dark');
    expect(HUTS_WATER_LEGEND.map((e) => e.icon).sort()).toEqual([...ICONS].sort());
    for (const entry of HUTS_WATER_LEGEND) {
      const svg = hutsWaterSwatch(entry.icon, ink);
      expect(svg).toContain(entry.icon === 'water' || entry.icon === 'spring' ? ink.ford : ink.landmark);
      expect(svg).toContain(ink.landmarkRim);
    }
  });
});
