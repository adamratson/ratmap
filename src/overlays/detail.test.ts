import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import { shapePart } from './icon-shapes';
import { addDetailLayers, DETAIL_LEGEND, DETAIL_SHAPES, detailSwatch } from './detail';

function addTo(minzoom: number, theme: 'light' | 'dark' = 'light') {
  const added: Array<{ layer: Record<string, unknown>; before?: string }> = [];
  const images = new Map<string, unknown>();
  const map = {
    addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })),
    hasImage: vi.fn((id: string) => images.has(id)),
    addImage: vi.fn((id: string, image: unknown) => images.set(id, image)),
  } as unknown as MLMap;
  addDetailLayers(map, 'region-x-detail', {
    minzoom,
    beforeLines: 'paths-casing',
    beforeSymbols: 'pois',
    ink: mapInk(theme),
  });
  const byId: Record<string, Record<string, unknown>> = Object.fromEntries(
    added.map(({ layer, before }) => [layer.id as string, { ...layer, before }]),
  );
  return { added, byId, images, map };
}

describe('addDetailLayers', () => {
  it('draws the lines under the paths and the symbols over them, power above walls', () => {
    const { added } = addTo(9);
    expect(added.map(({ layer, before }) => [layer.id, layer.type, before])).toEqual([
      ['region-x-detail-fences', 'line', 'paths-casing'],
      ['region-x-detail-walls', 'line', 'paths-casing'],
      ['region-x-detail-power-lines', 'line', 'paths-casing'],
      ['region-x-detail-pylons', 'circle', 'paths-casing'],
      ['region-x-detail-gates', 'symbol', 'pois'],
      ['region-x-detail-fords', 'symbol', 'pois'],
    ]);
  });

  it('starts each layer at the zoom its kinds first appear in the tiles', () => {
    const { byId } = addTo(9);
    expect(byId['region-x-detail-power-lines'].minzoom).toBe(12);
    expect(byId['region-x-detail-walls'].minzoom).toBe(14);
    expect(byId['region-x-detail-fences'].minzoom).toBe(14);
    expect(byId['region-x-detail-fords'].minzoom).toBe(14);
    expect(byId['region-x-detail-pylons'].minzoom).toBe(15);
    expect(byId['region-x-detail-gates'].minzoom).toBe(15);
    // And never below the region's own floor.
    expect(addTo(13).byId['region-x-detail-power-lines'].minzoom).toBe(13);
  });

  it('dashes fences and leaves walls solid', () => {
    const { byId } = addTo(9);
    expect((byId['region-x-detail-fences'].paint as Record<string, unknown>)['line-dasharray']).toBeDefined();
    expect((byId['region-x-detail-walls'].paint as Record<string, unknown>)['line-dasharray']).toBeUndefined();
  });

  it('never hides a gate behind a label, nor lets one push a label aside', () => {
    expect(addTo(9).byId['region-x-detail-gates'].layout).toMatchObject({
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    });
  });

  it('gives gates, stiles and cattle grids their own symbols, the ford its blue one', () => {
    const { byId, images } = addTo(9);
    expect([...images.keys()]).toEqual([
      'ratmap-detail-gate-2b2724',
      'ratmap-detail-stile-2b2724',
      'ratmap-detail-cattle_grid-2b2724',
      'ratmap-detail-ford-2f6b86',
    ]);
    expect((byId['region-x-detail-gates'].layout as Record<string, unknown>)['icon-image']).toEqual([
      'match',
      ['get', 'kind'],
      'stile',
      'ratmap-detail-stile-2b2724',
      'cattle_grid',
      'ratmap-detail-cattle_grid-2b2724',
      'ratmap-detail-gate-2b2724',
    ]);
  });

  it('registers night symbols under their own ids', () => {
    const light = addTo(9, 'light');
    const dark = addTo(9, 'dark');
    expect([...light.images.keys()]).not.toEqual([...dark.images.keys()]);
  });
});

describe('detail shapes', () => {
  it('haloes a gate inside its frame, and keeps a ford’s two waves apart', () => {
    expect(shapePart(DETAIL_SHAPES.gate, 6, 16)).toBe('glyph'); // the post
    expect(shapePart(DETAIL_SHAPES.gate, 22, 19)).toBe('rim'); // between the rails, under the brace
    expect(shapePart(DETAIL_SHAPES.ford, 16, 14.5)).toBe('rim'); // just under the first wave
    expect(shapePart(DETAIL_SHAPES.ford, 16, 17)).toBe('none'); // clear between them
  });
});

describe('DETAIL_LEGEND', () => {
  it('draws every entry in the inks the map uses', () => {
    const ink = mapInk('dark');
    const svgs = DETAIL_LEGEND.map((entry) => entry.swatch(ink)).join('');
    expect(svgs).toContain(ink.boundary);
    expect(svgs).toContain(ink.power);
    expect(detailSwatch('ford', ink)).toContain(ink.ford);
  });
});
