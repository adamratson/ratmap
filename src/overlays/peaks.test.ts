import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap, PointLike } from 'maplibre-gl';
import {
  createExpression,
  featureFilter,
  type ExpressionSpecification,
  type FilterSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import {
  addPeaksLayer,
  formatElevation,
  hasList,
  isMunro,
  peakAt,
  PEAKS_LAYER_ID,
  PEAKS_NOTABILITY_FILTER,
  PEAKS_RENDER_FILTER,
  PEAKS_SORT_KEY,
  PEAKS_SOURCE_ID,
} from './peaks';
import { mapInk } from '../map/flavor';
import type { TileSourceRegistry } from '../map/tile-source-registry';

function fakeRegistry() {
  return {
    addRemote: vi.fn(),
    sourceUrl: (key: string) => `pmtiles://${key}`,
  } as unknown as TileSourceRegistry;
}

type Image = { width: number; height: number; data: Uint8ClampedArray };

/** A map with just what addPeaksLayer touches, the dot images included. */
function fakeMap({ addLayer = vi.fn(), getLayer = vi.fn(), addSource = vi.fn() } = {}) {
  const images = new Map<string, Image>();
  const map = {
    addSource,
    addLayer,
    getLayer,
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: Image) => void images.set(id, image),
  } as unknown as MLMap;
  return { map, addLayer, addSource, images };
}

/** The one layer addPeaksLayer adds, for a theme. */
function peaksLayer(theme: 'light' | 'dark' = 'light') {
  const { map, addLayer, images } = fakeMap();
  addPeaksLayer(map, fakeRegistry(), theme);
  return { layer: addLayer.mock.calls[0][0], images };
}

/** Whether a filter keeps a summit at a zoom, evaluated as MapLibre would. */
function keeps(filter: unknown, props: Record<string, unknown>, zoom: number): boolean {
  return featureFilter(filter as FilterSpecification).filter({ zoom }, { type: 1, properties: props } as never);
}

describe('formatElevation', () => {
  it('renders a rounded metre value', () => {
    expect(formatElevation(1344.6)).toBe('1345 m');
    expect(formatElevation(0)).toBe('0 m');
  });

  it('returns null for anything not a finite number, rather than rendering "NaN m"', () => {
    // ele is normalized to a number at build time (infra/scripts/tools/cmd/normalize-peaks);
    // if that ever regresses, a summit must show nothing rather than a wrong or nonsense
    // elevation.
    for (const bad of ['1345', '~340', undefined, null, Number.NaN, Infinity, {}]) {
      expect(formatElevation(bad)).toBeNull();
    }
  });
});

describe('addPeaksLayer', () => {
  it('registers the archive for regional copies, and takes its zoom range from the archive', () => {
    const registry = fakeRegistry();
    const { map, addSource } = fakeMap();

    addPeaksLayer(map, registry, 'light');

    // Downloaded regions' copies stand in for it inside them (offline summits).
    expect(registry.addRemote).toHaveBeenCalledWith(expect.any(String), { regionalCopies: true });
    const [sourceId, spec] = addSource.mock.calls[0];
    expect(sourceId).toBe(PEAKS_SOURCE_ID);
    expect(spec.url).toMatch(/^pmtiles:\/\//);
    // No cap of our own: the header's range, via the pmtiles:// TileJSON. A constant here
    // said z5 over a z6 archive and hid ~60% of summits.
    expect(spec).not.toHaveProperty('maxzoom');
    expect(spec.attribution).toContain('openstreetmap.org/copyright');
  });

  it('draws the dot and the name as one symbol, placed together or not at all', () => {
    // A separate circle layer went under every downloaded region's ground, and took no part
    // in collision: 803 dots for 107 names over Andorra at z9.
    const { map, addLayer } = fakeMap();

    addPeaksLayer(map, fakeRegistry(), 'light');

    expect(addLayer.mock.calls.map((call) => call[0].id)).toEqual([PEAKS_LAYER_ID]);
    const { layout } = addLayer.mock.calls[0][0];
    expect(layout['icon-image']).toBeDefined();
    expect(layout['text-optional']).toBe(false);
    expect(layout['icon-optional']).toBe(false);
    expect(layout['icon-allow-overlap']).toBe(false);
    expect(layout['text-allow-overlap']).toBe(false);
  });

  it('draws the dot in the peak ink, ringed in the ground, at the size the circle had', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ink = mapInk(theme);
      const { layer, images } = peaksLayer(theme);
      const [, , munroId, peakId] = layer.layout['icon-image'];
      const pixel = (image: Image, x: number, y: number) => {
        const at = (y * image.width + x) * 4;
        return `#${[...image.data.slice(at, at + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      };
      const peak = images.get(peakId)!;
      const munro = images.get(munroId)!;
      const mid = peak.width / 2;
      expect(pixel(peak, mid, mid)).toBe(ink.peakDot);
      expect(pixel(munro, mid, mid)).toBe(ink.peakMunroDot);
      // Rim just outside the disc (radius 10 of 32, at 2x of 20 px: 12.5 px), clear corners.
      expect(pixel(peak, mid + 13, mid)).toBe(ink.peakDotStroke);
      expect(peak.data[3]).toBe(0);
      // 13 px across from z12, as the circle layer drew it (radius 6.5).
      const size = layer.layout['icon-size'];
      expect(size).toEqual(['step', ['zoom'], 0.64, 9, 0.8, 12, 1.04]);
      expect(Math.round(((2 * 10) / 32) * 20 * 1.04)).toBe(13);
    }
  });

  it('inserts the label layer before the basemap town/city labels, not on top of everything', () => {
    // MapLibre places layers in reverse style order — the topmost layer claims collision
    // space first. Appending peaks on top (the default for addLayer with no beforeId) let
    // the Lake District's fell density blank out every nearby town label. Placing peaks
    // before `places_locality` instead lets towns place first.
    const { map, addLayer } = fakeMap({ getLayer: vi.fn().mockReturnValue({ id: 'places_locality' }) });

    addPeaksLayer(map, fakeRegistry(), 'light');

    const labelCall = addLayer.mock.calls.find((call) => call[0].id === PEAKS_LAYER_ID)!;
    expect(labelCall[1]).toBe('places_locality');
  });

  it('falls back to appending when the basemap has no places_locality layer', () => {
    const { map, addLayer } = fakeMap({ getLayer: vi.fn().mockReturnValue(undefined) });

    addPeaksLayer(map, fakeRegistry(), 'light');

    const labelCall = addLayer.mock.calls.find((call) => call[0].id === PEAKS_LAYER_ID)!;
    expect(labelCall[1]).toBeUndefined();
  });

  it('builds a label expression that degrades when name or ele is missing', () => {
    const symbolLayer = peaksLayer().layer;
    const textField = JSON.stringify(symbolLayer.layout['text-field']);
    // A 'case' expression with explicit has-checks, so a peak missing either field never
    // renders a stray separator or the literal string "undefined".
    expect(textField).toContain('case');
    expect(textField).toContain('has');
    expect(textField).toContain('name');
    expect(textField).toContain('ele');
  });
});

describe('PEAKS_NOTABILITY_FILTER', () => {
  // The real expression, evaluated by MapLibre's own filter code.
  const passes = (props: Record<string, unknown>, zoom: number) => keeps(PEAKS_NOTABILITY_FILTER, props, zoom);

  it('shows only dominant summits at country zoom', () => {
    expect(passes({ prom: 1483 }, 6)).toBe(true);   // Bobotov Kuk
    expect(passes({ prom: 93 }, 6)).toBe(false);    // Savin kuk, a bump on the same massif
  });

  it('ranks a massif by prominence, which elevation cannot do', () => {
    // Bobotov Kuk 2523 m / prom 1483; Savin kuk 2313 m / prom 93. Nearly the same height,
    // completely different significance — this is the whole reason for the measure.
    expect(passes({ prom: 1483, ele: 2523 }, 8)).toBe(true);
    expect(passes({ prom: 93, ele: 2313 }, 8)).toBe(false);
  });

  it('travels between regions with different terrain', () => {
    // The bug this guards: an elevation threshold readable over Scotland showed 268x the
    // peaks per square degree over Montenegro. A prominent Scottish hill and a prominent
    // Montenegrin one must both qualify at the same zoom.
    expect(passes({ prom: 718 }, 8)).toBe(true);    // Schiehallion
    expect(passes({ prom: 954 }, 8)).toBe(true);    // Rumija
    // ...and a minor top in either place must not.
    expect(passes({ prom: 40 }, 8)).toBe(false);
    expect(passes({ prom: 22 }, 8)).toBe(false);
  });

  it('does not let wikidata flood low zooms', () => {
    // Applying the notability proxy at every zoom swamped z6 over the Highlands, where a
    // large share of hills carry a Wikidata id.
    expect(passes({ prom: 30, wikidata: 'Q1' }, 6)).toBe(false);
    expect(passes({ prom: 30, wikidata: 'Q1' }, 9)).toBe(true);
  });

  it('does not let wikidata bring in a bump or a col', () => {
    // Over Andorra at z10: Roques Feres (0.2 m) and Coll Blanc (5.9 m) were named, while
    // Pica d'Estats and Comapedrosa were not.
    expect(passes({ prom: 0.2, wikidata: 'Q1' }, 10)).toBe(false);
    expect(passes({ prom: 5.9, wikidata: 'Q1' }, 12)).toBe(false);
    // They still come in on prominence alone, at the highest zooms.
    expect(passes({ prom: 0.2, wikidata: 'Q1' }, 15)).toBe(true);
  });

  it('still lets wikidata vouch for a summit with no computed prominence', () => {
    // Outside every built region there is nothing else to judge by.
    expect(passes({ wikidata: 'Q1' }, 9)).toBe(true);
    expect(passes({}, 9)).toBe(false);
  });

  it('lowers the bar progressively as you zoom in', () => {
    expect(passes({ prom: 400 }, 8)).toBe(false);
    expect(passes({ prom: 400 }, 9)).toBe(true);
    expect(passes({ prom: 150 }, 10)).toBe(false);
    expect(passes({ prom: 150 }, 11)).toBe(true);
    expect(passes({ prom: 40 }, 12)).toBe(false);
    expect(passes({ prom: 40 }, 13)).toBe(true);
  });

  it('shows peaks with no computed prominence only at the highest zooms', () => {
    // Peaks outside every built region have no `prom`; they must not vanish entirely.
    expect(passes({}, 13)).toBe(false);
    expect(passes({}, 15)).toBe(true);
  });
});

describe('PEAKS_SORT_KEY', () => {
  const expression = createExpression(PEAKS_SORT_KEY as unknown as ExpressionSpecification);
  if (expression.result !== 'success') throw new Error(JSON.stringify(expression.value));
  const key = (props: Record<string, unknown>) =>
    expression.value.evaluate({ zoom: 10 }, { type: 1, properties: props } as never) as number;
  const order = (peaks: Record<string, Record<string, unknown>>) =>
    Object.entries(peaks)
      .sort(([, a], [, b]) => key(a) - key(b))
      .map(([name]) => name);

  it('places the most prominent summit first, whatever the tile order', () => {
    // The z10 view over Andorra that lost both of these to minor tops.
    expect(
      order({
        'Roques Feres': { prom: 0.2, ele: 1967, wikidata: 'Q1' },
        'Pic de Comapedrosa': { prom: 429.5, ele: 2943 },
        'Coll Blanc': { prom: 5.9, ele: 2528, wikidata: 'Q2' },
        "Pica d'Estats": { prom: 1267.2, ele: 3143 },
      }),
    ).toEqual(["Pica d'Estats", 'Pic de Comapedrosa', 'Coll Blanc', 'Roques Feres']);
  });

  it('places a Munro before any other summit', () => {
    expect(
      order({
        'Ben Nevis-sized top': { prom: 1344 },
        'a marginal Munro': { prom: 10, lists: 'munro' },
      }),
    ).toEqual(['a marginal Munro', 'Ben Nevis-sized top']);
  });

  it('ranks summits with no computed prominence by height, below every measured one', () => {
    expect(
      order({
        'unmeasured, 3000 m': { ele: 3000 },
        'unmeasured, 1000 m': { ele: 1000 },
        'measured, 0 m': { prom: 0, ele: 500 },
        'nothing known': {},
      }),
    ).toEqual(['measured, 0 m', 'unmeasured, 3000 m', 'unmeasured, 1000 m', 'nothing known']);
  });

  it('is what the layer places by', () => {
    expect(peaksLayer().layer.layout['symbol-sort-key']).toEqual(PEAKS_SORT_KEY);
  });
});

describe('hasList / isMunro', () => {
  it('reads membership out of the semicolon-delimited lists property', () => {
    expect(hasList({ lists: 'munro' }, 'munro')).toBe(true);
    expect(hasList({ lists: 'munro;marilyn' }, 'munro')).toBe(true);
    expect(hasList({ lists: 'marilyn' }, 'munro')).toBe(false);
    expect(hasList({}, 'munro')).toBe(false);
  });

  it('isMunro is hasList narrowed to the one list this build actually derives', () => {
    expect(isMunro({ lists: 'munro' })).toBe(true);
    expect(isMunro({ lists: 'marilyn' })).toBe(false);
    expect(isMunro({})).toBe(false);
  });
});

describe('PEAKS_RENDER_FILTER', () => {
  const passes = (props: Record<string, unknown>, zoom: number) => keeps(PEAKS_RENDER_FILTER, props, zoom);

  it('renders a munro at every zoom regardless of prominence', () => {
    // Same low prominence, only one is a munro — this is the case that regresses: a
    // marginal munro must not vanish the way an equally low-prominence bump correctly does.
    expect(passes({ name: 'Beinn Teallach', prom: 10, lists: 'munro' }, 6)).toBe(true);
    expect(passes({ name: 'a bump', prom: 10 }, 6)).toBe(false);
  });

  it('still applies the ordinary notability filter to non-munro peaks', () => {
    expect(passes({ name: 'Bobotov Kuk', prom: 1483 }, 6)).toBe(true);
    expect(passes({ name: 'Savin kuk', prom: 93 }, 6)).toBe(false);
  });

  it('draws no summit with nothing to write beside it', () => {
    // East of Encamp: 227 m of prominence, no name, no height — a dot nobody could read.
    expect(passes({ prom: 227.2 }, 12)).toBe(false);
    expect(passes({ prom: 227.2, ele: 2100 }, 12)).toBe(true);
    expect(passes({ prom: 227.2, name: 'Tossal' }, 12)).toBe(true);
  });

  it('is what addPeaksLayer actually filters on', () => {
    expect(JSON.stringify(peaksLayer().layer.filter)).toBe(JSON.stringify(PEAKS_RENDER_FILTER));
  });
});

describe('munro styling', () => {
  it('prefixes the label and swaps the dot for a munro, not just a symbol change', () => {
    const { layer } = peaksLayer();

    // Shape (▲ prefix), not colour alone — a munro must read as one on a greyscale screen.
    expect(JSON.stringify(layer.layout['text-field'])).toContain('▲');
    // And the dot still differs, in colour and size, as a second, redundant cue.
    const [op, test, munroImage, peakImage] = layer.layout['icon-image'];
    expect(op).toBe('case');
    expect(JSON.stringify(test)).toContain('munro');
    expect(munroImage).not.toBe(peakImage);
  });
});

describe('peakAt', () => {
  /** getLayer returns truthy for every id, i.e. the layers have finished loading. */
  const layersReady = () => vi.fn().mockReturnValue({});

  it('returns the topmost hit properties', () => {
    const map = {
      getLayer: layersReady(),
      queryRenderedFeatures: vi.fn().mockReturnValue([
        { properties: { name: 'Ben Nevis', ele: 1345 } },
        { properties: { name: 'Other' } },
      ]),
    } as unknown as MLMap;

    expect(peakAt(map, [10, 10])).toEqual({
      properties: { name: 'Ben Nevis', ele: 1345 },
      lngLat: null,
    });
  });

  it('returns null when nothing is under the point', () => {
    const map = {
      getLayer: layersReady(),
      queryRenderedFeatures: vi.fn().mockReturnValue([]),
    } as unknown as MLMap;
    expect(peakAt(map, [10, 10])).toBeNull();
  });

  it('returns null instead of throwing when the peaks layer is not added yet', () => {
    // Pointer handlers are live before the map's `load` event adds the layer.
    // queryRenderedFeatures throws on an unknown layer id, so it must not be called.
    const queryRenderedFeatures = vi.fn(() => {
      throw new Error("The layer 'peaks-symbol' does not exist in the map's style");
    });
    const map = {
      getLayer: vi.fn().mockReturnValue(undefined),
      queryRenderedFeatures,
    } as unknown as MLMap;

    expect(peakAt(map, [10, 10])).toBeNull();
    expect(queryRenderedFeatures).not.toHaveBeenCalled();
  });

  it('queries the summits layer, which carries both the dot and the name', () => {
    const queryRenderedFeatures = vi.fn().mockReturnValue([]);
    const map = {
      getLayer: vi.fn((id: string) => (id === PEAKS_LAYER_ID ? {} : undefined)),
      queryRenderedFeatures,
    } as unknown as MLMap;

    peakAt(map, [10, 10]);

    expect(queryRenderedFeatures).toHaveBeenCalledWith([10, 10], { layers: [PEAKS_LAYER_ID] });
  });

  it('reports the summit position, not the queried point', () => {
    const map = {
      getLayer: layersReady(),
      queryRenderedFeatures: vi
        .fn()
        .mockReturnValue([peakFeature('Ben Nevis', [-5.0037, 56.7969])]),
    } as unknown as MLMap;

    expect(peakAt(map, [10, 10])?.lngLat).toEqual([-5.0037, 56.7969]);
  });
});

describe('peakAt on a touch screen', () => {
  const layersReady = () => vi.fn().mockReturnValue({});

  it('queries a box around the tap rather than the single tapped pixel', () => {
    const queryRenderedFeatures = vi.fn().mockReturnValue([]);
    const map = { getLayer: layersReady(), queryRenderedFeatures } as unknown as MLMap;

    peakAt(map, [100, 200], 22);

    expect(queryRenderedFeatures).toHaveBeenCalledWith(
      [
        [78, 178],
        [122, 222],
      ],
      { layers: [PEAKS_LAYER_ID] },
    );
  });

  it('accepts a Point object as well as a tuple', () => {
    const queryRenderedFeatures = vi.fn().mockReturnValue([]);
    const map = { getLayer: layersReady(), queryRenderedFeatures } as unknown as MLMap;

    peakAt(map, { x: 100, y: 200 } as unknown as PointLike, 22);

    expect(queryRenderedFeatures.mock.calls[0][0]).toEqual([
      [78, 178],
      [122, 222],
    ]);
  });

  it('picks the summit nearest the tap, not the first feature returned', () => {
    // Reproduces what the running app does: queryRenderedFeatures returns features in
    // render order, so the far peak can come back first.
    const far = peakFeature('Ben Lawers', [-4.22, 56.54]);
    const near = peakFeature('Ben Chonzie', [-3.99, 56.45]);

    const map = {
      getLayer: layersReady(),
      queryRenderedFeatures: vi.fn().mockReturnValue([far, near]),
      project: vi.fn((coordinates: [number, number]) =>
        coordinates[0] === -4.22 ? { x: 118, y: 200 } : { x: 104, y: 203 },
      ),
    } as unknown as MLMap;

    expect(peakAt(map, [100, 200], 22)?.properties.name).toBe('Ben Chonzie');
  });

  it('still answers when the nearest candidate carries no geometry', () => {
    const map = {
      getLayer: layersReady(),
      queryRenderedFeatures: vi.fn().mockReturnValue([{ properties: { name: 'Ben Nevis' } }]),
      project: vi.fn(),
    } as unknown as MLMap;

    expect(peakAt(map, [100, 200], 22)).toEqual({
      properties: { name: 'Ben Nevis' },
      lngLat: null,
    });
  });

  it('does not pad a mouse pointer', () => {
    const queryRenderedFeatures = vi.fn().mockReturnValue([]);
    const map = { getLayer: layersReady(), queryRenderedFeatures } as unknown as MLMap;

    peakAt(map, [100, 200], 0);

    expect(queryRenderedFeatures.mock.calls[0][0]).toEqual([100, 200]);
  });
});

/** A feature shaped the way a vector-tile point layer returns one. */
function peakFeature(name: string, coordinates: [number, number]) {
  return { properties: { name }, geometry: { type: 'Point', coordinates } };
}
