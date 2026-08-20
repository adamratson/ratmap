import { beforeEach, describe, expect, it, vi } from 'vitest';

// main.ts runs its bootstrap as module-level side effects (map construction, protocol
// registration, status rendering) rather than an exported function, so it's tested by
// importing it fresh (vi.resetModules + dynamic import) against mocked collaborators
// and asserting on the DOM / spy calls it produces.

const { MapMock, mapCtorSpy, errorHandlers, addProtocolSpy } = vi.hoisted(() => {
  const mapCtorSpy = vi.fn();
  const addProtocolSpy = vi.fn();
  const errorHandlers: Array<(e: { error?: Error }) => void> = [];

  class MapMock {
    constructor(options: unknown) {
      mapCtorSpy(options);
    }
    addControl(): void {}
    on(event: string, cb: (e: { error?: Error }) => void): void {
      if (event === 'error') errorHandlers.push(cb);
    }
    getSource(): undefined {
      return undefined;
    }
    addSource(): void {}
  }

  return { MapMock, mapCtorSpy, errorHandlers, addProtocolSpy };
});

vi.mock('maplibre-gl', () => ({
  default: {
    Map: MapMock,
    NavigationControl: vi.fn(),
    addProtocol: addProtocolSpy,
  },
}));

const mountOpfsSpikeSpy = vi.hoisted(() => vi.fn());
vi.mock('./opfs-spike', () => ({ mountOpfsSpike: mountOpfsSpikeSpy }));

const bootstrapStorageMock = vi.hoisted(() => vi.fn());
const isStandaloneMock = vi.hoisted(() => vi.fn());
vi.mock('./storage', () => ({
  bootstrapStorage: bootstrapStorageMock,
  isStandalone: isStandaloneMock,
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
  errorHandlers.length = 0;
  mountOpfsSpikeSpy.mockClear();
  bootstrapStorageMock.mockReset();
  isStandaloneMock.mockReset();
});

describe('app bootstrap', () => {
  it('registers the pmtiles protocol exactly once (C17)', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    expect(addProtocolSpy).toHaveBeenCalledTimes(1);
    expect(addProtocolSpy.mock.calls[0]?.[0]).toBe('pmtiles');
  });

  it('constructs the map with the demo basemap and fallback hillshade sources', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    expect(mapCtorSpy).toHaveBeenCalledTimes(1);
    const options = mapCtorSpy.mock.calls[0]?.[0];
    expect(options.style.sources.basemap.url).toMatch(/^pmtiles:\/\/https:\/\//);
    expect(options.style.sources['terrain-fallback'].type).toBe('raster-dem');
    expect(
      options.style.layers.some((l: { id: string }) => l.id === 'hillshade'),
    ).toBe(true);
  });

  it('renders a visible error banner when the map reports an error, instead of failing silently', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();
    expect(errorHandlers).toHaveLength(1);
    errorHandlers[0]?.({ error: new Error('boom') });

    const banner = document.querySelector('.status-card.error');
    expect(banner?.textContent).toContain('boom');
  });

  it('wires the OPFS spike harness with the live protocol and map instance', async () => {
    bootstrapStorageMock.mockResolvedValue({ supported: false });

    await loadMain();

    expect(mountOpfsSpikeSpy).toHaveBeenCalledTimes(1);
    const deps = mountOpfsSpikeSpy.mock.calls[0]?.[1];
    expect(deps.map).toBeInstanceOf(MapMock);
  });

  it.each([
    [{ supported: false }, false, /unsupported/i],
    [{ supported: true, persisted: false }, false, /Add to Home Screen/i],
    [{ supported: true, persisted: false }, true, /must stay blocked/i],
    [{ supported: true, persisted: true }, true, /granted/i],
  ] as const)('storage status %j + standalone=%s -> banner matches %s', async (status, standalone, expected) => {
    bootstrapStorageMock.mockResolvedValue(status);
    isStandaloneMock.mockReturnValue(standalone);

    await loadMain();

    const banner = document.querySelector('.status-card.warn, .status-card.ok');
    expect(banner?.textContent).toMatch(expected);
  });
});
