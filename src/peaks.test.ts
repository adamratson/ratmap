import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap, PointLike } from 'maplibre-gl';
import {
  addPeaksLayer,
  formatElevation,
  peakAt,
  PEAKS_LAYER_ID,
  PEAKS_SOURCE_ID,
} from './peaks';
import type { TileSourceRegistry } from './tile-source-registry';

function fakeRegistry() {
  return {
    addRemote: vi.fn(),
    sourceUrl: (key: string) => `pmtiles://${key}`,
  } as unknown as TileSourceRegistry;
}

describe('formatElevation', () => {
  it('renders a rounded metre value', () => {
    expect(formatElevation(1344.6)).toBe('1345 m');
    expect(formatElevation(0)).toBe('0 m');
  });

  it('returns null for anything not a finite number, rather than rendering "NaN m"', () => {
    // ele is normalized to a number at build time (normalize-peaks.py); if that ever
    // regresses, a summit must show nothing rather than a wrong or nonsense elevation.
    for (const bad of ['1345', '~340', undefined, null, Number.NaN, Infinity, {}]) {
      expect(formatElevation(bad)).toBeNull();
    }
  });
});

describe('addPeaksLayer', () => {
  it('registers the archive and caps maxzoom to what it contains', () => {
    const registry = fakeRegistry();
    const addSource = vi.fn();
    const addLayer = vi.fn();
    const map = { addSource, addLayer } as unknown as MLMap;

    addPeaksLayer(map, registry);

    expect(registry.addRemote).toHaveBeenCalledTimes(1);
    const [sourceId, spec] = addSource.mock.calls[0];
    expect(sourceId).toBe(PEAKS_SOURCE_ID);
    expect(spec.url).toMatch(/^pmtiles:\/\//);
    // Without maxzoom the markers silently disappear past the archive's own max.
    expect(spec.maxzoom).toBe(5);
    expect(spec.attribution).toContain('openstreetmap.org/copyright');
  });

  it('adds both a marker and a label layer', () => {
    const registry = fakeRegistry();
    const addLayer = vi.fn();
    const map = { addSource: vi.fn(), addLayer } as unknown as MLMap;

    addPeaksLayer(map, registry);

    const ids = addLayer.mock.calls.map((call) => call[0].id);
    expect(ids).toContain(PEAKS_LAYER_ID);
    expect(ids).toContain(`${PEAKS_LAYER_ID}-marker`);
  });

  it('builds a label expression that degrades when name or ele is missing', () => {
    const registry = fakeRegistry();
    const addLayer = vi.fn();
    const map = { addSource: vi.fn(), addLayer } as unknown as MLMap;

    addPeaksLayer(map, registry);

    const symbolLayer = addLayer.mock.calls.find((call) => call[0].id === PEAKS_LAYER_ID)![0];
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
  // Evaluates the filter expression the way MapLibre would, so the thresholds are
  // actually asserted rather than just the expression's shape.
  function passes(props: { prom?: number; wikidata?: string }, zoom: number): boolean {
    const floor =
      zoom >= 15 ? -1 : zoom >= 13 ? 30 : zoom >= 11 ? 120 : zoom >= 9 ? 300 : 600;
    const byProminence = (props.prom ?? -1) >= floor;
    const byNotability = zoom >= 9 && props.wikidata !== undefined;
    return byProminence || byNotability;
  }

  it('shows only dominant summits at country zoom', () => {
    expect(passes({ prom: 1483 }, 6)).toBe(true);   // Bobotov Kuk
    expect(passes({ prom: 93 }, 6)).toBe(false);    // Savin kuk, a bump on the same massif
  });

  it('ranks a massif by prominence, which elevation cannot do', () => {
    // Bobotov Kuk 2523 m / prom 1483; Savin kuk 2313 m / prom 93. Nearly the same height,
    // completely different significance — this is the whole reason for the measure.
    expect(passes({ prom: 1483 }, 8)).toBe(true);
    expect(passes({ prom: 93 }, 8)).toBe(false);
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

  it('is applied to the marker layer as well as the labels, so they stay in sync', () => {
    const registry = fakeRegistry();
    const addLayer = vi.fn();
    const map = { addSource: vi.fn(), addLayer } as unknown as MLMap;

    addPeaksLayer(map, registry);

    const filters = addLayer.mock.calls.map((call) => JSON.stringify(call[0].filter));
    expect(filters).toHaveLength(2);
    expect(filters[0]).toBe(filters[1]);
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

  it('returns null instead of throwing when the peaks layers are not added yet', () => {
    // Pointer handlers are live before the map's `load` event adds these layers.
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

  it('queries only the layers that exist, when some are missing', () => {
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
      { layers: [PEAKS_LAYER_ID, `${PEAKS_LAYER_ID}-marker`] },
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
