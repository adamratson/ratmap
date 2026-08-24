import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';
import type { TileSourceRegistry } from '../tile-source-registry';

const getArtifactFileMock = vi.hoisted(() => vi.fn());
vi.mock('./opfs-store', () => ({ getArtifactFile: getArtifactFileMock }));

const { addRegionToMap, removeRegionFromMap, regionSourceId } = await import('./region-layers');

const region: Region = {
  id: 'lochaber',
  name: 'Lochaber & Ben Nevis',
  bbox: [-5.6, 56.5, -4.6, 57.1],
  totalBytes: 44_149_615,
  artifacts: [
    { kind: 'basemap', filename: 'lochaber-basemap.pmtiles', path: 'p1', bytes: 1 },
    { kind: 'terrain', filename: 'lochaber-terrain.pmtiles', path: 'p2', bytes: 1 },
    { kind: 'contours', filename: 'lochaber-contours.pmtiles', path: 'p3', bytes: 1 },
  ],
};

function fakeMap() {
  const layers: Array<Record<string, unknown>> = [];
  const sources = new Set<string>();
  return {
    layers,
    sources,
    addSource: vi.fn((id: string) => void sources.add(id)),
    getSource: vi.fn((id: string) => (sources.has(id) ? {} : undefined)),
    removeSource: vi.fn((id: string) => void sources.delete(id)),
    // Honours beforeId, because layer *order* is the thing several of these tests are
    // actually asserting on — a fake that always appends would make them meaningless.
    addLayer: vi.fn((layer: Record<string, unknown>, beforeId?: string) => {
      const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (at >= 0) layers.splice(at, 0, layer);
      else layers.push(layer);
    }),
    getLayer: vi.fn((id: string) => layers.find((l) => l.id === id)),
    removeLayer: vi.fn((id: string) => {
      const i = layers.findIndex((l) => l.id === id);
      if (i >= 0) layers.splice(i, 1);
    }),
    getStyle: vi.fn(() => ({ layers })),
  };
}

const registry = {
  addLocal: vi.fn(),
  sourceUrl: (key: string) => `pmtiles://${key}`,
} as unknown as TileSourceRegistry;

beforeEach(() => {
  getArtifactFileMock.mockReset();
  getArtifactFileMock.mockImplementation(async (name: string) => new File([new Uint8Array(4)], name));
  // Shared across tests, so call counts accumulate without this.
  vi.mocked(registry.addLocal).mockClear();
});

describe('addRegionToMap', () => {
  it('never adds a background layer for a region', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    // Protomaps' layers() emits a viewport-filling `background` layer. Copying it per
    // region painted flat grey over the entire global map, leaving only the downloaded
    // area visible. A style needs exactly one background, from the global basemap.
    const backgrounds = map.layers.filter((l) => l.type === 'background');
    expect(backgrounds).toEqual([]);
  });

  it('only adds layers bound to the region source', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    for (const layer of map.layers) {
      expect(layer.source).toBeTruthy();
      expect(String(layer.source)).toMatch(/^region-lochaber-/);
    }
  });

  it('registers each artifact with the tile registry under its unique filename (C3)', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    expect(registry.addLocal).toHaveBeenCalledTimes(3);
    expect(map.addSource).toHaveBeenCalledWith(
      regionSourceId('lochaber', 'terrain'),
      expect.objectContaining({ type: 'raster-dem', encoding: 'terrarium' }),
    );
  });

  it('puts relief and contours beneath the region labels, not over them', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    const ids = map.layers.map((l) => String(l.id));
    const firstRegionLabel = map.layers.findIndex(
      (l) => l.type === 'symbol' && String(l.id).startsWith('region-lochaber-'),
    );
    expect(firstRegionLabel).toBeGreaterThan(-1);

    // Regression: everything was inserted at the peaks layer, which stacks each artifact
    // on top of the previous one — so the hillshade ended up over the basemap's own
    // labels and washed out gully and corrie names.
    for (const id of ['region-lochaber-terrain-hillshade', 'region-lochaber-contours-lines']) {
      expect(ids.indexOf(id)).toBeGreaterThan(-1);
      expect(ids.indexOf(id)).toBeLessThan(firstRegionLabel);
    }
  });

  it('emphasises index contours using the attribute the pipeline actually emits', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    const contours = map.layers.find((l) => String(l.id).endsWith('contours-lines'))!;
    const width = JSON.stringify((contours.paint as Record<string, unknown>)['line-width']);

    // build-contours.sh tags via SQLite, which yields integer 0/1 under the alias `idx`.
    // Reading `index`/`true` matched neither the name nor the type, so every contour
    // silently drew thin and the index emphasis never appeared.
    expect(width).toContain('idx');
    expect(width).not.toContain('index');
    expect(width).not.toContain('true');
  });

  it('draws paths visibly, rather than leaving them as the near-invisible default', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    const paths = map.layers.find((l) => String(l.id).endsWith('-paths'));
    const casing = map.layers.find((l) => String(l.id).endsWith('-paths-casing'));
    expect(paths).toBeDefined();
    expect(casing).toBeDefined();

    // Protomaps' light flavour draws paths as a 0.5 px #ebebeb hairline — near-white on
    // near-white. On a walking map the paths are the most important feature on the sheet.
    const color = String((paths!.paint as Record<string, unknown>)['line-color']);
    expect(color.toLowerCase()).not.toBe('#ebebeb');

    // Casing must sit under the line it outlines.
    const ids = map.layers.map((l) => String(l.id));
    expect(ids.indexOf(String(casing!.id))).toBeLessThan(ids.indexOf(String(paths!.id)));
  });

  it('filters paths on the attribute the Protomaps schema actually uses', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    const paths = map.layers.find((l) => String(l.id).endsWith('-paths'))!;
    // Verified by decoding a real tile: paths are kind="path" in the `roads` layer, with
    // kind_detail distinguishing track/footway/steps.
    expect(paths['source-layer']).toBe('roads');
    expect(JSON.stringify(paths.filter)).toContain('path');
  });

  it('annotates index contours with their height, and only the index ones', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    const labels = map.layers.find((l) => String(l.id).endsWith('contours-labels'));
    expect(labels).toBeDefined();

    const layout = labels!.layout as Record<string, unknown>;
    // Placed along the line and rotated with it, the way a contour label reads on paper.
    expect(layout['symbol-placement']).toBe('line');
    // Labelling all contours at a 10 m interval would be 5x the text for no extra
    // information — the intermediate lines are read by counting from an annotated one.
    expect(JSON.stringify(labels!.filter)).toContain('idx');

    // A halo stands in for breaking the line behind the digits, which MapLibre can't do.
    const paint = labels!.paint as Record<string, unknown>;
    expect(Number(paint['text-halo-width'])).toBeGreaterThan(0);
  });

  it('keeps contour labels below the region place labels', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    const ids = map.layers.map((l) => String(l.id));
    const firstRegionLabel = map.layers.findIndex(
      (l) => l.type === 'symbol' && String(l.id).startsWith('region-lochaber-basemap-'),
    );
    expect(firstRegionLabel).toBeGreaterThan(-1);
    expect(ids.indexOf('region-lochaber-contours-labels')).toBeLessThan(firstRegionLabel);
  });

  it('does not draw the region at zooms where its tiles cover a continent', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    // `pmtiles extract --bbox` keeps whole upstream tiles instead of re-clipping them, so
    // a region's low-zoom tiles are planet tiles that merely intersect it. Montenegro's z5
    // basemap tile spans Vienna to Athens; drawing it painted that rectangle over Romania
    // and Bulgaria. Lochaber is 1.0 deg wide, so its tiles stop out-sizing it at z9.
    for (const layer of map.layers) {
      expect(Number(layer.minzoom)).toBeGreaterThanOrEqual(9);
    }
  });

  it('scales the cutoff to the region, rather than assuming one size', async () => {
    const map = fakeMap();
    // Scotland spans 8 deg — its tiles are region-sized three zoom levels earlier than
    // Lochaber's, and holding it back to Lochaber's cutoff would hide detail it has.
    const scotland: Region = { ...region, id: 'scotland', bbox: [-8.7, 54.6, -0.7, 61.0] };

    await addRegionToMap(map as unknown as MLMap, registry, scotland);

    const hillshade = map.layers.find((l) => String(l.id).endsWith('terrain-hillshade'))!;
    expect(hillshade.minzoom).toBe(6);
  });

  it('skips artifacts that are not actually in OPFS yet', async () => {
    getArtifactFileMock.mockImplementation(async (name: string) =>
      name.includes('contours') ? null : new File([new Uint8Array(4)], name),
    );
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);

    expect(map.sources.has(regionSourceId('lochaber', 'contours'))).toBe(false);
    expect(map.sources.has(regionSourceId('lochaber', 'basemap'))).toBe(true);
  });

  it('is idempotent — a second call does not duplicate sources', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region);
    const afterFirst = map.layers.length;
    await addRegionToMap(map as unknown as MLMap, registry, region);

    expect(map.layers.length).toBe(afterFirst);
  });
});

describe('removeRegionFromMap', () => {
  it('removes every layer and source the region added', async () => {
    const map = fakeMap();
    await addRegionToMap(map as unknown as MLMap, registry, region);
    expect(map.layers.length).toBeGreaterThan(0);

    removeRegionFromMap(map as unknown as MLMap, region);

    expect(map.layers).toEqual([]);
    expect([...map.sources]).toEqual([]);
  });
});
