import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import { shapeImage, shapePart } from './icon-shapes';
import {
  addLandmarkLayers,
  LANDMARK_KINDS,
  LANDMARK_SHAPES,
  landmarkSwatch,
  landmarksLayers,
  type LandmarkIcon,
} from './landmarks';

/** The [r, g, b, a] of one pixel. */
function pixel(image: ReturnType<typeof shapeImage>, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return Array.from(image.data.slice(at, at + 4));
}

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

const ICONS = Object.keys(LANDMARK_SHAPES) as LandmarkIcon[];

describe('landmark shapes', () => {
  const ink = mapInk('light');

  it('draws each symbol in the landmark ink, haloed in the rim ink, corners clear', () => {
    for (const icon of ICONS) {
      const image = shapeImage(LANDMARK_SHAPES[icon], { glyph: ink.landmark, rim: ink.landmarkRim }, 16);
      const colors = new Set<string>();
      for (let at = 0; at < image.data.length; at += 4) {
        if (image.data[at + 3] === 255) colors.add(Array.from(image.data.slice(at, at + 3)).join(','));
      }
      expect(colors, icon).toContain('43,39,36'); // #2b2724
      expect(colors, icon).toContain('255,255,255');
      expect(pixel(image, 0, 0)[3], icon).toBe(0);
    }
  });

  it('puts the trig dot in the triangle, with halo between it and the outline', () => {
    expect(shapePart(LANDMARK_SHAPES.trig, 16, 19)).toBe('glyph'); // the dot
    expect(shapePart(LANDMARK_SHAPES.trig, 16, 24.5)).toBe('rim'); // between dot and base, inside
    expect(shapePart(LANDMARK_SHAPES.trig, 16, 26.5)).toBe('glyph'); // the base
    expect(shapePart(LANDMARK_SHAPES.trig, 2, 2)).toBe('none');
  });

  it('shows halo between the courses of a cairn', () => {
    expect(shapePart(LANDMARK_SHAPES.cairn, 16.5, 22.5)).toBe('rim');
    expect(shapePart(LANDMARK_SHAPES.cairn, 16, 26)).toBe('glyph');
  });

  it('fills the lighthouse tower solid', () => {
    expect(shapePart(LANDMARK_SHAPES.lighthouse, 16, 20)).toBe('glyph');
  });
});

describe('landmarksLayers', () => {
  const icons = { mast: 'm', trig: 't', cairn: 'c', lighthouse: 'l', turbine: 'w' };
  const layers = landmarksLayers('region-x-landmarks', { minzoom: 9, icons, ink: mapInk('light') });
  const [layer, overlap] = layers;

  it('draws from z13, the archive’s own floor, however low the region allows', () => {
    expect(layer).toMatchObject({
      id: 'region-x-landmarks-symbols',
      type: 'symbol',
      'source-layer': 'landmarks',
      minzoom: 13,
      maxzoom: 14,
    });
  });

  it('lets icons collide below z14 and draws every one from z14 up', () => {
    expect(layers).toHaveLength(2);
    expect(layer.layout!['icon-allow-overlap']).toBeUndefined();
    expect(overlap).toMatchObject({
      id: 'region-x-landmarks-symbols-overlap',
      minzoom: 14,
      layout: { 'icon-allow-overlap': true },
    });
    expect(overlap.maxzoom).toBeUndefined();
    // Names still give way.
    expect(overlap.layout!['text-allow-overlap']).toBeUndefined();
    expect(overlap.layout!['icon-image']).toEqual(layer.layout!['icon-image']);
  });

  it('adds only the overlap layer where the region itself starts at z14 or above', () => {
    const high = landmarksLayers('s', { minzoom: 14, icons, ink: mapInk('light') });
    expect(high.map((l) => [l.id, l.minzoom])).toEqual([['s-symbols-overlap', 14]]);
    expect(landmarksLayers('s', { minzoom: 15, icons, ink: mapInk('light') })[0].minzoom).toBe(15);
    expect(landmarksLayers('s', { minzoom: 13.5, icons, ink: mapInk('light') })[0]).toMatchObject({
      minzoom: 13.5,
      maxzoom: 14,
    });
  });

  it('gives masts and towers one symbol and every other kind its own', () => {
    expect(layer.layout!['icon-image']).toEqual([
      'match',
      ['get', 'kind'],
      'survey_point',
      't',
      'cairn',
      'c',
      'lighthouse',
      'l',
      'wind_turbine',
      'w',
      'm',
    ]);
  });

  it('places trig points first, cairns last, named before unnamed', () => {
    expect(JSON.stringify(layer.layout!['symbol-sort-key'])).toBe(
      JSON.stringify([
        '+',
        ['match', ['get', 'kind'], 'survey_point', 0, 'lighthouse', 1, 'cairn', 3, 2],
        ['case', ['has', 'name'], 0, 4],
      ]),
    );
  });

  it('keeps the symbol when its name has no room', () => {
    expect(layer.layout).toMatchObject({ 'text-optional': true });
  });
});

describe('addLandmarkLayers', () => {
  it('adds both symbol layers before the anchor, with a symbol per icon in the theme’s ink', () => {
    const { map, added, images } = fakeMap();
    addLandmarkLayers(map, 'region-x-landmarks', { minzoom: 9, before: 'region-x-basemap-pois', ink: mapInk('light') });
    expect(added).toHaveLength(2);
    expect(added.map((a) => a.before)).toEqual(['region-x-basemap-pois', 'region-x-basemap-pois']);
    expect([...images.keys()]).toEqual(ICONS.map((icon) => `ratmap-landmark-${icon}-2b2724`));
  });

  it('reuses registered symbols, and draws night ones under their own ids', () => {
    const { map, images } = fakeMap();
    addLandmarkLayers(map, 'a', { minzoom: 9, ink: mapInk('light') });
    addLandmarkLayers(map, 'b', { minzoom: 9, ink: mapInk('light') });
    expect(map.addImage).toHaveBeenCalledTimes(ICONS.length);
    addLandmarkLayers(map, 'c', { minzoom: 9, ink: mapInk('dark') });
    expect(images.size).toBe(ICONS.length * 2);
  });
});

describe('landmarkSwatch', () => {
  it('draws every legend entry in the inks the map uses', () => {
    const ink = mapInk('dark');
    for (const entry of LANDMARK_KINDS) {
      const svg = landmarkSwatch(entry.icon, ink);
      expect(svg).toContain(ink.landmark);
      expect(svg).toContain(ink.landmarkRim);
    }
  });
});
