import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region, RegionManifest } from './manifest';
import type { TileSourceRegistry } from '../map/tile-source-registry';

const deps = vi.hoisted(() => ({
  fetchManifest: vi.fn(),
  loadCachedManifest: vi.fn(),
  restoreDownloadedRegions: vi.fn(),
  renderFootprints: vi.fn(),
  applyAllStoredVisibility: vi.fn(),
}));

vi.mock('./manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manifest')>()),
  fetchManifest: deps.fetchManifest,
  loadCachedManifest: deps.loadCachedManifest,
}));
vi.mock('./regions-ui', () => ({ restoreDownloadedRegions: deps.restoreDownloadedRegions }));
vi.mock('./region-footprints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./region-footprints')>()),
  renderFootprints: deps.renderFootprints,
}));
vi.mock('../map/layers', () => ({ applyAllStoredVisibility: deps.applyAllStoredVisibility }));

const { RegionCoverage } = await import('./coverage');

const region = (id: string, name: string, bbox: Region['bbox'], maxzoom = 15): Region => ({
  id,
  name,
  bbox,
  totalBytes: 1,
  artifacts: [{ kind: 'basemap', filename: `${id}-basemap.pmtiles`, path: 'x', bytes: 1, maxzoom }],
});

const LOCHABER = region('lochaber', 'Lochaber', [-5.6, 56.5, -4.6, 57.1]);
const CAIRNGORMS = region('cairngorms', 'Cairngorms', [-4.2, 56.8, -3.2, 57.3]);
const MANIFEST: RegionManifest = { schemaVersion: 1, builtAt: 'x', regions: [LOCHABER, CAIRNGORMS] };

function fakeMap() {
  const handlers: Record<string, Array<() => void>> = {};
  const once: Record<string, Array<() => void>> = {};
  const view = { zoom: 6, lng: -5.0, lat: 56.8 };
  return {
    view,
    move(zoom: number, lng = view.lng, lat = view.lat) {
      Object.assign(view, { zoom, lng, lat });
      for (const handler of handlers.move ?? []) handler();
    },
    fireOnce(event: string) {
      const pending = once[event] ?? [];
      once[event] = [];
      for (const handler of pending) handler();
    },
    pendingOnce: (event: string) => (once[event] ?? []).length,
    on: (event: string, handler: () => void) => void (handlers[event] ??= []).push(handler),
    once: (event: string, handler: () => void) => void (once[event] ??= []).push(handler),
    getZoom: () => view.zoom,
    getCenter: () => ({ lng: view.lng, lat: view.lat }),
  };
}

let map: ReturnType<typeof fakeMap>;
let notice: HTMLButtonElement;
let onOpenRegions: Mock<() => void>;
let coverage: InstanceType<typeof RegionCoverage>;

beforeEach(() => {
  vi.clearAllMocks();
  deps.fetchManifest.mockResolvedValue(MANIFEST);
  deps.loadCachedManifest.mockReturnValue(null);
  deps.restoreDownloadedRegions.mockResolvedValue([]);
  map = fakeMap();
  notice = document.createElement('button');
  onOpenRegions = vi.fn();
  coverage = new RegionCoverage({
    map: map as unknown as MLMap,
    registry: {} as TileSourceRegistry,
    theme: () => 'dark',
    notice,
    onOpenRegions,
  });
  coverage.setStyleReady(true);
});

/** What the last footprint render drew, by region id. */
const drawnIds = () =>
  (deps.renderFootprints.mock.lastCall?.[1] as Array<{ region: Region }> | undefined)?.map((f) => f.region.id);

describe('restoring downloaded regions', () => {
  it('restores what is on disk and knows it for the router', async () => {
    deps.restoreDownloadedRegions.mockResolvedValue([LOCHABER]);

    await coverage.restore();

    expect(deps.restoreDownloadedRegions).toHaveBeenCalledWith(map, {}, MANIFEST.regions, 'dark');
    expect(coverage.downloadedRegions()).toEqual([LOCHABER]);
    expect(drawnIds()).toEqual(['lochaber']);
  });

  it('falls back to the last catalogue it saw when offline — the cold offline start', async () => {
    deps.fetchManifest.mockRejectedValue(new TypeError('Failed to fetch'));
    deps.loadCachedManifest.mockReturnValue(MANIFEST);
    deps.restoreDownloadedRegions.mockResolvedValue([LOCHABER]);

    await coverage.restore();

    expect(coverage.downloadedRegions()).toEqual([LOCHABER]);
  });

  it('is quiet, not an error, offline with no catalogue ever seen', async () => {
    deps.fetchManifest.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(coverage.restore()).resolves.toBeUndefined();
    expect(coverage.downloadedRegions()).toEqual([]);
  });

  it('re-applies layer visibility after drawing the outlines', async () => {
    await coverage.restore();
    expect(deps.applyAllStoredVisibility).toHaveBeenCalledWith(map);
  });
});

describe('drawing the coverage outlines', () => {
  it('waits for a style that will accept them, then draws', async () => {
    // A restore can finish before the style exists; addSource would throw.
    coverage.setStyleReady(false);
    deps.restoreDownloadedRegions.mockResolvedValue([LOCHABER]);

    await coverage.restore();
    expect(deps.renderFootprints).not.toHaveBeenCalled();
    expect(map.pendingOnce('styledata')).toBe(1);

    coverage.setStyleReady(true);
    map.fireOnce('styledata');
    expect(drawnIds()).toEqual(['lochaber']);
  });
});

describe('the detail notice', () => {
  it('stays hidden while the map has real data at this zoom', async () => {
    await coverage.restore();
    map.move(6);
    expect(notice.hidden).toBe(true);
  });

  it('names the download that fixes a stretched map', async () => {
    await coverage.restore();
    map.move(12, -5.0, 56.8);

    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('Limited detail here — get Lochaber');
  });

  it('follows the map on a pan, not only on a zoom', async () => {
    await coverage.restore();
    map.move(12, -5.0, 56.8);
    map.move(12, -3.7, 57.05);

    expect(notice.textContent).toBe('Limited detail here — get Cairngorms');
    // And outlines what it is offering.
    expect(drawnIds()).toEqual(['cairngorms']);
  });

  it('falls back to a plain warning where no region covers the view', async () => {
    await coverage.restore();
    map.move(12, 20, 0);

    expect(notice.textContent).toBe('Limited detail at this zoom');
  });

  it('goes away over a downloaded region, whose data reaches this zoom', async () => {
    deps.restoreDownloadedRegions.mockResolvedValue([LOCHABER]);
    await coverage.restore();
    map.move(12, -5.0, 56.8);

    expect(notice.hidden).toBe(true);
  });

  it('comes back after the region is deleted — the ceiling is lowered, not only raised', async () => {
    deps.restoreDownloadedRegions.mockResolvedValue([LOCHABER]);
    await coverage.restore();
    deps.restoreDownloadedRegions.mockResolvedValue([]);
    await coverage.restore();

    map.move(12, -5.0, 56.8);
    expect(notice.hidden).toBe(false);
  });

  it('redraws the outlines only when the offered region changes, not on every frame', async () => {
    await coverage.restore();
    deps.renderFootprints.mockClear();

    for (let i = 0; i < 10; i++) map.move(12 + i * 0.1, -5.0, 56.8);

    expect(deps.renderFootprints).toHaveBeenCalledTimes(1);
  });

  it('opens the regions sheet when tapped', () => {
    notice.click();
    expect(onOpenRegions).toHaveBeenCalled();
  });
});
