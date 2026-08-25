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
    once(event: string, cb: (e: unknown) => void): void {
      (handlers[event] ??= []).push(cb);
    }
    setStyle(): void {}
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
    getBearing(): number {
      return 0;
    }
    getPitch(): number {
      return 0;
    }
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
    NavigationControl: navigationControlSpy,
    ScaleControl: vi.fn(),
    addProtocol: addProtocolSpy,
  },
  Marker: MarkerMock,
}));

const navigationControlSpy = vi.hoisted(() => vi.fn());
const namedFlavorSpy = vi.hoisted(() => vi.fn((name: string) => ({ name })));
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@protomaps/basemaps', () => ({
  layers: () => [],
  namedFlavor: namedFlavorSpy,
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
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  navigationControlSpy.mockClear();
  namedFlavorSpy.mockClear();
  // jsdom's localStorage is not always usable in this runner, and the theme controller
  // deliberately survives storage being unavailable — so give it a real one to assert on.
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
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

  it('keeps the destinations in reach at rest, and reports which one is open', async () => {
    // These were four buttons floating over the bottom-right of the map. The planning
    // panel covered them outright, so they could not report anything at all.
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    await loadMainQuietly();

    const chips = [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Routes', 'Offline', 'Saved']);

    const sheet = document.querySelector<HTMLElement>('#sheet')!;
    expect(sheet.classList.contains('at-peek')).toBe(true);

    document.querySelector<HTMLButtonElement>('#chips .chip')!.click();

    expect(sheet.classList.contains('at-peek')).toBe(false);
    expect(document.querySelector('#chips .chip')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('gives every destination its own way back to the map', async () => {
    // Each panel used to carry its own × in its own corner. Tapping the chip that opened
    // a view now closes it, and so does dragging the sheet down from anywhere.
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    await loadMainQuietly();

    const sheet = document.querySelector<HTMLElement>('#sheet')!;
    const chip = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('#chips .chip')!;

    chip().click();
    expect(sheet.classList.contains('at-peek')).toBe(false);

    chip().click();
    expect(sheet.classList.contains('at-peek')).toBe(true);
    expect(sheet.querySelector('.sheet-body')!.innerHTML).toBe('');
  });

  it('drops the zoom cluster on a touch screen, where pinch already does the job', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    await loadMainQuietly();

    expect(navigationControlSpy).not.toHaveBeenCalled();
    // The compass replaces the only part of it a finger actually needs.
    expect(document.querySelector('#compass-btn')).not.toBeNull();
  });

  it('gives a keyboard user a way out, now that the panels have no close buttons', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    await loadMainQuietly();

    const sheet = document.querySelector<HTMLElement>('#sheet')!;
    document.querySelector<HTMLButtonElement>('#chips .chip')!.click();
    expect(sheet.classList.contains('at-peek')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(sheet.classList.contains('at-peek')).toBe(true);
  });

  it('names the sheet contents, so it is not announced as an unlabelled region', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    await loadMainQuietly();

    const body = document.querySelector<HTMLElement>('.sheet-body')!;
    expect(body.getAttribute('role')).toBe('region');
    expect(body.hasAttribute('aria-label')).toBe(false);

    document.querySelector<HTMLButtonElement>('#chips .chip')!.click();
    expect(body.getAttribute('aria-label')).toBe('Routes');
  });

  it('paints the theme before the map, so first paint is not a white flash', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    await loadMainQuietly();

    expect(document.documentElement.dataset.theme).toBe('dark');
    // The basemap flavour has to follow, or a dark UI frames a white map.
    expect(namedFlavorSpy).toHaveBeenCalledWith('dark');
  });

  it('lets the user override the device, and remembers it', async () => {
    // People turn the map dark before they turn the phone dark: dusk on a hill arrives
    // long before the phone's schedule thinks it has.
    bootstrapStorageMock.mockResolvedValue({ supported: true, persisted: true });
    await loadMainQuietly();

    const button = document.querySelector<HTMLButtonElement>('#theme-btn')!;
    button.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(button.getAttribute('aria-label')).toMatch(/light/i);

    button.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(store.get('ratmap.theme')).toBe('dark');

    button.click();
    expect(store.get('ratmap.theme')).toBe('system');
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
    expect(sheet.classList.contains('at-peek')).toBe(false);
    expect(sheet.textContent).toMatch(/evicted|guarantee/i);
    expect(sheet.querySelectorAll('.install-steps li').length).toBeGreaterThan(0);
  });
});
