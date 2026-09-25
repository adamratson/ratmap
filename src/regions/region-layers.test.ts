import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import { mapInk, ratmapFlavor } from '../map/flavor';
import { paintValue, styleColor } from '../test-support/paint-value';

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
    setLayoutProperty: vi.fn((id: string, name: string, value: unknown) => {
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.layout = { ...(layer.layout as object | undefined), [name]: value };
    }),
    removeLayer: vi.fn((id: string) => {
      const i = layers.findIndex((l) => l.id === id);
      if (i >= 0) layers.splice(i, 1);
    }),
    getStyle: vi.fn(() => ({ layers })),
    getLayersOrder: vi.fn(() => layers.map((l) => String(l.id))),
  };
}

const registry = {
  addLocal: vi.fn(),
  addRegionalCopy: vi.fn(() => false),
  removeLocal: vi.fn(),
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

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    // Protomaps' layers() emits a viewport-filling `background` layer. Copying it per
    // region painted flat grey over the entire global map, leaving only the downloaded
    // area visible. A style needs exactly one background, from the global basemap.
    const backgrounds = map.layers.filter((l) => l.type === 'background');
    expect(backgrounds).toEqual([]);
  });

  it("draws a region in the current theme's flavour, not always the light one", async () => {
    // A regression: this was hardcoded to namedFlavor('light'), so a downloaded region
    // drew as a light patch on the dark map.
    const earthColour = async (theme: 'light' | 'dark') => {
      const map = fakeMap();
      await addRegionToMap(map as unknown as MLMap, registry, region, theme);
      const earth = map.layers.find((l) => String(l.id) === 'region-lochaber-basemap-earth');
      return (earth?.paint as Record<string, unknown> | undefined)?.['fill-color'];
    };

    expect(await earthColour('dark')).toBe(ratmapFlavor('dark').earth);
    expect(await earthColour('light')).toBe(ratmapFlavor('light').earth);
    expect(await earthColour('dark')).not.toBe(await earthColour('light'));
  });

  it('only adds layers bound to the region source', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    for (const layer of map.layers) {
      expect(layer.source).toBeTruthy();
      expect(String(layer.source)).toMatch(/^region-lochaber-/);
    }
  });

  it('registers each artifact with the tile registry under its unique filename (C3)', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    expect(registry.addLocal).toHaveBeenCalledTimes(3);
    expect(map.addSource).toHaveBeenCalledWith(
      regionSourceId('lochaber', 'terrain'),
      expect.objectContaining({ type: 'raster-dem', encoding: 'terrarium' }),
    );
  });

  it('puts relief and contours beneath the region labels, not over them', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

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

  it("puts the region's own town labels ahead of peaks in collision priority", async () => {
    // MapLibre gives placement priority to whatever's later in layer order (see peaks.ts).
    // A downloaded region carries its own copy of places_locality (the Lake District's
    // real Keswick/Penrith-level detail), but it was being inserted at PEAKS_LAYER_ID
    // alongside every other region layer — landing *before* peaks-symbol in order, so the
    // fells still won every collision even once real town data was on the map.
    const map = fakeMap();
    // Peaks already sits directly beneath the global catalog's own town labels (peaks.ts).
    map.layers.push(
      { id: 'peaks-symbol', type: 'symbol' },
      { id: 'places_locality', type: 'symbol' },
    );

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const ids = map.layers.map((l) => String(l.id));
    const peaksIdx = ids.indexOf('peaks-symbol');
    const regionTownLabelIdx = ids.indexOf('region-lochaber-basemap-places_locality');
    const regionRoadsIdx = ids.indexOf('region-lochaber-basemap-roads_minor');

    expect(peaksIdx).toBeGreaterThan(-1);
    expect(regionTownLabelIdx).toBeGreaterThan(-1);
    // Higher index = later = placed first = wins collision — the region's town labels
    // must outrank peaks, exactly like the catalog's do.
    expect(regionTownLabelIdx).toBeGreaterThan(peaksIdx);
    // Everything else in the region's basemap (roads, fills, ...) is unaffected — still
    // stacked beneath peaks as before.
    if (regionRoadsIdx > -1) expect(regionRoadsIdx).toBeLessThan(peaksIdx);
  });

  it('comes out with an overlay hidden when the Layers tab has it switched off', async () => {
    // A region restored at startup, or finishing a download, while contours are off must
    // not quietly switch them back on.
    const stored = new Map([['ratmap:visible-layers', JSON.stringify({ contours: false })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
    try {
      const map = fakeMap();

      await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

      const visibilityOf = (id: string) =>
        (map.layers.find((l) => l.id === id)?.layout as Record<string, unknown> | undefined)
          ?.visibility;
      for (const id of [
        'region-lochaber-contours-lines-index',
        'region-lochaber-contours-lines',
        'region-lochaber-contours-labels',
      ]) {
        expect(visibilityOf(id), id).toBe('none');
      }
      expect(visibilityOf('region-lochaber-terrain-hillshade')).toBe('visible');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('emphasises index contours using the attribute the pipeline actually emits', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const contours = map.layers.find((l) => String(l.id).endsWith('contours-lines'))!;
    const width = JSON.stringify((contours.paint as Record<string, unknown>)['line-width']);

    // build-contours.sh tags via SQLite, which yields integer 0/1 under the alias `idx`.
    // Reading `index`/`true` matched neither the name nor the type, so every contour
    // silently drew thin and the index emphasis never appeared.
    expect(width).toContain('idx');
    expect(width).not.toContain('index');
    expect(width).not.toContain('true');
  });

  it('draws index contours in their own ink, and brings the z11-13 preview up to it', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const map = fakeMap();
      await addRegionToMap(map as unknown as MLMap, registry, region, theme);
      const ink = mapInk(theme);
      const paint = (suffix: string) =>
        map.layers.find((l) => String(l.id).endsWith(suffix))!.paint as Record<string, unknown>;
      const lines = paint('contours-lines');
      const preview = paint('contours-lines-index');

      const colour = (idx: number) => paintValue('line', 'line-color', lines['line-color'], 14, { idx });
      expect(colour(1)).toEqual(styleColor(ink.contourIndex));
      expect(colour(0)).toEqual(styleColor(ink.contour));

      // No step at z13, where the all-contours layer takes over from the preview.
      expect(paintValue('line', 'line-color', preview['line-color'], 12)).toEqual(
        styleColor(ink.contourIndex),
      );
      expect(paintValue('line', 'line-opacity', preview['line-opacity'], 13)).toBe(1);
      expect(paintValue('line', 'line-width', preview['line-width'], 13)).toBe(
        paintValue('line', 'line-width', lines['line-width'], 13, { idx: 1 }),
      );
      // Fainter further out, where these lines sit so close they become a texture.
      expect(paintValue('line', 'line-opacity', preview['line-opacity'], 11)).toBeLessThan(0.5);
    }
  });

  it('draws paths visibly, rather than leaving them as the near-invisible default', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

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

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const paths = map.layers.find((l) => String(l.id).endsWith('-paths'))!;
    // Verified by decoding a real tile: paths are kind="path" in the `roads` layer, with
    // kind_detail distinguishing track/footway/steps.
    expect(paths['source-layer']).toBe('roads');
    expect(JSON.stringify(paths.filter)).toContain('path');
  });

  it('annotates index contours with their height, and only the index ones', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

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

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const ids = map.layers.map((l) => String(l.id));
    const firstRegionLabel = map.layers.findIndex(
      (l) => l.type === 'symbol' && String(l.id).startsWith('region-lochaber-basemap-'),
    );
    expect(firstRegionLabel).toBeGreaterThan(-1);
    expect(ids.indexOf('region-lochaber-contours-labels')).toBeLessThan(firstRegionLabel);
  });

  it('does not draw the region at zooms where its tiles cover a continent', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

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

    await addRegionToMap(map as unknown as MLMap, registry, scotland, 'light');

    const hillshade = map.layers.find((l) => String(l.id).endsWith('terrain-hillshade'))!;
    expect(hillshade.minzoom).toBe(6);
  });

  it('skips artifacts that are not actually in OPFS yet', async () => {
    getArtifactFileMock.mockImplementation(async (name: string) =>
      name.includes('contours') ? null : new File([new Uint8Array(4)], name),
    );
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    expect(map.sources.has(regionSourceId('lochaber', 'contours'))).toBe(false);
    expect(map.sources.has(regionSourceId('lochaber', 'basemap'))).toBe(true);
  });

  it('is idempotent — a second call does not duplicate sources', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');
    const afterFirst = map.layers.length;
    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    expect(map.layers.length).toBe(afterFirst);
  });
});

describe('removeRegionFromMap', () => {
  it('removes every layer and source the region added', async () => {
    const map = fakeMap();
    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');
    expect(map.layers.length).toBeGreaterThan(0);

    vi.mocked(registry.removeLocal).mockClear();
    removeRegionFromMap(map as unknown as MLMap, registry, region);

    expect(map.layers).toEqual([]);
    expect([...map.sources]).toEqual([]);
    // Its files are about to be deleted, so its archives must not outlive them.
    expect(vi.mocked(registry.removeLocal).mock.calls.map(([f]) => f)).toEqual(
      region.artifacts.map((a) => a.filename),
    );
  });

  it('leaves a region whose id merely starts with the removed one', async () => {
    // Real catalogue pairs: england-east / england-east-midlands, sachsen / sachsen-anhalt.
    // Matching layers by `region-england-east-` stripped the Midlands too, sources left
    // behind, so it went blank until a reload.
    const regionOf = (id: string): Region => ({
      ...region,
      id,
      artifacts: region.artifacts.map((a) => ({ ...a, filename: `${id}-${a.kind}.pmtiles` })),
    });
    const east = regionOf('england-east');
    const midlands = regionOf('england-east-midlands');

    const map = fakeMap();
    await addRegionToMap(map as unknown as MLMap, registry, east, 'light');
    await addRegionToMap(map as unknown as MLMap, registry, midlands, 'light');
    const midlandsLayers = map.layers.filter((l) =>
      String(l.id).startsWith('region-england-east-midlands-'),
    );
    expect(midlandsLayers.length).toBeGreaterThan(0);

    removeRegionFromMap(map as unknown as MLMap, registry, east);

    expect(map.layers).toEqual(midlandsLayers);
    expect([...map.sources].every((s) => s.startsWith('region-england-east-midlands-'))).toBe(true);
  });
});

describe('the low-zoom path network', () => {
  const pathsArtifact = { kind: 'paths', filename: 'lochaber-paths.pmtiles', path: 'p5', bytes: 1 };
  const withPaths: Region = { ...region, artifacts: [...region.artifacts, pathsArtifact] };

  // Why this artifact exists at all: Protomaps tags paths `min_zoom: 14` and thins them
  // below it. Decoded from the real archive over Ben Nevis (2026-09-08): 2 path features
  // at z14, 1 at z13, none at z12 — so at the zoom where the SAC bands were already
  // drawing, there was no path under them.
  it('draws the same path styling from its own source', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, withPaths, 'light');

    const low = map.layers.find((l) => String(l.id) === 'region-lochaber-paths-paths')!;
    const basemap = map.layers.find((l) => String(l.id) === 'region-lochaber-basemap-paths')!;
    expect(low['source-layer']).toBe('paths');
    // Identical paint, so crossing the handoff zoom changes which source draws and
    // nothing a user could see.
    expect(low.paint).toEqual(basemap.paint);
    expect(low.layout).toEqual(basemap.layout);
  });

  it('hands over to the basemap at the zoom the basemap actually has paths', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, withPaths, 'light');

    const low = map.layers.find((l) => String(l.id) === 'region-lochaber-paths-paths')!;
    const basemap = map.layers.find((l) => String(l.id) === 'region-lochaber-basemap-paths')!;
    // maxzoom is exclusive in the style spec, so these meet at 14 with neither a gap nor
    // an overlap — an overlap would double-draw the translucent casing and read brighter.
    expect(low.maxzoom).toBe(14);
    expect(basemap.minzoom).toBe(14);
  });

  it('leaves the basemap paths alone when there is no low-zoom artifact', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    // A region downloaded before this artifact existed still draws whatever its z12-13
    // tiles carry, rather than losing paths it used to show.
    const basemap = map.layers.find((l) => String(l.id) === 'region-lochaber-basemap-paths')!;
    expect(basemap.minzoom).toBe(12);
  });

  it('adds no low-zoom layer to a region too small to have those zooms', async () => {
    const map = fakeMap();
    // A region a hundredth of a degree across is suppressed below z16 by regionMinZoom,
    // which leaves this artifact no band of zooms at all. A layer whose minzoom is above
    // its maxzoom is a style error, so there must not be one.
    const tiny: Region = { ...withPaths, id: 'tiny', bbox: [-5.01, 56.79, -5.0, 56.8] };

    await addRegionToMap(map as unknown as MLMap, registry, tiny, 'light');

    const ids = map.layers.map((l) => String(l.id));
    expect(ids).not.toContain('region-tiny-paths-paths');
    expect(ids).not.toContain('region-tiny-paths-paths-casing');
  });

  it('keeps the grade band under the path lines', async () => {
    const map = fakeMap();
    const both: Region = {
      ...region,
      artifacts: [
        ...region.artifacts,
        pathsArtifact,
        { kind: 'sac', filename: 'lochaber-sac.pmtiles', path: 'p4', bytes: 1 },
      ],
    };

    await addRegionToMap(map as unknown as MLMap, registry, both, 'light');

    const ids = map.layers.map((l) => String(l.id));
    expect(ids.indexOf('region-lochaber-sac-band')).toBeLessThan(
      ids.indexOf('region-lochaber-paths-paths-casing'),
    );
  });
});

describe('SAC grades', () => {
  const sacArtifact = { kind: 'sac', filename: 'lochaber-sac.pmtiles', path: 'p4', bytes: 1 };
  const graded: Region = { ...region, artifacts: [...region.artifacts, sacArtifact] };

  it('draws the grade band under the path casing, so it reads as a halo', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');

    const ids = map.layers.map((l) => String(l.id));
    const band = ids.indexOf('region-lochaber-sac-band');
    const casing = ids.indexOf('region-lochaber-basemap-paths-casing');
    expect(band).toBeGreaterThan(-1);
    expect(casing).toBeGreaterThan(-1);
    expect(band).toBeLessThan(casing);
  });

  it('is wider than the path drawn over it', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');

    const widthAt16 = (id: string): number => {
      const layer = map.layers.find((l) => String(l.id) === id)!;
      const stops = (layer.paint as Record<string, unknown>)['line-width'] as unknown[];
      return Number(stops[stops.length - 1]);
    };

    // A band narrower than the casing would show as a coloured line beside the path
    // rather than around it.
    expect(widthAt16('region-lochaber-sac-band')).toBeGreaterThan(
      widthAt16('region-lochaber-basemap-paths-casing'),
    );
  });

  it('writes the grade along the line, so the colour is not the only signal', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');

    const labels = map.layers.find((l) => String(l.id) === 'region-lochaber-sac-labels')!;
    const layout = labels.layout as Record<string, unknown>;
    expect(layout['symbol-placement']).toBe('line');
    // "T3", not "3" — the form on the signpost.
    expect(JSON.stringify(layout['text-field'])).toContain('"T"');
    // T2/T3 are the pair a deuteranope is most likely to confuse, and they are the
    // boundary between a walk and hands out of pockets — hence the text.
    expect(Number(labels.minzoom)).toBeGreaterThanOrEqual(14);
  });

  it('reads the grade from the property the pipeline emits', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');

    const band = map.layers.find((l) => String(l.id) === 'region-lochaber-sac-band')!;
    expect(band['source-layer']).toBe('sac');
    // build-sac.sh normalizes sac_scale=demanding_mountain_hiking to t=3; a style
    // expression reading the raw OSM string would silently colour nothing.
    expect(JSON.stringify(band.paint)).toContain('"t"');
  });

  it('still draws the band when the basemap is not downloaded (C16)', async () => {
    const map = fakeMap();
    const sacOnly: Region = { ...region, artifacts: [sacArtifact] };

    await addRegionToMap(map as unknown as MLMap, registry, sacOnly, 'light');

    expect(map.layers.map((l) => String(l.id))).toContain('region-lochaber-sac-band');
  });

  it('removes its layers and source when the region is deleted', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');
    removeRegionFromMap(map as unknown as MLMap, registry, graded);

    expect(map.layers).toEqual([]);
    expect(map.sources.has('region-lochaber-sac')).toBe(false);
  });
});

describe('a region’s own copy of the summits', () => {
  const withPeaks: Region = {
    ...region,
    artifacts: [...region.artifacts, { kind: 'peaks', filename: 'lochaber-peaks-1.pmtiles', path: 'p4', bytes: 1 }],
  };

  it('serves it in place of the network’s summits inside the region, adding no layers', async () => {
    const { PEAKS_PMTILES_URL } = await import('../app/config');
    const map = fakeMap();
    await addRegionToMap(map as unknown as MLMap, registry, withPeaks, 'light');

    expect(registry.addRegionalCopy).toHaveBeenCalledWith(PEAKS_PMTILES_URL, 'lochaber-peaks-1.pmtiles', region.bbox);
    expect(map.sources.has(regionSourceId('lochaber', 'peaks'))).toBe(false);
    expect(map.layers.some((l) => String(l.id).includes('-peaks-'))).toBe(false);
  });

  it('reloads the summit source when it failed before the copy existed — an offline start', async () => {
    vi.mocked(registry.addRegionalCopy).mockReturnValueOnce(true);
    const setUrl = vi.fn();
    const map = fakeMap();
    const peaksSource = { type: 'vector', setUrl };
    map.getSource.mockImplementation((id: string) => (id === 'peaks' ? peaksSource : map.sources.has(id) ? {} : undefined));

    await addRegionToMap(map as unknown as MLMap, registry, withPeaks, 'light');

    expect(setUrl).toHaveBeenCalledWith(expect.stringMatching(/^pmtiles:\/\/.*peaks-global/));
  });
});
