import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';

const fetchManifestMock = vi.hoisted(() => vi.fn());
const regionStatusesMock = vi.hoisted(() => vi.fn());
const deleteRegionMock = vi.hoisted(() => vi.fn());
const removeRegionFromMapMock = vi.hoisted(() => vi.fn());
const readStorageMock = vi.hoisted(() => vi.fn());

vi.mock('./manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manifest')>()),
  fetchManifest: fetchManifestMock,
}));

vi.mock('./downloader', () => ({
  regionStatuses: regionStatusesMock,
  deleteRegion: deleteRegionMock,
  downloadRegion: vi.fn(),
  DownloadCancelled: class DownloadCancelled extends Error {},
}));

vi.mock('./region-layers', () => ({
  addRegionToMap: vi.fn(),
  removeRegionFromMap: removeRegionFromMapMock,
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

  const names = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.region-name')].map((el) => el.textContent!);

  const type = (container: HTMLElement, query: string): void => {
    const search = container.querySelector<HTMLInputElement>('.regions-search')!;
    search.value = query;
    search.dispatchEvent(new Event('input'));
  };

  beforeEach(() => {
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
    expect(container.querySelector('.regions-hint')!.textContent).toMatch(/search/i);
  });

  it('does not tell you to search for the other zero regions', async () => {
    // The normal state of a young catalogue, and of a filtered test fixture.
    fetchManifestMock.mockResolvedValue({ regions: CATALOGUE.slice(0, 2) });
    const container = await openSheet(centredOn(-4.5, 56.8));

    expect(names(container)).toHaveLength(2);
    expect(container.querySelector('.regions-hint')!.textContent).toMatch(/every published/i);
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
