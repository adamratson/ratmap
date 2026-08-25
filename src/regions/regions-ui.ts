import type { Map as MLMap } from 'maplibre-gl';
import { fetchManifest, formatBytes, type Region } from './manifest';
import {
  deleteRegion,
  downloadRegion,
  regionStatuses,
  DownloadCancelled,
  type RegionState,
} from './downloader';
import { addRegionToMap, removeRegionFromMap } from './region-layers';
import { evaluateGate, readStorage } from './storage-budget';
import type { TileSourceRegistry } from '../tile-source-registry';

/** How long a delete stays armed before reverting to its safe label. */
const ARM_TIMEOUT_MS = 5000;

/**
 * How many nearby regions to offer before the user has typed anything.
 *
 * The catalogue covers the whole globe, so listing it is not a list — it is a wall. What
 * someone opening this sheet almost always wants is the ground they are looking at, which
 * is what the map is already centred on.
 */
const NEARBY_COUNT = 6;

/** Cap on search results: a one-letter query matches half the planet. */
const MAX_RESULTS = 40;

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
  // One directory listing for the whole catalogue, not two OPFS lookups per artifact:
  // this runs before the map can show a downloaded region, on a phone, at startup.
  const statuses = await regionStatuses(regions);

  const restored: Region[] = [];
  for (const region of regions) {
    if (statuses.get(region.id) !== 'downloaded') continue;
    await addRegionToMap(map, registry, region);
    restored.push(region);
  }
  return restored;
}

export async function renderRegionsSheet(deps: RegionsUiDeps): Promise<void> {
  const { container, map, registry, onStatus } = deps;

  // No close button: the sheet's own chip toggles this view, and dragging the sheet down
  // works from anywhere. A per-panel × was the only way out when each panel owned its own
  // corner of the screen.
  // A download or a delete re-renders this whole sheet. Losing what someone had typed at
  // that moment would throw them back to the nearby list with their region no longer in
  // it — the one search they had already done, undone by finishing.
  const previousQuery = container.querySelector<HTMLInputElement>('.regions-search')?.value ?? '';

  container.innerHTML = `
    <h2>Offline regions</h2>
    <p class="regions-intro"></p>
    <input class="regions-search" type="search" enterkeyhint="search" autocomplete="off"
           placeholder="Search regions" aria-label="Search regions" />
    <p class="regions-hint" aria-live="polite"></p>
    <ul class="regions-list"></ul>
  `;

  const intro = container.querySelector<HTMLParagraphElement>('.regions-intro')!;
  const hint = container.querySelector<HTMLParagraphElement>('.regions-hint')!;
  const search = container.querySelector<HTMLInputElement>('.regions-search')!;
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
    search.hidden = true;
    return;
  }

  if (manifest.regions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'places-empty';
    empty.textContent = 'No regions published yet.';
    list.append(empty);
    search.hidden = true;
    return;
  }

  const statuses = await regionStatuses(manifest.regions);
  const refresh = (): void => void renderRegionsSheet(deps);

  const draw = (query: string): void => {
    const matches = query.trim() ? searchRegions(manifest.regions, query) : null;
    const shown = matches ?? nearbySelection(manifest.regions, statuses, centreOf(map));

    hint.textContent = describe(shown.length, matches?.total ?? null, manifest.regions.length);
    list.replaceChildren(
      ...shown.map((region) =>
        renderRegionRow(region, statuses.get(region.id) ?? 'absent', deps, refresh),
      ),
    );
  };

  // No debounce: filtering a few hundred strings is not work, and a delay on a search
  // that already has an answer is felt as lag.
  search.addEventListener('input', () => draw(search.value));
  search.value = previousQuery;
  draw(previousQuery);

  void registry;
  void onStatus;
}

/**
 * What to show before anything is typed: everything already on the device, then the
 * regions covering where the map is pointed.
 *
 * A downloaded region belongs at the top wherever it is in the world — it is the one row
 * whose button does something destructive, and hunting for it through a search box to
 * free up space would be absurd.
 */
function nearbySelection(
  regions: Region[],
  statuses: Map<string, RegionState>,
  centre: [number, number] | null,
): Region[] {
  const held = regions.filter((region) => (statuses.get(region.id) ?? 'absent') !== 'absent');
  const heldIds = new Set(held.map((region) => region.id));
  const rest = regions.filter((region) => !heldIds.has(region.id));

  if (centre === null) return [...held, ...rest.slice(0, NEARBY_COUNT)];

  const near = rest
    .map((region) => ({ region, distance: distanceTo(region.bbox, centre) }))
    // Ties happen constantly — nested regions all contain the centre and score 0 — so
    // break them on size: the smaller region is the cheaper download and the more
    // specific answer to "what covers this valley".
    .sort((a, b) => a.distance - b.distance || bboxArea(a.region.bbox) - bboxArea(b.region.bbox))
    .slice(0, NEARBY_COUNT)
    .map((scored) => scored.region);

  return [...held, ...near];
}

interface SearchResult extends Array<Region> {
  total: number;
}

/**
 * Name and group matches, prefix matches first.
 *
 * Group is searchable because the catalogue has genuine name collisions once it covers
 * the globe — Georgia the country and Georgia the state — and the continent is what
 * tells them apart.
 */
function searchRegions(regions: Region[], query: string): SearchResult {
  const needle = fold(query);
  const scored: { region: Region; rank: number }[] = [];

  for (const region of regions) {
    const name = fold(region.name);
    const group = fold(region.group ?? '');
    if (name.startsWith(needle)) scored.push({ region, rank: 0 });
    else if (name.includes(needle)) scored.push({ region, rank: 1 });
    else if (group.includes(needle)) scored.push({ region, rank: 2 });
  }

  scored.sort((a, b) => a.rank - b.rank || a.region.name.localeCompare(b.region.name));

  const results = scored.slice(0, MAX_RESULTS).map((s) => s.region) as SearchResult;
  results.total = scored.length;
  return results;
}

/** Lower-case and strip accents, so "polynesie" finds "Polynésie française". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function describe(shown: number, matched: number | null, total: number): string {
  if (matched === null) {
    const rest = total - shown;
    // A catalogue smaller than the nearby cap is the normal state early on, and telling
    // someone to search for "the other 0" reads as a bug.
    return rest > 0
      ? `Nearest regions — search to reach any of the other ${rest}.`
      : 'Every published region is listed.';
  }
  if (matched === 0) return 'No region matches that name.';
  if (matched > shown) return `${matched} matches — showing the first ${shown}.`;
  return matched === 1 ? '1 match.' : `${matched} matches.`;
}

/**
 * Where the map is pointed, or null before it has a centre.
 *
 * Null is a real state, not just a test convenience: this sheet can be opened from a
 * cold start before the style has loaded.
 */
function centreOf(map: MLMap): [number, number] | null {
  const centre = map.getCenter?.();
  return centre ? [centre.lng, centre.lat] : null;
}

/** Rough degrees from a point to a bbox — 0 inside it. Only used for ordering. */
function distanceTo(bbox: Region['bbox'], [lng, lat]: [number, number]): number {
  const dx = Math.max(bbox[0] - lng, 0, lng - bbox[2]);
  const dy = Math.max(bbox[1] - lat, 0, lat - bbox[3]);
  // Longitude degrees shrink towards the poles; without this a region due north scores
  // worse than one far to the east.
  const scale = Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dx * scale, dy);
}

function bboxArea(bbox: Region['bbox']): number {
  return Math.abs(bbox[2] - bbox[0]) * Math.abs(bbox[3] - bbox[1]);
}

function renderRegionRow(
  region: Region,
  status: RegionState,
  deps: RegionsUiDeps,
  refresh: () => void,
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'region-row';

  const info = document.createElement('div');
  info.className = 'region-info';

  const name = document.createElement('span');
  name.className = 'region-name';
  name.textContent = region.name;

  const meta = document.createElement('span');
  meta.className = 'region-meta';
  const kinds = region.artifacts.map((a) => a.kind).join(' + ');
  // The group disambiguates the collisions a global catalogue creates — Georgia the
  // country and Georgia the state are otherwise the same row twice.
  const where = region.group ? `${region.group} · ` : '';
  meta.textContent = `${where}${formatBytes(region.totalBytes)} · ${kinds}`;

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
    // Two taps, not one. This button sits in the same slot every other row uses for
    // "Download", and the mistake costs a re-download of the whole region — which on a
    // hill is not a mistake you can undo. The second tap names the size so the cost is
    // visible at the moment of confirming.
    action.textContent = 'Delete';
    action.classList.add('danger');

    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = (): void => {
      if (armTimer !== null) clearTimeout(armTimer);
      armTimer = null;
      action.textContent = 'Delete';
      action.classList.remove('armed');
    };

    action.addEventListener('click', () => {
      if (armTimer === null) {
        action.textContent = `Delete ${formatBytes(region.totalBytes)}?`;
        action.classList.add('armed');
        // Reverts on its own: an armed delete left sitting there is a trap for the next
        // tap, and the next tap is often someone scrolling back to this row.
        armTimer = setTimeout(disarm, ARM_TIMEOUT_MS);
        return;
      }

      disarm();
      void (async () => {
        removeRegionFromMap(deps.map, region);
        await deleteRegion(region);
        deps.onStatus(`Deleted ${region.name}. Download it again whenever you need it.`, 'ok');
        refresh();
      })();
    });
  } else {
    action.textContent = status === 'partial' ? 'Resume' : 'Download';
    // The running download turns this same button into Cancel and installs its own
    // listener for it — so this one has to stand down while that is in play, or a tap on
    // Cancel would abort the download *and* immediately start a second one.
    let running = false;
    action.addEventListener('click', () => {
      if (running) return;
      running = true;
      void startDownload(region, deps, action, progress, bar, refresh).finally(() => {
        running = false;
      });
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
