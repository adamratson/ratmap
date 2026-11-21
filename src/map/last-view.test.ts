import { describe, expect, it } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { DEFAULT_VIEW, readLastView, rememberView } from './last-view';

function memoryStorage(initial?: string) {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set('ratmap.view', initial);
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

function fakeMap(view: { lng: number; lat: number; zoom: number; bearing: number; pitch: number }) {
  const handlers: Record<string, () => void> = {};
  return {
    on: (event: string, handler: () => void) => {
      handlers[event] = handler;
    },
    getCenter: () => ({ lng: view.lng, lat: view.lat }),
    getZoom: () => view.zoom,
    getBearing: () => view.bearing,
    getPitch: () => view.pitch,
    settle: () => handlers.moveend?.(),
  };
}

describe('the view ratmap opens at', () => {
  it('is where the map last came to rest', () => {
    const storage = memoryStorage();
    const map = fakeMap({ lng: -5.0036, lat: 56.7969, zoom: 14.234, bearing: 12.34, pitch: 0 });
    rememberView(map as unknown as MLMap, storage);
    map.settle();

    expect(readLastView(storage)).toEqual({
      center: [-5.0036, 56.7969],
      zoom: 14.23,
      bearing: 12.3,
      pitch: 0,
    });
  });

  it('is the Highlands, whole, with nothing remembered', () => {
    expect(readLastView(memoryStorage())).toEqual(DEFAULT_VIEW);
    expect(readLastView(null)).toEqual(DEFAULT_VIEW);
  });

  it('ignores anything stored that is not a view, rather than breaking the map with it', () => {
    for (const junk of [
      'not json',
      '{"center":[1],"zoom":10}',
      '{"center":[1,2],"zoom":"10"}',
      '{"center":[1,2],"zoom":null}',
      '{"center":[1,95],"zoom":10}',
      '{"center":[1,2],"zoom":99}',
    ]) {
      expect(readLastView(memoryStorage(junk)), junk).toEqual(DEFAULT_VIEW);
    }
  });

  it('brings a longitude from a repeated world copy back into range', () => {
    const view = readLastView(memoryStorage('{"center":[355,56.8],"zoom":10}'));
    expect(view.center[0]).toBeCloseTo(-5);
    expect(view).toMatchObject({ bearing: 0, pitch: 0 });
  });
});
