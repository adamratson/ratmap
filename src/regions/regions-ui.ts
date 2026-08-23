import type { Map as MLMap } from 'maplibre-gl';
import { fetchManifest, formatBytes, type Region } from './manifest';
import { deleteRegion, downloadRegion, regionStatus, DownloadCancelled } from './downloader';
import { addRegionToMap, removeRegionFromMap } from './region-layers';
import { evaluateGate, readStorage } from './storage-budget';
import type { TileSourceRegistry } from '../tile-source-registry';

export interface RegionsUiDeps {
  map: MLMap;
  registry: TileSourceRegistry;
  container: HTMLElement;
  onStatus(message: string, kind: 'ok' | 'warn' | 'error'): void;
}

/**
 * Loads every already-downloaded region into the map. Called at startup so a cold offline
 * launch renders from OPFS with no network and no user action — the core of the Phase 3
 * acceptance test.
 */
export async function restoreDownloadedRegions(
  map: MLMap,
  registry: TileSourceRegistry,
  regions: Region[],
): Promise<Region[]> {
  const restored: Region[] = [];
  for (const region of regions) {
    if ((await regionStatus(region)) !== 'downloaded') continue;
    await addRegionToMap(map, registry, region);
    restored.push(region);
  }
  return restored;
}

export async function renderRegionsSheet(deps: RegionsUiDeps): Promise<void> {
  const { container, map, registry, onStatus } = deps;

  container.innerHTML = `
    <button class="sheet-close" type="button" aria-label="Close">×</button>
    <h2>Offline regions</h2>
    <p class="regions-intro"></p>
    <ul class="regions-list"></ul>
  `;
  container.querySelector('.sheet-close')!.addEventListener('click', () => {
    container.hidden = true;
  });
  container.hidden = false;

  const intro = container.querySelector<HTMLParagraphElement>('.regions-intro')!;
  const list = container.querySelector<HTMLUListElement>('.regions-list')!;

  const storage = await readStorage();
  intro.textContent = storage.persisted
    ? 'Downloads are kept on this device and work with no signal.'
    : 'Storage is not persistent yet — install to your home screen before downloading.';

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    // Offline with nothing cached is the common case here — say so plainly rather than
    // showing an empty list that looks like "no regions exist".
    intro.textContent = `Region catalogue unavailable: ${(err as Error).message}`;
    return;
  }

  for (const region of manifest.regions) {
    list.append(await renderRegionRow(region, deps, () => void renderRegionsSheet(deps)));
  }

  if (manifest.regions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'places-empty';
    empty.textContent = 'No regions published yet.';
    list.append(empty);
  }

  void map;
  void registry;
  void onStatus;
}

async function renderRegionRow(
  region: Region,
  deps: RegionsUiDeps,
  refresh: () => void,
): Promise<HTMLLIElement> {
  const item = document.createElement('li');
  item.className = 'region-row';

  const info = document.createElement('div');
  info.className = 'region-info';

  const name = document.createElement('span');
  name.className = 'region-name';
  name.textContent = region.name;

  const meta = document.createElement('span');
  meta.className = 'region-meta';
  const status = await regionStatus(region);
  const kinds = region.artifacts.map((a) => a.kind).join(' + ');
  meta.textContent = `${formatBytes(region.totalBytes)} · ${kinds}`;

  info.append(name, meta);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'region-action';

  const progress = document.createElement('div');
  progress.className = 'region-progress';
  progress.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'region-progress-bar';
  progress.append(bar);

  if (status === 'downloaded') {
    action.textContent = 'Delete';
    action.classList.add('danger');
    action.addEventListener('click', () => {
      void (async () => {
        removeRegionFromMap(deps.map, region);
        await deleteRegion(region);
        deps.onStatus(`Deleted ${region.name}`, 'ok');
        refresh();
      })();
    });
  } else {
    action.textContent = status === 'partial' ? 'Resume' : 'Download';
    action.addEventListener('click', () => {
      void startDownload(region, deps, action, progress, bar, refresh);
    });
  }

  item.append(info, action, progress);
  return item;
}

async function startDownload(
  region: Region,
  deps: RegionsUiDeps,
  action: HTMLButtonElement,
  progress: HTMLElement,
  bar: HTMLElement,
  refresh: () => void,
): Promise<void> {
  // C1: both gates checked immediately before starting, not at page load — persistence
  // and free space can both change while the app is open.
  const gate = evaluateGate(region, await readStorage());
  if (!gate.allowed) {
    deps.onStatus(gate.message, 'warn');
    return;
  }

  const controller = new AbortController();
  action.textContent = 'Cancel';
  action.classList.add('danger');
  progress.hidden = false;

  const onCancel = () => controller.abort();
  action.addEventListener('click', onCancel);

  try {
    await downloadRegion(region, {
      signal: controller.signal,
      onProgress: (p) => {
        const pct = p.totalBytes > 0 ? Math.min((p.receivedBytes / p.totalBytes) * 100, 100) : 0;
        bar.style.width = `${pct.toFixed(1)}%`;
        action.title = `${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)}`;
      },
    });

    await addRegionToMap(deps.map, deps.registry, region);
    deps.onStatus(`${region.name} is available offline.`, 'ok');
  } catch (err) {
    if (err instanceof DownloadCancelled || (err as Error).name === 'AbortError') {
      // Partial data is kept deliberately, so Resume picks up where this left off.
      deps.onStatus(`Paused ${region.name} — progress is kept, tap Resume to continue.`, 'warn');
    } else {
      deps.onStatus(`Download failed: ${(err as Error).message}`, 'error');
    }
  } finally {
    action.removeEventListener('click', onCancel);
    refresh();
  }
}
