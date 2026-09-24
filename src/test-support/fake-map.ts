import { vi } from 'vitest';

/**
 * Just enough of a MapLibre map to add sources and layers to and read them back.
 *
 * GeoJSON sources remember the last `setData`, so a test can assert on what was drawn.
 * `addLayer` honours `beforeId`, because layer order is often the thing under test.
 */
export function fakeStyleMap() {
  const layers: Array<Record<string, unknown>> = [];
  const sources = new Map<string, { type: string; data?: unknown; setData: (data: unknown) => void }>();
  return {
    layers,
    sources,
    addSource: vi.fn((id: string, spec: { type: string; data?: unknown }) => {
      const source = {
        type: spec.type,
        data: spec.data,
        setData(data: unknown) {
          source.data = data;
        },
      };
      sources.set(id, source);
    }),
    getSource: vi.fn((id: string) => sources.get(id)),
    addLayer: vi.fn((layer: Record<string, unknown>, beforeId?: string) => {
      const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (at >= 0) layers.splice(at, 0, layer);
      else layers.push(layer);
    }),
    getLayer: vi.fn((id: string) => layers.find((l) => l.id === id)),
    getLayersOrder: vi.fn(() => layers.map((l) => String(l.id))),
  };
}
