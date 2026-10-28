import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import { mapInk, ratmapFlavor } from '../map/flavor';
import { paintValue, styleColor } from '../test-support/paint-value';

const getArtifactFileMock = vi.hoisted(() => vi.fn());
vi.mock('./opfs-store', () => ({ getArtifactFile: getArtifactFileMock }));

const { addRegionToMap, removeRegionFromMap, sharedSourceId } = await import('./region-layers');

/** Each kind's archive zoom range, as the catalogue's regions mostly have them. */
const ZOOMS: Record<string, [number, number]> = {
  avalanche: [8, 11],
  basemap: [0, 15],
  contours: [11, 14],
  detail: [12, 15],
  landmarks: [13, 15],
  parking: [13, 15],
  paths: [12, 13],
  peaks: [0, 7],
  sac: [12, 15],
  terrain: [0, 11],
  'terrain-features': [11, 15],
};

/** The shared source a kind is drawn through, at its usual zoom range. */
const sid = (kind: string) => sharedSourceId(kind, ...ZOOMS[kind]!);

/** An archive's kind, from its filename: `<region>-<kind>[-<n>].pmtiles`. */
function kindOf(filename: string): string {
  // terrain-features before terrain, which it starts with.
  return Object.keys(ZOOMS)
    .sort((a, b) => b.length - a.length)
    .find((kind) => filename.includes(`-${kind}`))!;
}

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
  const images = new Set<string>();
  // Every reload (setUrl) of a source, in order.
  const reloads: string[] = [];
  const sourceObject = (id: string) => ({ setUrl: vi.fn(() => void reloads.push(id)) });
  return {
    layers,
    sources,
    /** The sources reloaded so far, in order. */
    reloaded: () => [...reloads],
    addSource: vi.fn((id: string) => void sources.add(id)),
    getSource: vi.fn((id: string) => (sources.has(id) ? sourceObject(id) : undefined)),
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
    // Landmarks and field detail register their symbols.
    hasImage: vi.fn((id: string) => images.has(id)),
    addImage: vi.fn((id: string) => void images.add(id)),
  };
}

/**
 * The registry's side of sharing, without real archives: which copies each shared archive
 * holds, and a header per archive with its kind's zoom range — or `zooms[filename]`'s.
 */
function fakeRegistry(zooms: Record<string, [number, number]> = {}) {
  const shared = new Map<string, Set<string>>();
  return {
    addLocal: vi.fn((file: File) => ({
      getHeader: async () => {
        const [minZoom, maxZoom] = zooms[file.name] ?? ZOOMS[kindOf(file.name)]!;
        return { minZoom, maxZoom };
      },
    })),
    addRegionalCopy: vi.fn(() => false),
    addSharedCopy: vi.fn((key: string, filename: string, _bbox: unknown, _floor: number) => {
      const copies = shared.get(key) ?? new Set<string>();
      shared.set(key, copies);
      if (copies.has(filename)) return false;
      copies.add(filename);
      return true;
    }),
    sharedCopyCount: (key: string) => shared.get(key)?.size ?? 0,
    removeLocal: vi.fn((filename: string) =>
      [...shared].filter(([, copies]) => copies.delete(filename)).map(([key]) => key),
    ),
    sourceUrl: (key: string) => `pmtiles://${key}`,
  };
}

let fake = fakeRegistry();
let registry = fake as unknown as TileSourceRegistry;

beforeEach(() => {
  getArtifactFileMock.mockReset();
  getArtifactFileMock.mockImplementation(async (name: string) => new File([new Uint8Array(4)], name));
  fake = fakeRegistry();
  registry = fake as unknown as TileSourceRegistry;
});

describe('addRegionToMap', () => {
  it('leaves a search index to search, not to the map', async () => {
    const map = fakeMap();
    const withIndex: Region = {
      ...region,
      artifacts: [
        ...region.artifacts,
        { kind: 'places', filename: 'lochaber-places-1.sqlite', path: 'p4', bytes: 1 },
      ],
    };

    await addRegionToMap(map as unknown as MLMap, registry, withIndex, 'light');

    // Registered as an archive, a SQLite file would be read as a broken PMTiles header
    // the moment anything asked it for tiles.
    const registered = vi.mocked(registry.addLocal).mock.calls.map(([file]) => (file as File).name);
    expect(registered).not.toContain('lochaber-places-1.sqlite');
    expect(registered).toContain('lochaber-basemap.pmtiles');
    expect([...map.sources].some((id) => id.includes('places'))).toBe(false);
  });

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
      const earth = map.layers.find((l) => String(l.id) === `${sid('basemap')}-earth`);
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
      expect(String(layer.source)).toMatch(/^regions-/);
    }
  });

  it('registers each artifact with the tile registry under its unique filename (C3)', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    expect(registry.addLocal).toHaveBeenCalledTimes(3);
    expect(map.addSource).toHaveBeenCalledWith(
      sid('terrain'),
      expect.objectContaining({ type: 'raster-dem', encoding: 'terrarium' }),
    );
  });

  it('puts relief and contours beneath the region labels, not over them', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const ids = map.layers.map((l) => String(l.id));
    const firstRegionLabel = map.layers.findIndex(
      (l) => l.type === 'symbol' && String(l.id).startsWith('regions-'),
    );
    expect(firstRegionLabel).toBeGreaterThan(-1);

    // Regression: everything was inserted at the peaks layer, which stacks each artifact
    // on top of the previous one — so the hillshade ended up over the basemap's own
    // labels and washed out gully and corrie names.
    for (const id of [`${sid('terrain')}-hillshade`, `${sid('contours')}-lines`]) {
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
    const regionTownLabelIdx = ids.indexOf(`${sid('basemap')}-places_locality`);
    const regionRoadsIdx = ids.indexOf(`${sid('basemap')}-roads_minor`);

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
        `${sid('contours')}-lines-index`,
        `${sid('contours')}-lines`,
        `${sid('contours')}-labels`,
      ]) {
        expect(visibilityOf(id), id).toBe('none');
      }
      expect(visibilityOf(`${sid('terrain')}-hillshade`)).toBe('visible');
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

  it('draws paths over the roads but under every label and POI, car parks included', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const ids = map.layers.map((l) => String(l.id));
    const generated = map.layers.filter(
      (l) => l.source === sid('basemap') && !String(l.id).includes('-paths'),
    );
    const lastLine = ids.indexOf(String(generated.filter((l) => l.type === 'line').at(-1)!.id));
    const firstSymbol = ids.indexOf(String(generated.find((l) => l.type === 'symbol')!.id));
    const casing = ids.indexOf(`${sid('basemap')}-paths-casing`);
    const paths = ids.indexOf(`${sid('basemap')}-paths`);

    expect(casing).toBeGreaterThan(lastLine);
    expect(paths).toBe(casing + 1);
    expect(paths).toBeLessThan(firstSymbol);
    expect(paths).toBeLessThan(ids.indexOf(`${sid('basemap')}-pois`));
  });

  it('keeps relief and contours under the paths', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    const ids = map.layers.map((l) => String(l.id));
    const casing = ids.indexOf(`${sid('basemap')}-paths-casing`);
    for (const id of [
      `${sid('terrain')}-hillshade`,
      `${sid('contours')}-lines-index`,
      `${sid('contours')}-lines`,
    ]) {
      expect(ids.indexOf(id)).toBeGreaterThan(-1);
      expect(ids.indexOf(id)).toBeLessThan(casing);
    }
  });

  describe('an overlay added before the basemap', () => {
    const avalancheArtifact = {
      kind: 'avalanche',
      filename: 'lochaber-avalanche-1.pmtiles',
      path: 'p6',
      bytes: 1,
      minzoom: 8,
      maxzoom: 11,
    };
    // The manifest's real order: alphabetical, so `avalanche` comes ahead of `basemap`.
    const manifestOrder: Region = { ...region, artifacts: [avalancheArtifact, ...region.artifacts] };

    const groundIds = (map: ReturnType<typeof fakeMap>) => {
      const ids = map.layers.map((l) => String(l.id));
      const fills = map.layers.filter(
        (l) =>
          l.source === sid('basemap') &&
          l.type !== 'symbol' &&
          !String(l.id).includes('-paths'),
      );
      return {
        ids,
        lastBasemapGround: ids.indexOf(String(fills.at(-1)!.id)),
        earth: ids.indexOf(`${sid('basemap')}-earth`),
        casing: ids.indexOf(`${sid('basemap')}-paths-casing`),
      };
    };

    it('draws avalanche terrain over the basemap fills, not under them', async () => {
      // Regression: avalanche was added first, at the peaks, and every basemap layer then
      // went in at the peaks too — on top of it. The opaque earth and landcover hid the
      // slope shading everywhere, while the Layers tab showed it switched on.
      const map = fakeMap();

      await addRegionToMap(map as unknown as MLMap, registry, manifestOrder, 'light');

      const { ids, lastBasemapGround, casing } = groundIds(map);
      const shade = ids.indexOf(`${sid('avalanche')}-shade`);
      expect(shade).toBeGreaterThan(-1);
      expect(shade).toBeGreaterThan(lastBasemapGround);
      expect(shade).toBeLessThan(casing);
    });

    it('keeps the overlays visible when the basemap arrives in a later call (C16)', async () => {
      // A half-downloaded region is restored with what it has; the rest is added when
      // the download resumes, and the overlays already drawn are not added again.
      const map = fakeMap();
      const partial: Region = {
        ...region,
        artifacts: manifestOrder.artifacts.filter((a) => a.kind !== 'basemap'),
      };

      await addRegionToMap(map as unknown as MLMap, registry, partial, 'light');
      await addRegionToMap(map as unknown as MLMap, registry, manifestOrder, 'light');

      const { ids, lastBasemapGround, earth } = groundIds(map);
      expect(earth).toBeGreaterThan(-1);
      for (const id of [
        `${sid('avalanche')}-shade`,
        `${sid('terrain')}-hillshade`,
        `${sid('contours')}-lines`,
      ]) {
        expect(ids.indexOf(id), id).toBeGreaterThan(lastBasemapGround);
      }
    });
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
      (l) => l.type === 'symbol' && String(l.id).startsWith(`${sid('basemap')}-`),
    );
    expect(firstRegionLabel).toBeGreaterThan(-1);
    expect(ids.indexOf(`${sid('contours')}-labels`)).toBeLessThan(firstRegionLabel);
  });

  it('does not draw the region at zooms where its tiles cover a continent', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    // `pmtiles extract --bbox` keeps whole upstream tiles instead of re-clipping them, so
    // a region's low-zoom tiles are planet tiles that merely intersect it. Montenegro's z5
    // basemap tile spans Vienna to Athens; drawing it painted that rectangle over Romania
    // and Bulgaria. Lochaber is 1.0 deg wide, so its tiles stop out-sizing it at z9.
    // The layers are every region's, so the floor goes with the region's copy instead.
    const floors = fake.addSharedCopy.mock.calls.map(([, , , floor]) => floor);
    expect(floors).toEqual([9, 9, 9]);
  });

  it('scales the cutoff to the region, rather than assuming one size', async () => {
    const map = fakeMap();
    // Scotland spans 8 deg — its tiles are region-sized three zoom levels earlier than
    // Lochaber's, and holding it back to Lochaber's cutoff would hide detail it has.
    const scotland: Region = { ...region, id: 'scotland', bbox: [-8.7, 54.6, -0.7, 61.0] };

    await addRegionToMap(map as unknown as MLMap, registry, scotland, 'light');

    expect(fake.addSharedCopy).toHaveBeenCalledWith(sid('terrain'), 'lochaber-terrain.pmtiles', scotland.bbox, 6);
  });

  it('skips artifacts that are not actually in OPFS yet', async () => {
    getArtifactFileMock.mockImplementation(async (name: string) =>
      name.includes('contours') ? null : new File([new Uint8Array(4)], name),
    );
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    expect(map.sources.has(sid('contours'))).toBe(false);
    expect(map.sources.has(sid('basemap'))).toBe(true);
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

    removeRegionFromMap(map as unknown as MLMap, registry, region);

    expect(map.layers).toEqual([]);
    expect([...map.sources]).toEqual([]);
    // Its files are about to be deleted, so its archives must not outlive them.
    expect(vi.mocked(registry.removeLocal).mock.calls.map(([f]) => f)).toEqual(
      region.artifacts.map((a) => a.filename),
    );
  });

  it('keeps what another region still draws, reloading it so the deleted one leaves', async () => {
    // Real catalogue pairs, overlapping: england-east / england-east-midlands. When each
    // region had its own layers, matching them by `region-england-east-` once stripped the
    // Midlands too. Now they share them, and deleting one must leave the other drawn.
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
    const layers = [...map.layers];
    const sources = [...map.sources];
    const reloadedBefore = map.reloaded().length;

    removeRegionFromMap(map as unknown as MLMap, registry, east);

    expect(map.layers).toEqual(layers);
    expect([...map.sources]).toEqual(sources);
    // Its tiles were in those sources' caches; a reload drops them.
    expect(map.reloaded().slice(reloadedBefore).sort()).toEqual(sources.sort());
  });
});

describe('overlapping regions', () => {
  const regionOf = (id: string, kinds: string[]): Region => ({
    ...region,
    id,
    artifacts: kinds.map((kind, i) => ({ kind, filename: `${id}-${kind}.pmtiles`, path: `p${i}`, bytes: 1 })),
  });
  const northWest = regionOf('england-north-west', ['basemap', 'landmarks']);
  const scotland = regionOf('scotland', ['basemap']);

  /** Every basemap fill on the map is below every landmark layer. */
  function landmarksAboveAllGround(map: ReturnType<typeof fakeMap>) {
    const ids = map.layers.map((l) => String(l.id));
    const ground = map.layers
      .filter((l) => String(l.source).endsWith('-basemap') && l.type === 'fill')
      .map((l) => ids.indexOf(String(l.id)));
    const landmarks = map.layers
      .filter((l) => String(l.source).endsWith('-landmarks'))
      .map((l) => ids.indexOf(String(l.id)));
    expect(ground.length).toBeGreaterThan(0);
    expect(landmarks.length).toBeGreaterThan(0);
    return Math.max(...ground) < Math.min(...landmarks);
  }

  it('draws them through one source and one set of layers per kind', async () => {
    const map = fakeMap();
    const a = regionOf('a', ['basemap', 'terrain', 'contours']);
    const b = regionOf('b', ['basemap', 'terrain', 'contours']);

    await addRegionToMap(map as unknown as MLMap, registry, a, 'light');
    const layers = map.layers.length;
    await addRegionToMap(map as unknown as MLMap, registry, b, 'light');

    expect([...map.sources].sort()).toEqual([sid('basemap'), sid('contours'), sid('terrain')].sort());
    expect(map.layers.length).toBe(layers);
  });

  it('reloads a shared source when a region joins it, and not when one is drawn again', async () => {
    const map = fakeMap();
    const a = regionOf('a', ['basemap', 'contours']);
    const b = regionOf('b', ['basemap', 'contours']);

    await addRegionToMap(map as unknown as MLMap, registry, a, 'light');
    expect(map.reloaded()).toEqual([]);
    await addRegionToMap(map as unknown as MLMap, registry, b, 'light');
    expect(map.reloaded().sort()).toEqual([sid('basemap'), sid('contours')].sort());
    // A theme change or a second restore draws the same regions again.
    await addRegionToMap(map as unknown as MLMap, registry, b, 'light');
    expect(map.reloaded()).toHaveLength(2);
  });

  it('keeps one region’s landmarks over another’s ground, drawn after it (Great Dun Fell)', async () => {
    // Scotland's bbox reaches 54.54 N, over the masts on Great Dun Fell in North West
    // England. Restored after it and without landmarks of its own, Scotland's basemap went
    // in over every North West layer, and its opaque earth painted the masts out.
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, northWest, 'light');
    await addRegionToMap(map as unknown as MLMap, registry, scotland, 'light');

    expect(landmarksAboveAllGround(map)).toBe(true);
  });

  it('gives an archive with another zoom range a source of its own, its ground under every overlay', async () => {
    // Basemaps end at z13 or z14 in some regions; one source can only have one range.
    fake = fakeRegistry({ 'scotland-basemap.pmtiles': [0, 14] });
    registry = fake as unknown as TileSourceRegistry;
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, northWest, 'light');
    await addRegionToMap(map as unknown as MLMap, registry, scotland, 'light');

    expect(map.sources.has(sid('basemap'))).toBe(true);
    expect(map.sources.has(sharedSourceId('basemap', 0, 14))).toBe(true);
    expect(landmarksAboveAllGround(map)).toBe(true);
  });

  it('takes a kind off the map with the last region that has it, leaving the rest', async () => {
    const map = fakeMap();
    await addRegionToMap(map as unknown as MLMap, registry, northWest, 'light');
    await addRegionToMap(map as unknown as MLMap, registry, scotland, 'light');

    removeRegionFromMap(map as unknown as MLMap, registry, northWest);

    expect([...map.sources]).toEqual([sid('basemap')]);
    expect(map.layers.some((l) => String(l.source).endsWith('-landmarks'))).toBe(false);
    expect(map.layers.some((l) => l.source === sid('basemap'))).toBe(true);
    expect(map.reloaded()).toContain(sid('basemap'));
  });
});

describe('car parks', () => {
  const withParking: Region = {
    ...region,
    artifacts: [...region.artifacts, { kind: 'parking', filename: 'lochaber-parking-1.pmtiles', path: 'p7', bytes: 1 }],
  };

  it('draws them from their own artifact, just above the basemap’s other POIs', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, withParking, 'light');

    const ids = map.layers.map((l) => String(l.id));
    expect(map.sources.has(sid('parking'))).toBe(true);
    // Above the POIs, so a car park places before a cafe claims its spot; the basemap's
    // own car park layer, which drew too few, is gone.
    expect(ids.indexOf(`${sid('parking')}-symbols`)).toBe(ids.indexOf(`${sid('basemap')}-pois`) + 1);
    expect(ids.some((id) => id.endsWith('pois_parking'))).toBe(false);
  });

  it('shares one source and one layer between overlapping regions', async () => {
    const map = fakeMap();
    const other: Region = {
      ...withParking,
      id: 'glencoe',
      artifacts: withParking.artifacts.map((a) => ({ ...a, filename: a.filename.replace('lochaber', 'glencoe') })),
    };

    await addRegionToMap(map as unknown as MLMap, registry, withParking, 'light');
    await addRegionToMap(map as unknown as MLMap, registry, other, 'light');

    expect(map.layers.filter((l) => l.source === sid('parking'))).toHaveLength(1);
  });
});

describe('the low-zoom path network', () => {
  const pathsArtifact = { kind: 'paths', filename: 'lochaber-paths.pmtiles', path: 'p5', bytes: 1 };
  const withPaths: Region = { ...region, artifacts: [...region.artifacts, pathsArtifact] };

  // Why this artifact exists at all: Protomaps tags paths `min_zoom: 14` and thins them
  // below it. Decoded from the real archive over Ben Nevis (2026-09-08): 2 path features
  // at z14, 1 at z13, none at z12 — so at the zoom where the SAC bands were already
  // drawing, there was no path under them.
  it('sits with the basemap paths, under the contour heights added before it', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, withPaths, 'light');

    const ids = map.layers.map((l) => String(l.id));
    expect(ids.indexOf(`${sid('paths')}-paths-casing`)).toBeGreaterThan(
      ids.indexOf(`${sid('basemap')}-paths`),
    );
    expect(ids.indexOf(`${sid('paths')}-paths`)).toBeLessThan(
      ids.indexOf(`${sid('contours')}-labels`),
    );
  });

  it('draws the same path styling from its own source', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, withPaths, 'light');

    const low = map.layers.find((l) => String(l.id) === `${sid('paths')}-paths`)!;
    const basemap = map.layers.find((l) => String(l.id) === `${sid('basemap')}-paths`)!;
    expect(low['source-layer']).toBe('paths');
    // Identical paint, so crossing the handoff zoom changes which source draws and
    // nothing a user could see.
    expect(low.paint).toEqual(basemap.paint);
    expect(low.layout).toEqual(basemap.layout);
  });

  it('hands over to the basemap at the zoom the basemap actually has paths', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, withPaths, 'light');

    const low = map.layers.find((l) => String(l.id) === `${sid('paths')}-paths`)!;
    const basemap = map.layers.find((l) => String(l.id) === `${sid('basemap')}-paths`)!;
    // maxzoom is exclusive in the style spec, so these meet at 14 with neither a gap nor
    // an overlap — an overlap would double-draw the translucent casing and read brighter.
    expect(low.maxzoom).toBe(14);
    expect(basemap.minzoom).toBe(14);
  });

  it('starts the basemap paths at z14 even without the low-zoom artifact', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, region, 'light');

    // The basemap's path layers are every region's, so there is no one region's "has the
    // low-zoom artifact" to start them earlier for. Every region in the catalogue has it;
    // one downloaded before it existed goes without z12-13 paths until updated.
    const basemap = map.layers.find((l) => String(l.id) === `${sid('basemap')}-paths`)!;
    expect(basemap.minzoom).toBe(14);
  });

  it('leaves a region too small for those zooms to its floor, not to a layer', async () => {
    const map = fakeMap();
    // A region a hundredth of a degree across is held back below z16 by regionMinZoom.
    // That is the region's copy's floor; the shared layer keeps its own zooms, and must
    // not be given a minzoom above its maxzoom, which is a style error.
    const tiny: Region = { ...withPaths, id: 'tiny', bbox: [-5.01, 56.79, -5.0, 56.8] };

    await addRegionToMap(map as unknown as MLMap, registry, tiny, 'light');

    expect(fake.addSharedCopy).toHaveBeenCalledWith(sid('paths'), 'lochaber-paths.pmtiles', tiny.bbox, 16);
    const low = map.layers.find((l) => String(l.id) === `${sid('paths')}-paths`)!;
    expect(Number(low.minzoom)).toBeLessThan(Number(low.maxzoom));
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
    expect(ids.indexOf(`${sid('sac')}-band`)).toBeLessThan(
      ids.indexOf(`${sid('paths')}-paths-casing`),
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
    const band = ids.indexOf(`${sid('sac')}-band`);
    const casing = ids.indexOf(`${sid('basemap')}-paths-casing`);
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
    expect(widthAt16(`${sid('sac')}-band`)).toBeGreaterThan(
      widthAt16(`${sid('basemap')}-paths-casing`),
    );
  });

  it('writes the grade along the line, so the colour is not the only signal', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');

    const labels = map.layers.find((l) => String(l.id) === `${sid('sac')}-labels`)!;
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

    const band = map.layers.find((l) => String(l.id) === `${sid('sac')}-band`)!;
    expect(band['source-layer']).toBe('sac');
    // build-sac.sh normalizes sac_scale=demanding_mountain_hiking to t=3; a style
    // expression reading the raw OSM string would silently colour nothing.
    expect(JSON.stringify(band.paint)).toContain('"t"');
  });

  it('still draws the band when the basemap is not downloaded (C16)', async () => {
    const map = fakeMap();
    const sacOnly: Region = { ...region, artifacts: [sacArtifact] };

    await addRegionToMap(map as unknown as MLMap, registry, sacOnly, 'light');

    expect(map.layers.map((l) => String(l.id))).toContain(`${sid('sac')}-band`);
  });

  it('removes its layers and source when the region is deleted', async () => {
    const map = fakeMap();

    await addRegionToMap(map as unknown as MLMap, registry, graded, 'light');
    removeRegionFromMap(map as unknown as MLMap, registry, graded);

    expect(map.layers).toEqual([]);
    expect(map.sources.has(sid('sac'))).toBe(false);
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
    expect([...map.sources].some((id) => id.includes('peaks'))).toBe(false);
    expect(map.layers.some((l) => String(l.id).includes('-peaks-'))).toBe(false);
  });

  it('reloads the summit source when it failed before the copy existed — an offline start', async () => {
    vi.mocked(registry.addRegionalCopy).mockReturnValueOnce(true);
    const setUrl = vi.fn();
    const map = fakeMap();
    const peaksSource = { type: 'vector', setUrl };
    map.getSource.mockImplementation((id: string) =>
      id === 'peaks' ? peaksSource : map.sources.has(id) ? { setUrl: vi.fn() } : undefined,
    );

    await addRegionToMap(map as unknown as MLMap, registry, withPeaks, 'light');

    expect(setUrl).toHaveBeenCalledWith(expect.stringMatching(/^pmtiles:\/\/.*peaks-global/));
  });
});
