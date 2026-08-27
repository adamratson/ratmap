import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';

const fetchManifestMock = vi.hoisted(() => vi.fn());
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
}));

vi.mock('./downloader', () => ({
  regionStatuses: regionStatusesMock,
  deleteRegion: deleteRegionMock,
  downloadRegion: vi.fn(),
  downloadsInFlight: downloadsInFlightMock,
  DownloadCancelled: class DownloadCancelled extends Error {},
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

async function openSheet(map: Partial<MLMap> = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  await renderRegionsSheet({
    map: map as MLMap,
    registry: {} as never,
    container,
    onStatus: vi.fn(),
  });
  return container;
}

const deleteButton = (container: HTMLElement): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('.region-action')!;

describe('deleting a downloaded region', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    findOrphansMock.mockResolvedValue([]);
    deleteOrphanMock.mockClear();
    fetchManifestMock.mockResolvedValue({ regions: [LOCHABER] });
    regionStatusesMock.mockResolvedValue(new Map([[LOCHABER.id, 'downloaded']]));
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
    regionStatusesMock.mockResolvedValue(new Map([['polynesie', 'downloaded']]));
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

  it('does not redraw over a running download', async () => {
    // The redraw would replace the Cancel button and progress bar of a row that is still
    // working with a Download button that starts the whole thing again.
    downloadsInFlightMock.mockReturnValue(1);
    const gps = pannable(-4.5, 56.8);
    const container = await openSheet(gps.map);

    gps.panTo(43, 42);

    expect(names(container)[0]).toBe('Scotland');
    downloadsInFlightMock.mockReturnValue(0);
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
