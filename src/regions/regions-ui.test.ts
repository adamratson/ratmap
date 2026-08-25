import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { Region } from './manifest';

const fetchManifestMock = vi.hoisted(() => vi.fn());
const regionStatusMock = vi.hoisted(() => vi.fn());
const deleteRegionMock = vi.hoisted(() => vi.fn());
const removeRegionFromMapMock = vi.hoisted(() => vi.fn());
const readStorageMock = vi.hoisted(() => vi.fn());

vi.mock('./manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manifest')>()),
  fetchManifest: fetchManifestMock,
}));

vi.mock('./downloader', () => ({
  regionStatus: regionStatusMock,
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

async function openSheet(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  await renderRegionsSheet({
    map: {} as MLMap,
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
    regionStatusMock.mockResolvedValue('downloaded');
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
