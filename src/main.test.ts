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

/**
 * jsdom ships no ResizeObserver. main.ts uses one to keep toasts clear of whichever
 * bottom panel is open; the measurement itself is a layout concern jsdom cannot report on
 * anyway, so a no-op stub is the honest stand-in.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

async function loadMain(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  await vi.waitFor(() => {
    if (!document.querySelector('.condition')) throw new Error('status not rendered yet');
  });
}

/** For the cases where storage is fine and so reports nothing at all. */
async function loadMainQuietly(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  await vi.waitFor(() => {
    if (!document.querySelector('#toasts')) throw new Error('app not mounted yet');
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.resetModules();
  mapCtorSpy.mockClear();
  addProtocolSpy.mockClear();
  for (const key of Object.keys(handlers)) delete handlers[key];
  mapInstances.length = 0;
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

    expect(document.querySelector('.condition.error')?.textContent).toContain('boom');
  });

  it('says plainly that downloads are off when the browser cannot keep them', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    const condition = document.querySelector('.condition.warn');
    expect(condition?.textContent).toMatch(/downloads are off/i);
    // Constraint ids belong in the spec, not over someone's map.
    expect(condition?.textContent).not.toMatch(/\(C\d+\)/);
  });

  it('says nothing at all once storage is persistent', async () => {
    // The working case used to announce itself on every launch, which is a banner over
    // the map for a state nobody has to act on.
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });

    await loadMainQuietly();

    await vi.waitFor(() => {
      expect(document.querySelector('#conditions')?.hasAttribute('hidden')).toBe(true);
    });
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
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

  it('reports lost connection once, not once per failed tile', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });
    await loadMain();

    // MapLibre fires one error per tile; offline that is dozens within a second.
    for (let i = 0; i < 12; i++) {
      handlers.error?.[0]?.({ error: new TypeError('Failed to fetch') });
    }

    const offline = [...document.querySelectorAll('.condition')].filter((c) =>
      /no connection/i.test(c.textContent ?? ''),
    );
    expect(offline).toHaveLength(1);
  });

  it('takes the offline notice back down once tiles load again', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    await loadMainQuietly();

    handlers.error?.[0]?.({ error: new TypeError('Failed to fetch') });
    expect(document.querySelector('.condition.warn')?.textContent).toMatch(/no connection/i);

    handlers.sourcedata?.[0]?.({ isSourceLoaded: true });

    expect(document.querySelector('#conditions')?.hasAttribute('hidden')).toBe(true);
  });

  it('distinguishes a real map fault from lost connection', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });
    await loadMain();

    // A genuine style/data bug must not be disguised as "no connection" — that would hide
    // real faults behind a reassuring message.
    handlers.error?.[0]?.({ error: new TypeError("layer 'x' does not exist") });

    expect(document.querySelector('.condition.error')?.textContent).toMatch(/does not exist/);
    expect(document.body.textContent ?? '').not.toMatch(/no connection/i);
  });

  it('walks iOS users through Add to Home Screen when storage is not persisted (C2)', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: false });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    );

    await loadMain();

    const condition = document.querySelector('.condition.warn')!;
    expect(condition.textContent).toMatch(/Home Screen/i);

    // The three Share-sheet steps no longer sit permanently over the map, so they have to
    // be one tap away — and the rationale has to come with them, because install is what
    // *gates* the storage guarantee and the UI must say why rather than nagging.
    condition.querySelector<HTMLButtonElement>('.condition-action')!.click();

    const sheet = document.querySelector<HTMLElement>('#sheet')!;
    expect(sheet.hidden).toBe(false);
    expect(sheet.textContent).toMatch(/evicted|guarantee/i);
    expect(sheet.querySelectorAll('.install-steps li').length).toBeGreaterThan(0);
  });
});
