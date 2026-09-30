import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';

const fetchManifestMock = vi.hoisted(() => vi.fn());
const loadCachedManifestMock = vi.hoisted(() => vi.fn((): unknown => null));
const regionStatusesMock = vi.hoisted(() => vi.fn());
const deleteRegionMock = vi.hoisted(() => vi.fn());
const removeRegionFromMapMock = vi.hoisted(() => vi.fn());
const readStorageMock = vi.hoisted(() => vi.fn());
const downloadsInFlightMock = vi.hoisted(() => vi.fn(() => 0));
const findOrphansMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const deleteOrphanMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manifest')>()),
  fetchManifest: fetchManifestMock,
  loadCachedManifest: loadCachedManifestMock,
}));

vi.mock('./downloader', () => ({
  regionStatuses: regionStatusesMock,
  deleteRegion: deleteRegionMock,
  downloadRegion: vi.fn(),
  downloadsInFlight: downloadsInFlightMock,
  DownloadCancelled: class DownloadCancelled extends Error {},
  DownloadStalled: class DownloadStalled extends Error {},
}));

vi.mock('./region-layers', () => ({
  addRegionToMap: vi.fn(),
  removeRegionFromMap: removeRegionFromMapMock,
}));

vi.mock('./orphans', () => ({
  findOrphans: findOrphansMock,
  deleteOrphan: deleteOrphanMock,
}));

vi.mock('./storage-budget', () => ({
  readStorage: readStorageMock,
  evaluateGate: () => ({ allowed: true, availableBytes: null }),
}));

const { renderRegionsSheet } = await import('./regions-ui');

const LOCHABER: Region = {
  id: 'lochaber',
  name: 'Lochaber & Ben Nevis',
  bbox: [-5.6, 56.5, -4.6, 57.1],
  totalBytes: 184_000_000,
  artifacts: [{ kind: 'basemap', url: 'x', bytes: 184_000_000 }],
} as unknown as Region;

async function openSheet(
  map: Partial<MLMap> = {},
  onStatus: (message: string, kind: 'ok' | 'warn' | 'error') => void = vi.fn(),
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  await renderRegionsSheet({
    map: map as MLMap,
    registry: {} as never,
    theme: () => 'light',
    container,
    onStatus,
  });
  return container;
}

/** What regionStatuses reports for a region with every artifact on disk. */
const complete = (region: Region) => ({
  state: 'downloaded' as const,
  present: region.artifacts,
  missingBytes: 0,
});

const deleteButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('.region-action')!;

describe('deleting a downloaded region', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    findOrphansMock.mockResolvedValue([]);
    deleteOrphanMock.mockClear();
    fetchManifestMock.mockResolvedValue({ regions: [LOCHABER] });
    regionStatusesMock.mockResolvedValue(new Map([[LOCHABER.id, complete(LOCHABER)]]));
    deleteRegionMock.mockResolvedValue(undefined);
    removeRegionFromMapMock.mockReset();
    readStorageMock.mockResolvedValue({ persisted: true, availableBytes: 1e12 });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not delete on the first tap', async () => {
    // This button sits in the slot every other row uses for "Download", and the mistake
    // costs a re-download of the whole region.
    const container = await openSheet();
    deleteButton(container).click();

    expect(deleteRegionMock).not.toHaveBeenCalled();
  });

  it('names the size when it asks for confirmation', async () => {
    const container = await openSheet();
    deleteButton(container).click();

    expect(deleteButton(container).textContent).toMatch(/184(\.\d)? MB/);
    expect(deleteButton(container).classList.contains('armed')).toBe(true);
  });

  it('deletes on the second tap', async () => {
    const container = await openSheet();
    deleteButton(container).click();
    deleteButton(container).click();
    await vi.waitFor(() => expect(deleteRegionMock).toHaveBeenCalledWith(LOCHABER));

    expect(removeRegionFromMapMock).toHaveBeenCalled();
  });

  it('says so when the files could not all be removed, rather than "Deleted"', async () => {
    deleteRegionMock.mockRejectedValue(new DOMException('file is locked', 'NoModificationAllowedError'));
    const onStatus = vi.fn();
    const container = await openSheet({}, onStatus);
    deleteButton(container).click();
    deleteButton(container).click();

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith('Could not delete all of Lochaber & Ben Nevis: file is locked', 'error'),
    );
    expect(onStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^Deleted/), 'ok');
  });

  it('disarms itself rather than lying in wait for the next tap', async () => {
    const container = await openSheet();
    deleteButton(container).click();
    vi.advanceTimersByTime(5000);

    expect(deleteButton(container).textContent).toBe('Delete');
    expect(deleteButton(container).classList.contains('armed')).toBe(false);

    deleteButton(container).click();
    expect(deleteRegionMock).not.toHaveBeenCalled();
  });
});

describe('a catalogue that covers the globe', () => {
  // Four regions fitted in a list. Several hundred do not, and the failure mode is not
  // cosmetic: the row you came for is somewhere in a wall of names, and the download
  // buttons of the ones you scroll past are under your thumb the whole way.
  const region = (id: string, name: string, group: string, bbox: Region['bbox']): Region =>
    ({
      id,
      name,
      group,
      bbox,
      totalBytes: 10_000_000,
      artifacts: [{ kind: 'basemap', filename: `${id}-basemap.pmtiles`, bytes: 10_000_000 }],
    }) as unknown as Region;

  const CATALOGUE = [
    region('scotland', 'Scotland', 'Europe', [-8.7, 54.6, -0.7, 61]),
    region('georgia', 'Georgia', 'Asia', [40, 41, 46.7, 43.6]),
    region('us-georgia', 'Georgia', 'North America', [-85.6, 30.4, -80.8, 35]),
    region('polynesie', 'Polynésie française', 'Australia and Oceania', [-155, -28, -134, -7]),
    ...Array.from({ length: 30 }, (_, i) =>
      region(`filler-${i}`, `Filler ${i}`, 'Africa', [10 + i, 0, 11 + i, 1]),
    ),
  ];

  // A map stub with only what the sheet asks of it: where it is pointed.
  const centredOn = (lng: number, lat: number): Partial<MLMap> =>
    ({ getCenter: () => ({ lng, lat }) }) as unknown as Partial<MLMap>;

  /** The same stub, but pannable — and reporting whether the sheet is still listening. */
  const pannable = (lng: number, lat: number) => {
    let centre = { lng, lat };
    const listeners = new Set<() => void>();
    return {
      map: {
        getCenter: () => centre,
        on: (_event: string, fn: () => void) => listeners.add(fn),
        off: (_event: string, fn: () => void) => listeners.delete(fn),
      } as unknown as Partial<MLMap>,
      panTo(toLng: number, toLat: number): void {
        centre = { lng: toLng, lat: toLat };
        for (const fn of [...listeners]) fn();
      },
      get listenerCount(): number {
        return listeners.size;
      },
    };
  };

  const names = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.region-name')].map((el) => el.textContent!);

  const type = (container: HTMLElement, query: string): void => {
    const search = container.querySelector<HTMLInputElement>('.regions-search')!;
    search.value = query;
    search.dispatchEvent(new Event('input'));
  };

  beforeEach(() => {
    findOrphansMock.mockResolvedValue([]);
    fetchManifestMock.mockResolvedValue({ regions: CATALOGUE });
    regionStatusesMock.mockResolvedValue(new Map());
    readStorageMock.mockResolvedValue({ persisted: true, availableBytes: 1e12 });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('does not render the whole catalogue up front', async () => {
    const container = await openSheet();

    expect(names(container).length).toBeLessThan(CATALOGUE.length);
    // And says nothing about it: at rest the rows are the answer, and a standing line of
    // prose above six of them is a caption on a picture that needs none.
    expect(container.querySelector('.regions-hint')!.textContent).toBe('');
  });

  it('says nothing at rest, whatever the catalogue is sized', async () => {
    // A catalogue smaller than the nearby cap is the normal state of a young catalogue,
    // and of a filtered test fixture. It used to be the case that produced "search to
    // reach any of the other 0" — there is no hint to get wrong now, and there must not
    // be one.
    fetchManifestMock.mockResolvedValue({ regions: CATALOGUE.slice(0, 2) });
    const container = await openSheet(centredOn(-4.5, 56.8));

    expect(names(container)).toHaveLength(2);
    expect(container.querySelector('.regions-hint')!.textContent).toBe('');
  });

  it('offers the regions covering where the map is pointed', async () => {
    const container = await openSheet(centredOn(-4.5, 56.8));

    expect(names(container)[0]).toBe('Scotland');
  });

  it('keeps a downloaded region to hand however far away it is', async () => {
    // Its button deletes; making someone search for that is worse than a long list.
    regionStatusesMock.mockResolvedValue(
      new Map([['polynesie', { state: 'downloaded', present: [{}], missingBytes: 0 }]]),
    );
    const container = await openSheet(centredOn(-4.5, 56.8));

    expect(names(container)[0]).toBe('Polynésie française');
  });

  it('follows the map, because the nearby list is about where you are looking', async () => {
    const gps = pannable(-4.5, 56.8);
    const container = await openSheet(gps.map);
    expect(names(container)[0]).toBe('Scotland');

    gps.panTo(43, 42);

    expect(names(container)[0]).toBe('Georgia');
  });

  it('leaves a search alone while the map moves', async () => {
    const gps = pannable(-4.5, 56.8);
    const container = await openSheet(gps.map);
    type(container, 'polynesie');

    gps.panTo(43, 42);

    expect(names(container)).toEqual(['Polynésie française']);
  });

  it('keeps a running download in the list, Cancel and all, as the map moves', async () => {
    // The list used to stop following the map for the whole of a download instead:
    // redrawing it threw away the row's Cancel and progress bar and left a button that
    // started the download a second time.
    const { downloadRegion, DownloadCancelled } = await import('./downloader');
    vi.mocked(downloadRegion).mockImplementation(
      (_region, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new DownloadCancelled())),
        ),
    );
    const onStatus = vi.fn();
    const gps = pannable(-4.5, 56.8);
    const container = await openSheet(gps.map, onStatus);
    const action = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('.region-row .region-action')!;
    action().click();
    await vi.waitFor(() => expect(action().textContent).toBe('Cancel'));

    gps.panTo(43, 42);

    // Georgia is what the map is over now, but Scotland stays: its row holds the Cancel.
    expect(names(container).slice(0, 2)).toEqual(['Scotland', 'Georgia']);
    expect(action().textContent).toBe('Cancel');

    action().click();
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/^Paused Scotland/), 'warn'),
    );
    expect(downloadRegion).toHaveBeenCalledTimes(1);
    vi.mocked(downloadRegion).mockReset();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('stops listening once the sheet is gone', async () => {
    const gps = pannable(-4.5, 56.8);
    const container = await openSheet(gps.map);
    container.innerHTML = '';

    gps.panTo(43, 42);

    expect(gps.listenerCount).toBe(0);
  });

  it('finds a region by name', async () => {
    const container = await openSheet();
    type(container, 'scot');

    expect(names(container)).toEqual(['Scotland']);
  });

  it('ignores accents, which nobody types', async () => {
    const container = await openSheet();
    type(container, 'polynesie');

    expect(names(container)).toEqual(['Polynésie française']);
  });

  it('separates two regions that share a name by where they are', async () => {
    const container = await openSheet();
    type(container, 'georgia');

    expect(names(container)).toEqual(['Georgia', 'Georgia']);
    const meta = [...container.querySelectorAll('.region-meta')].map((el) => el.textContent!);
    expect(meta.some((text) => text.startsWith('Asia'))).toBe(true);
    expect(meta.some((text) => text.startsWith('North America'))).toBe(true);
  });

  it('keeps the query when a download or delete re-renders the sheet', async () => {
    const container = await openSheet();
    type(container, 'scot');

    await renderRegionsSheet({
      map: {} as MLMap,
      registry: {} as never,
      theme: () => 'light',
      container,
      onStatus: vi.fn(),
    });

    expect(container.querySelector<HTMLInputElement>('.regions-search')!.value).toBe('scot');
    expect(names(container)).toEqual(['Scotland']);
  });

  it('says so rather than showing an empty list when nothing matches', async () => {
    const container = await openSheet();
    type(container, 'atlantis');

    expect(names(container)).toEqual([]);
    expect(container.querySelector('.regions-hint')!.textContent).toMatch(/no region/i);
  });
});

describe('withdrawn regions', () => {
  const ORPHAN = { id: 'lochaber', files: ['lochaber-basemap.pmtiles'], bytes: 53_550_554 };

  beforeEach(() => {
    vi.useFakeTimers();
    fetchManifestMock.mockResolvedValue({ regions: [LOCHABER] });
    regionStatusesMock.mockResolvedValue(new Map());
    readStorageMock.mockResolvedValue({ persisted: true, availableBytes: 1e12 });
    deleteOrphanMock.mockClear();
    findOrphansMock.mockResolvedValue([ORPHAN]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const open = async (): Promise<HTMLElement> => {
    const container = document.createElement('div');
    await renderRegionsSheet({
      map: {} as MLMap,
      registry: {} as never,
      theme: () => 'light',
      container,
      onStatus: vi.fn(),
    });
    return container;
  };

  it('offers a region the catalogue no longer lists, with its size', async () => {
    const container = await open();
    const section = container.querySelector<HTMLElement>('.regions-orphans')!;

    expect(section.hidden).toBe(false);
    expect(section.querySelector('.region-name')!.textContent).toBe('lochaber');
    expect(section.querySelector('.region-meta')!.textContent).toMatch(/53\.6 MB · withdrawn/);
  });

  it('stays hidden when nothing is orphaned', async () => {
    findOrphansMock.mockResolvedValue([]);
    const container = await open();

    expect(container.querySelector<HTMLElement>('.regions-orphans')!.hidden).toBe(true);
  });

  it('needs two taps to delete, like every other delete', async () => {
    const container = await open();
    const button = container.querySelector<HTMLButtonElement>('.regions-orphans .region-action')!;

    button.click();
    expect(deleteOrphanMock).not.toHaveBeenCalled();
    expect(button.textContent).toMatch(/\?$/);

    button.click();
    await vi.waitFor(() => expect(deleteOrphanMock).toHaveBeenCalledWith(ORPHAN));
  });

  it('disarms on its own, so a later tap is not a delete', async () => {
    const container = await open();
    const button = container.querySelector<HTMLButtonElement>('.regions-orphans .region-action')!;

    button.click();
    vi.advanceTimersByTime(6000);
    button.click();

    expect(deleteOrphanMock).not.toHaveBeenCalled();
  });
});

describe('a region whose catalogue entry has gained an artifact', () => {
  // The case: someone downloaded a region, and the catalogue later published SAC grades
  // for it. Their basemap and terrain are untouched on disk — one small new file is
  // missing. That must not read as a broken or interrupted download, and above all it
  // must not stop the region they already have from drawing.
  const GRADED: Region = {
    id: 'lochaber',
    name: 'Lochaber & Ben Nevis',
    bbox: [-5.6, 56.5, -4.6, 57.1],
    totalBytes: 185_800_000,
    artifacts: [
      { kind: 'basemap', filename: 'lochaber-basemap.pmtiles', path: 'a', bytes: 184_000_000 },
      { kind: 'sac', filename: 'lochaber-sac.pmtiles', path: 'b', bytes: 1_800_000 },
    ],
  } as unknown as Region;

  const onDisk = {
    state: 'update' as const,
    present: [GRADED.artifacts[0]],
    missingBytes: 1_800_000,
  };

  beforeEach(() => {
    findOrphansMock.mockResolvedValue([]);
    fetchManifestMock.mockResolvedValue({ regions: [GRADED] });
    regionStatusesMock.mockResolvedValue(new Map([[GRADED.id, onDisk]]));
    readStorageMock.mockResolvedValue({ persisted: true, availableBytes: 1e12 });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('still draws the part they already have', async () => {
    const { restoreDownloadedRegions } = await import('./regions-ui');
    const { addRegionToMap } = await import('./region-layers');
    vi.mocked(addRegionToMap).mockClear();

    await restoreDownloadedRegions({} as MLMap, {} as never, [GRADED], 'light');

    // The regression this guards: restore used to take only regions whose every artifact
    // was present, so the day the catalogue published a new artifact kind, every already
    // downloaded region silently stopped rendering — offline, with no way to tell why.
    expect(addRegionToMap).toHaveBeenCalledTimes(1);
  });

  it('hands on only the artifacts that are actually on disk', async () => {
    const { restoreDownloadedRegions } = await import('./regions-ui');
    const { addRegionToMap } = await import('./region-layers');
    vi.mocked(addRegionToMap).mockClear();

    const restored = await restoreDownloadedRegions({} as MLMap, {} as never, [GRADED], 'light');

    // Downstream — the zoom-limit notice, the router, the samplers — reads artifacts off
    // these objects and looks each one up in the registry. Passing on a manifest entry
    // with no file behind it is how the app ends up claiming detail it does not have.
    expect(restored[0].artifacts.map((a) => a.kind)).toEqual(['basemap']);
    expect(restored[0].totalBytes).toBe(184_000_000);
    const passed = vi.mocked(addRegionToMap).mock.calls[0][2];
    expect(passed.artifacts.map((a) => a.kind)).toEqual(['basemap']);
  });

  it('offers an update, not a resume, and names what it will actually fetch', async () => {
    const container = await openSheet();
    const action = container.querySelector<HTMLButtonElement>('.region-action')!;

    // "Resume" would say their download broke; the region total would say 186 MB. Both
    // discourage a tap that costs 1.8 MB.
    expect(action.textContent).toBe('Update');
    expect(container.textContent).toContain('1.8 MB');
  });
});

describe('download progress', () => {
  beforeEach(() => {
    findOrphansMock.mockResolvedValue([]);
    fetchManifestMock.mockResolvedValue({ regions: [LOCHABER] });
    regionStatusesMock.mockResolvedValue(
      new Map([[LOCHABER.id, { state: 'absent', present: [], missingBytes: LOCHABER.totalBytes }]]),
    );
    readStorageMock.mockResolvedValue({ persisted: true, availableBytes: 1e12 });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  async function tapDownload() {
    const onStatus = vi.fn();
    const container = await openSheet({}, onStatus);
    container.querySelector<HTMLButtonElement>('.region-action')!.click();
    return onStatus;
  }

  it('says so when storage cannot be checked, rather than doing nothing (C1 still holds)', async () => {
    const { downloadRegion } = await import('./downloader');
    readStorageMock.mockRejectedValue(new Error('estimate() unavailable'));

    const onStatus = await tapDownload();

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/Couldn’t check storage.*Nothing was downloaded/), 'error'),
    );
    expect(downloadRegion).not.toHaveBeenCalled();
  });

  it('does not call a finished download "failed" when only drawing it went wrong', async () => {
    const { downloadRegion } = await import('./downloader');
    const { addRegionToMap } = await import('./region-layers');
    vi.mocked(downloadRegion).mockResolvedValue(undefined);
    vi.mocked(addRegionToMap).mockRejectedValue(new Error('Style is not done loading'));

    const onStatus = await tapDownload();

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/downloaded, but couldn’t be drawn/), 'error'),
    );
    expect(onStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^Download failed/), 'error');
  });

  it('will not download a region the app itself could not open offline', async () => {
    const { downloadRegion } = await import('./downloader');
    const onStatus = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    await renderRegionsSheet({
      map: {} as MLMap,
      registry: {} as never,
      theme: () => 'light',
      container,
      onStatus,
      offlineState: () => 'failed',
    });

    container.querySelector<HTMLButtonElement>('.region-action')!.click();

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/isn’t set up to open without signal/), 'warn'),
    );
    expect(downloadRegion).not.toHaveBeenCalled();
  });

  it('explains a full phone in plain words', async () => {
    const { downloadRegion } = await import('./downloader');
    vi.mocked(downloadRegion).mockRejectedValue(new DOMException('quota exceeded', 'QuotaExceededError'));

    const onStatus = await tapDownload();

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/ran out of storage.*tap Resume/), 'error'),
    );
  });

  it('is a progressbar to assistive tech, with the same words the label shows', async () => {
    const { downloadRegion } = await import('./downloader');
    let reported!: () => void;
    const reachedHalfway = new Promise<void>((resolve) => (reported = resolve));
    vi.mocked(downloadRegion).mockImplementation(async (_region, options) => {
      options.onProgress?.({
        regionId: LOCHABER.id,
        receivedBytes: 92_000_000,
        totalBytes: 184_000_000,
        currentArtifact: 'basemap',
        done: false,
        bytesPerSecond: null,
        etaSeconds: null,
      });
      reported();
      // Stay "running", so the row is inspected mid-download rather than after a refresh.
      await new Promise(() => {});
    });

    const container = await openSheet();
    container.querySelector<HTMLButtonElement>('.region-action')!.click();
    await reachedHalfway;

    const bar = container.querySelector('.region-progress')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Downloading Lochaber & Ben Nevis');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuetext')).toBe(
      container.querySelector('.region-progress-label')!.textContent,
    );
  });
});

describe('a download outliving the sheet that started it', () => {
  // The sheet is redrawn on every search keystroke, every reopening and every pan. A
  // download held only by the row that started it outlived that row: the new one read
  // Resume, with no progress and no Cancel, while the download ran on unseen.
  //
  // Its own region: the progressbar test above leaves Lochaber downloading for good.
  const ARRAN: Region = {
    id: 'arran',
    name: 'Arran',
    bbox: [-5.4, 55.4, -5.0, 55.8],
    totalBytes: 60_000_000,
    artifacts: [{ kind: 'basemap', filename: 'arran-basemap.pmtiles', bytes: 60_000_000 }],
  } as unknown as Region;

  const action = (container: HTMLElement): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('.region-action')!;

  beforeEach(() => {
    findOrphansMock.mockResolvedValue([]);
    fetchManifestMock.mockResolvedValue({ regions: [ARRAN] });
    regionStatusesMock.mockResolvedValue(new Map());
    readStorageMock.mockResolvedValue({ persisted: true, availableBytes: 1e12 });
  });

  afterEach(async () => {
    const { downloadRegion } = await import('./downloader');
    vi.mocked(downloadRegion).mockReset();
    // Let the redraw a finished download starts run out before the next test's sheet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  /** Start Arran downloading: halfway there, and running until it is cancelled. */
  async function startArran(onStatus = vi.fn()) {
    const { downloadRegion, DownloadCancelled } = await import('./downloader');
    vi.mocked(downloadRegion).mockImplementation(
      (_region, options) =>
        new Promise((_resolve, reject) => {
          options.onProgress?.({
            regionId: ARRAN.id,
            receivedBytes: 30_000_000,
            totalBytes: 60_000_000,
            currentArtifact: 'basemap',
            done: false,
            bytesPerSecond: null,
            etaSeconds: null,
          });
          options.signal.addEventListener('abort', () => reject(new DownloadCancelled()));
        }),
    );
    const container = await openSheet({}, onStatus);
    action(container).click();
    await vi.waitFor(() => expect(action(container).textContent).toBe('Cancel'));
    return { container, onStatus, downloadRegion };
  }

  it('is shown as it stands, Cancel and all, when the sheet is opened again', async () => {
    const { onStatus, downloadRegion } = await startArran();

    // Closing the sheet and opening it again draws every row afresh.
    const reopened = await openSheet({}, onStatus);

    expect(action(reopened).textContent).toBe('Cancel');
    expect(reopened.querySelector<HTMLElement>('.region-progress')!.hidden).toBe(false);
    expect(reopened.querySelector('.region-progress-label')!.textContent).toBe('30.0 MB of 60.0 MB');

    action(reopened).click();
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/^Paused Arran/), 'warn'),
    );
    // Cancelled — not started a second time from a stale Resume.
    expect(downloadRegion).toHaveBeenCalledTimes(1);
  });

  it('keeps its Cancel through a search of the list', async () => {
    const { container, onStatus } = await startArran();
    const search = container.querySelector<HTMLInputElement>('.regions-search')!;
    search.value = 'arr';
    search.dispatchEvent(new Event('input'));

    expect(action(container).textContent).toBe('Cancel');

    action(container).click();
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/^Paused Arran/), 'warn'),
    );
  });

  it('starts once, however fast the button is tapped', async () => {
    const { downloadRegion, DownloadCancelled } = await import('./downloader');
    vi.mocked(downloadRegion).mockImplementation(
      (_region, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new DownloadCancelled())),
        ),
    );
    let storageChecked!: (snapshot: unknown) => void;
    readStorageMock.mockReturnValue(new Promise((resolve) => (storageChecked = resolve)));
    const container = await openSheet();

    // Both taps land while the storage check is still out.
    action(container).click();
    action(container).click();
    storageChecked({ persisted: true, availableBytes: 1e12 });

    await vi.waitFor(() => expect(downloadRegion).toHaveBeenCalled());
    expect(downloadRegion).toHaveBeenCalledTimes(1);
    // Leave nothing running for the tests after this one.
    action(container).click();
  });

  it('shows up in the row drawn while its storage check was still out', async () => {
    // A keystroke or a pan between the tap and the start redraws the list. The download
    // must report to the row now on screen, or that row reads Download — and a tap on it
    // cancels.
    const { downloadRegion, DownloadCancelled } = await import('./downloader');
    vi.mocked(downloadRegion).mockImplementation(
      (_region, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new DownloadCancelled())),
        ),
    );
    let storageChecked!: (snapshot: unknown) => void;
    readStorageMock.mockReturnValue(new Promise((resolve) => (storageChecked = resolve)));
    const onStatus = vi.fn();
    const container = await openSheet({}, onStatus);

    action(container).click();
    const search = container.querySelector<HTMLInputElement>('.regions-search')!;
    search.value = 'arr';
    search.dispatchEvent(new Event('input'));
    storageChecked({ persisted: true, availableBytes: 1e12 });

    await vi.waitFor(() => expect(action(container).textContent).toBe('Cancel'));
    action(container).click();
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/^Paused Arran/), 'warn'),
    );
  });

  it('does not draw the list over another view when it finishes', async () => {
    const { downloadRegion } = await import('./downloader');
    let finish!: () => void;
    vi.mocked(downloadRegion).mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const onRegionsChanged = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    await renderRegionsSheet({
      map: {} as MLMap,
      registry: {} as never,
      theme: () => 'light',
      container,
      onStatus: vi.fn(),
      onRegionsChanged,
    });
    action(container).click();
    await vi.waitFor(() => expect(action(container).textContent).toBe('Cancel'));

    // Someone opens a summit card while it runs: the same sheet body, another view.
    container.innerHTML = '<h2>Ben Nevis</h2>';
    fetchManifestMock.mockClear();
    finish();

    await vi.waitFor(() => expect(onRegionsChanged).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('<h2>Ben Nevis</h2>');
    expect(fetchManifestMock).not.toHaveBeenCalled();
  });
});

describe('when the catalogue cannot be fetched', () => {
  beforeEach(() => {
    findOrphansMock.mockResolvedValue([]);
    regionStatusesMock.mockResolvedValue(new Map([[LOCHABER.id, complete(LOCHABER)]]));
    loadCachedManifestMock.mockReturnValue(null);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const notice = (container: HTMLElement) => container.querySelector<HTMLElement>('.regions-notice')!;
  const rowNames = (container: HTMLElement) =>
    [...container.querySelectorAll('.region-row .region-name')].map((el) => el.textContent);

  it('says so, rather than showing an empty sheet', async () => {
    // It used to hide the search box and return — a blank sheet, nothing said.
    fetchManifestMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const container = await openSheet();

    expect(notice(container).hidden).toBe(false);
    expect(notice(container).textContent).toMatch(/Can’t reach the region catalogue \(Failed to fetch\)/);
    expect(notice(container).textContent).toMatch(/Check your connection/);
  });

  it('works from the copy saved on the phone, so downloaded regions can still be managed', async () => {
    fetchManifestMock.mockRejectedValue(new TypeError('Failed to fetch'));
    loadCachedManifestMock.mockReturnValue({ schemaVersion: 1, builtAt: 'x', regions: [LOCHABER] });

    const container = await openSheet();

    expect(rowNames(container)).toEqual([LOCHABER.name]);
    expect(container.querySelector<HTMLElement>('.region-action')!.textContent).toBe('Delete');
    expect(notice(container).textContent).toMatch(/copy saved on this phone/);
  });

  it('asks for an app update when the catalogue is newer than this build', async () => {
    const { CatalogueTooNew } = await import('./manifest');
    fetchManifestMock.mockRejectedValue(new CatalogueTooNew(2));

    const container = await openSheet();

    expect(notice(container).textContent).toMatch(/Update the app/);
  });

  it('still lists the regions from the last catalogue it understood, when updating', async () => {
    const { CatalogueTooNew } = await import('./manifest');
    fetchManifestMock.mockRejectedValue(new CatalogueTooNew(2));
    loadCachedManifestMock.mockReturnValue({ schemaVersion: 1, builtAt: 'x', regions: [LOCHABER] });

    const container = await openSheet();

    expect(rowNames(container)).toEqual([LOCHABER.name]);
    expect(notice(container).textContent).toMatch(/Update the app to see new regions/);
  });

  it('shows no notice when the catalogue arrives', async () => {
    fetchManifestMock.mockResolvedValue({ regions: [LOCHABER] });

    const container = await openSheet();

    expect(notice(container).hidden).toBe(true);
  });
});

describe('restoring downloaded regions at startup', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('draws the others when one region fails, and says which one', async () => {
    const { addRegionToMap } = await import('./region-layers');
    const SECOND = { ...LOCHABER, id: 'second', name: 'Second' } as Region;
    regionStatusesMock.mockResolvedValue(
      new Map([
        [LOCHABER.id, complete(LOCHABER)],
        [SECOND.id, complete(SECOND)],
      ]),
    );
    vi.mocked(addRegionToMap).mockImplementation(async (_map, _registry, region) => {
      if (region.id === LOCHABER.id) throw new Error('Layer with id already exists');
    });
    const onFailure = vi.fn();

    const { restoreDownloadedRegions } = await import('./regions-ui');
    const restored = await restoreDownloadedRegions({} as MLMap, {} as never, [LOCHABER, SECOND], 'light', onFailure);

    expect(restored.map((r) => r.id)).toEqual(['second']);
    expect(onFailure).toHaveBeenCalledWith(LOCHABER, expect.objectContaining({ message: 'Layer with id already exists' }));
  });
});
