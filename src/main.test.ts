import { beforeEach, describe, expect, it, vi } from 'vitest';

// main.ts runs its bootstrap as module-level side effects (map construction, protocol
// registration, status rendering) rather than an exported function, so it's tested by
// importing it fresh (vi.resetModules + dynamic import) against mocked collaborators
// and asserting on the DOM / spy calls it produces.

const { MapMock, mapCtorSpy, handlers, addProtocolSpy, MarkerMock, mapInstances } = vi.hoisted(
  () => {
    const mapCtorSpy = vi.fn();
    const addProtocolSpy = vi.fn();
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const mapInstances: MapMock[] = [];

  class MapMock {
    constructor(options: unknown) {
      mapCtorSpy(options);
      mapInstances.push(this);
    }
    addControl(): void {}
    on(event: string, cb: (e: unknown) => void): void {
      (handlers[event] ??= []).push(cb);
    }
    getSource(): undefined {
      return undefined;
    }
    addSource(): void {}
    addLayer(): void {}
    getLayer(): undefined {
      return undefined;
    }
    removeLayer(): void {}
    removeSource(): void {}
    isStyleLoaded(): boolean {
      return true;
    }
    easeTo(): void {}
    zoom = 6;
    getZoom(): number {
      return this.zoom;
    }
    getCenter(): { lat: number; lng: number } {
      return { lat: 56.8, lng: -4.5 };
    }
    queryRenderedFeatures(): unknown[] {
      return [];
    }
    getCanvas(): { style: Record<string, string> } {
      return { style: {} };
    }
  }

    class MarkerMock {
      setLngLat(): this {
        return this;
      }
      addTo(): this {
        return this;
      }
      remove(): void {}
    }

    return { MapMock, mapCtorSpy, handlers, addProtocolSpy, MarkerMock, mapInstances };
  },
);

vi.mock('maplibre-gl', () => ({
  default: {
    Map: MapMock,
    Marker: MarkerMock,
    NavigationControl: vi.fn(),
    ScaleControl: vi.fn(),
    addProtocol: addProtocolSpy,
  },
  Marker: MarkerMock,
}));

const mountOpfsSpikeSpy = vi.hoisted(() => vi.fn());
vi.mock('./opfs-spike', () => ({ mountOpfsSpike: mountOpfsSpikeSpy }));

const bootstrapStorageMock = vi.hoisted(() => vi.fn());
const isStandaloneMock = vi.hoisted(() => vi.fn());
vi.mock('./storage', () => ({
  bootstrapStorage: bootstrapStorageMock,
  isStandalone: isStandaloneMock,
}));

// IndexedDB isn't in jsdom; saved-places is exercised by its own tests.
vi.mock('./saved-places', () => ({
  listPlaces: vi.fn().mockResolvedValue([]),
  savePlace: vi.fn().mockResolvedValue(undefined),
  deletePlace: vi.fn().mockResolvedValue(undefined),
}));

async function loadMain(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  await vi.waitFor(() => {
    if (!document.querySelector('.status-card')) throw new Error('status not rendered yet');
  });
}

beforeEach(() => {
  vi.resetModules();
  mapCtorSpy.mockClear();
  addProtocolSpy.mockClear();
  for (const key of Object.keys(handlers)) delete handlers[key];
  mapInstances.length = 0;
  mountOpfsSpikeSpy.mockClear();
  bootstrapStorageMock.mockReset();
  isStandaloneMock.mockReset();
  isStandaloneMock.mockReturnValue(false);
});

describe('app bootstrap', () => {
  it('registers the pmtiles protocol exactly once (C17)', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    expect(addProtocolSpy).toHaveBeenCalledTimes(1);
    expect(addProtocolSpy.mock.calls[0]?.[0]).toBe('pmtiles');
  });

  it('builds the style from our own R2 archives, both routed through the registry', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    const options = mapCtorSpy.mock.calls[0]?.[0];
    expect(options.style.sources.basemap.url).toMatch(/^pmtiles:\/\/https:\/\//);
    expect(options.style.sources.terrain.url).toMatch(/^pmtiles:\/\/https:\/\//);
    expect(options.style.sources.terrain.type).toBe('raster-dem');
    expect(options.style.sources.terrain.encoding).toBe('terrarium');
    expect(options.style.layers.some((l: { id: string }) => l.id === 'hillshade')).toBe(true);
  });

  it('caps source maxzoom to the archives, so layers do not vanish when overzoomed', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    const sources = mapCtorSpy.mock.calls[0]?.[0].style.sources;
    expect(sources.basemap.maxzoom).toBe(5);
    expect(sources.terrain.maxzoom).toBe(4);
  });

  it('keeps attribution expanded — ODbL credit must not auto-hide (legal requirement)', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    const options = mapCtorSpy.mock.calls[0]?.[0];
    expect(options.attributionControl).toEqual({ compact: false });
    expect(options.style.sources.basemap.attribution).toContain('openstreetmap.org/copyright');
  });

  it('renders a visible error banner when the map reports an error, instead of failing silently', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();
    handlers.error?.[0]?.({ error: new Error('boom') });

    expect(document.querySelector('.status-card.error')?.textContent).toContain('boom');
  });

  it('wires the OPFS spike harness with the registry protocol and map instance', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();
    handlers.load?.[0]?.({});

    expect(mountOpfsSpikeSpy).toHaveBeenCalledTimes(1);
    expect(mountOpfsSpikeSpy.mock.calls[0]?.[1].map).toBeInstanceOf(MapMock);
  });

  it.each([
    [{ supported: false }, /unsupported/i],
    [{ supported: true, persisted: true }, /granted/i],
  ] as const)('storage status %j -> banner matches %s', async (status, expected) => {
    bootstrapStorageMock.mockResolvedValue(status);

    await loadMain();

    const banner = document.querySelector('.status-card.warn, .status-card.ok');
    expect(banner?.textContent).toMatch(expected);
  });

  it('surfaces the catalog-only zoom ceiling instead of silently showing a stretched map', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();
    const notice = document.querySelector<HTMLElement>('#detail-notice')!;

    // Within the archive's range: nothing to say.
    handlers.zoom?.[0]?.({});
    expect(notice.hidden).toBe(true);

    // Zoomed well past what the world catalog holds.
    (mapInstances[0] as unknown as { zoom: number }).zoom = 12;
    handlers.zoom?.[0]?.({});

    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toMatch(/detail/i);
    expect(notice.title).toMatch(/offline region/i);
  });

  it('walks iOS users through Add to Home Screen when storage is not persisted (C2)', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: false });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    );

    await loadMain();

    const banner = document.querySelector('.status-card.warn');
    expect(banner?.textContent).toMatch(/Home Screen/i);
    // The rationale must be present: install is what *gates* the storage guarantee,
    // so the UI has to say why rather than nagging.
    expect(banner?.textContent).toMatch(/evicted|guarantee/i);
    expect(banner?.querySelectorAll('ol li').length).toBeGreaterThan(0);
  });
});
