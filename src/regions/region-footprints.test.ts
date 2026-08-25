import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import {
  FOOTPRINT_FILL_LAYER_ID,
  FOOTPRINT_LINE_LAYER_ID,
  FOOTPRINT_SOURCE_ID,
  footprintCollection,
  regionAt,
  removeFootprints,
  renderFootprints,
  visibleFootprints,
  type Footprint,
} from './region-footprints';
import type { Region } from './manifest';

const region = (id: string, bbox: Region['bbox']): Region =>
  ({ id, name: id, bbox, totalBytes: 1, artifacts: [] }) as unknown as Region;

// Lochaber sits inside Scotland — the catalogue really does nest like this.
const SCOTLAND = region('scotland', [-8.7, 54.6, -0.7, 61.0]);
const LOCHABER = region('lochaber', [-5.6, 56.5, -4.6, 57.1]);
const MONTENEGRO = region('montenegro', [18.4, 41.8, 20.4, 43.6]);

const ALL: Footprint[] = [
  { region: SCOTLAND, downloaded: false },
  { region: LOCHABER, downloaded: false },
  { region: MONTENEGRO, downloaded: true },
];

const BEN_NEVIS: [number, number] = [-5.0037, 56.7969];

describe('regionAt', () => {
  it('offers the smallest region covering the point', () => {
    // Both Scotland and Lochaber contain Ben Nevis. Lochaber is the useful answer and the
    // far cheaper download.
    expect(regionAt(ALL, BEN_NEVIS)?.id).toBe('lochaber');
  });

  it('returns nothing where the catalogue has no coverage', () => {
    expect(regionAt(ALL, [2.35, 48.86])).toBeNull();
  });

  it('can be asked only for regions that are not downloaded yet', () => {
    // Which is what the "limited detail here" notice needs: something to offer.
    expect(regionAt(ALL, [19.0, 42.5], { downloaded: false })).toBeNull();
    expect(regionAt(ALL, [19.0, 42.5], { downloaded: true })?.id).toBe('montenegro');
  });

  it('includes the boundary, so an edge case is covered rather than uncovered', () => {
    expect(regionAt([{ region: LOCHABER, downloaded: false }], [-5.6, 56.5])?.id).toBe('lochaber');
  });
});

describe('footprintCollection', () => {
  it('closes each ring, as GeoJSON requires', () => {
    const feature = footprintCollection([{ region: LOCHABER, downloaded: false }]).features[0];
    const ring = (feature.geometry as { coordinates: number[][][] }).coordinates[0];

    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it('carries download state on the feature, so the style can key off it', () => {
    const features = footprintCollection(ALL).features;
    expect(features.map((f) => f.properties?.downloaded)).toEqual([false, false, true]);
    expect(features.map((f) => f.properties?.name)).toEqual([
      'scotland',
      'lochaber',
      'montenegro',
    ]);
  });
});

function mapStub() {
  const sources = new Map<string, { type: string; setData: ReturnType<typeof vi.fn> }>();
  const layers = new Map<string, { id: string; paint?: Record<string, unknown> }>();
  return {
    map: {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: { type: string }) =>
        sources.set(id, { type: spec.type, setData: vi.fn() }),
      removeSource: (id: string) => sources.delete(id),
      addLayer: (layer: { id: string; paint?: Record<string, unknown> }) =>
        layers.set(layer.id, layer),
      getLayer: (id: string) => layers.get(id),
      removeLayer: (id: string) => layers.delete(id),
    } as unknown as MLMap,
    sources,
    layers,
  };
}

describe('renderFootprints', () => {
  it('adds the coverage layers once', () => {
    const { map, sources, layers } = mapStub();
    renderFootprints(map, ALL);

    expect(sources.has(FOOTPRINT_SOURCE_ID)).toBe(true);
    expect(layers.has(FOOTPRINT_FILL_LAYER_ID)).toBe(true);
    expect(layers.has(FOOTPRINT_LINE_LAYER_ID)).toBe(true);
  });

  it('updates in place rather than stacking a second copy', () => {
    // Called again every time a download finishes or a region is deleted.
    const { map, sources, layers } = mapStub();
    renderFootprints(map, ALL);
    const before = layers.size;

    renderFootprints(map, [{ region: LOCHABER, downloaded: true }]);

    expect(layers.size).toBe(before);
    expect(sources.get(FOOTPRINT_SOURCE_ID)!.setData).toHaveBeenCalledOnce();
  });

  it('distinguishes downloaded from available by more than colour', () => {
    // Read in sunlight, on a screen at low brightness, by someone who may be
    // colour-blind — so the dash pattern carries the difference too.
    const { map, layers } = mapStub();
    renderFootprints(map, ALL);

    const line = layers.get(FOOTPRINT_LINE_LAYER_ID)!;
    expect(JSON.stringify(line.paint!['line-dasharray'])).toContain('downloaded');
    expect(JSON.stringify(line.paint!['line-color'])).toContain('downloaded');
  });

  it('takes itself back off cleanly', () => {
    const { map, sources, layers } = mapStub();
    renderFootprints(map, ALL);
    removeFootprints(map);

    expect(sources.size).toBe(0);
    expect(layers.size).toBe(0);
  });
});

describe('what gets outlined once the catalogue covers the globe', () => {
  const catalogue: Footprint[] = [
    { region: LOCHABER, downloaded: true },
    { region: region('cairngorms', [-4.4, 56.8, -2.8, 57.4]), downloaded: false },
    { region: region('greenland', [-73, 59, -12, 84]), downloaded: false },
  ];

  it('draws what is on the device and what is being offered, and nothing else', () => {
    // A global catalogue outlined in full is a tint over every pixel of the map, which
    // says nothing: everywhere is available.
    const drawn = visibleFootprints(catalogue, 'cairngorms').map((f) => f.region.id);

    expect(drawn).toEqual(['lochaber', 'cairngorms']);
  });

  it('draws only downloaded regions when nothing is being offered', () => {
    expect(visibleFootprints(catalogue, null).map((f) => f.region.id)).toEqual(['lochaber']);
  });
});
