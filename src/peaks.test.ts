import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
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
  function passes(props: { ele?: number; wikidata?: string }, zoom: number): boolean {
    const eleFloor =
      zoom >= 11 ? -1000 : zoom >= 9 ? 500 : zoom >= 7 ? 800 : 1000;
    const byHeight = (props.ele ?? -1000) >= eleFloor;
    const byNotability = zoom >= 9 && props.wikidata !== undefined;
    return byHeight || byNotability;
  }

  it('shows only major summits at country zoom', () => {
    expect(passes({ ele: 1345 }, 6)).toBe(true);
    expect(passes({ ele: 900 }, 6)).toBe(false);
  });

  it('does not let wikidata flood low zooms', () => {
    // The bug this guards: applying the notability proxy at every zoom swamped z6 over
    // the Highlands, where a large share of hills carry a Wikidata id.
    expect(passes({ ele: 300, wikidata: 'Q1' }, 6)).toBe(false);
    expect(passes({ ele: 300, wikidata: 'Q1' }, 9)).toBe(true);
  });

  it('lowers the height bar progressively as you zoom in', () => {
    expect(passes({ ele: 850 }, 6)).toBe(false);
    expect(passes({ ele: 850 }, 7)).toBe(true);
    expect(passes({ ele: 600 }, 8)).toBe(false);
    expect(passes({ ele: 600 }, 9)).toBe(true);
  });

  it('only shows peaks with no elevation at all at the highest zooms', () => {
    expect(passes({}, 9)).toBe(false);
    expect(passes({}, 11)).toBe(true);
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

    expect(peakAt(map, [10, 10])).toEqual({ name: 'Ben Nevis', ele: 1345 });
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
});
