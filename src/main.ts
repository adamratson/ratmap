import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers, namedFlavor } from '@protomaps/basemaps';
import './style.css';
import {
  BASEMAP_MAX_ZOOM,
  BASEMAP_PMTILES_URL,
  FALLBACK_TERRAIN_RASTER_DEM_URL,
  GLYPHS_URL,
  OSM_ATTRIBUTION,
  SPRITE_URL,
  TERRAIN_ATTRIBUTION,
  TERRAIN_MAX_ZOOM,
  TERRAIN_PMTILES_URL,
  USE_FALLBACK_TERRAIN,
} from './config';
import { TileSourceRegistry } from './tile-source-registry';
import { addPeaksLayer, formatElevation, peakAt, type PeakProperties } from './peaks';
import { LocationController, type LocationState } from './location';
import { createInstallWatcher, INSTALL_RATIONALE, IOS_INSTALL_STEPS } from './install';
import { bootstrapStorage, isStandalone } from './storage';
import { listPlaces, savePlace, deletePlace, type SavedPlace } from './saved-places';
import { PlacesSearch, type SearchResult } from './search';
import { describeDetailLimit } from './detail-limit';
import {
  bestAvailableZoom,
  fetchManifest,
  loadCachedManifest,
  type Region,
} from './regions/manifest';
import { renderRegionsSheet, restoreDownloadedRegions } from './regions/regions-ui';
import { RoutePlanner, type RouteSummary } from './routes/route-planner';
import { renderRoutePanel, renderRoutesSheet } from './routes/routes-ui';
import { addRouteLayers } from './routes/route-layers';

// C17: the registry is the single owner of addProtocol/Protocol.add for the whole app.
const registry = TileSourceRegistry.install();
registry.addRemote(BASEMAP_PMTILES_URL);
if (!USE_FALLBACK_TERRAIN) registry.addRemote(TERRAIN_PMTILES_URL);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="map"></div>
  <div id="search">
    <input id="search-input" type="search" placeholder="Search places and summits"
           autocomplete="off" autocorrect="off" spellcheck="false" />
    <ul id="search-results" hidden></ul>
  </div>
  <div id="hud">
    <button id="locate-btn" type="button" title="Show my location">Locate</button>
    <button id="places-btn" type="button" title="Saved places">Saved</button>
    <button id="regions-btn" type="button" title="Offline regions">Offline</button>
    <button id="routes-btn" type="button" title="Routes">Routes</button>
  </div>
  <div id="route-panel" hidden></div>
  <div id="detail-notice" hidden></div>
  <div id="status-panel"></div>
  <div id="sheet" hidden></div>
`;

const statusPanel = document.querySelector<HTMLDivElement>('#status-panel')!;
const sheet = document.querySelector<HTMLDivElement>('#sheet')!;

const terrainSource: maplibregl.SourceSpecification = USE_FALLBACK_TERRAIN
  ? {
      type: 'raster-dem',
      tiles: [FALLBACK_TERRAIN_RASTER_DEM_URL],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 15,
      attribution: 'Terrain: AWS Open Data Terrain Tiles',
    }
  : {
      type: 'raster-dem',
      url: registry.sourceUrl(TERRAIN_PMTILES_URL),
      encoding: 'terrarium',
      // Coarse global extract — see config. Without this MapLibre asks for tiles above
      // the archive's real maxzoom and hillshade silently disappears when you zoom in.
      maxzoom: TERRAIN_MAX_ZOOM,
      attribution: TERRAIN_ATTRIBUTION,
    };

const map = new maplibregl.Map({
  container: 'map',
  center: [-4.5, 56.8],
  zoom: 6,
  // Attribution is legally required (ODbL) and must not be auto-hidden without user
  // action — so it stays expanded rather than collapsing to an "i" on narrow screens.
  attributionControl: { compact: false },
  style: {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: SPRITE_URL,
    sources: {
      basemap: {
        type: 'vector',
        url: registry.sourceUrl(BASEMAP_PMTILES_URL),
        maxzoom: BASEMAP_MAX_ZOOM,
        attribution: OSM_ATTRIBUTION,
      },
      terrain: terrainSource,
    },
    layers: [
      ...layers('basemap', namedFlavor('light'), { lang: 'en' }),
      { id: 'hillshade', type: 'hillshade', source: 'terrain' },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

// Debug handle. Lets the e2e suite assert on real style state (which layers and sources
// actually exist) rather than inferring it from screenshots, and is genuinely useful from
// a devtools console. Read-only by convention — nothing in the app reads it back.
(window as unknown as { __ratmapMap: maplibregl.Map }).__ratmapMap = map;

/**
 * A tile request that failed because the network is unreachable, as opposed to a genuine
 * map/style fault.
 *
 * Deliberately keyed off the error rather than `navigator.onLine`: that flag reports the
 * OS link state, not whether requests actually succeed, so it stays `true` behind a
 * captive portal, a dead uplink, or a dropped connection mid-hike — precisely this app's
 * situation. Verified during Phase 3 testing, where a fully offline map still reported
 * `navigator.onLine === true` and produced the wrong banner.
 */
export function isNetworkFailure(error: Error | undefined): boolean {
  // Matched on message, not on `name === 'TypeError'`: a real style or data bug throws
  // TypeErrors too, and misreporting those as "no connection" would hide actual faults.
  // These three messages are how Chrome, Firefox and Safari respectively report a failed
  // fetch.
  return /failed to fetch|networkerror|load failed/i.test(error?.message ?? '');
}

map.on('error', (e) => {
  console.error('MapLibre error', e.error);

  // MapLibre raises one error per failed tile, so an offline map produces dozens within a
  // second. Reporting each as its own card buried the map behind a wall of identical
  // banners — observed during the Phase 3 offline test, hence the dedupe keys.
  //
  // Losing signal is an expected state for this app, not a fault: say it once, plainly.
  if (isNetworkFailure(e.error)) {
    showStatus(
      'No connection — showing downloaded maps only. Areas without a downloaded region will be blank.',
      'warn',
      'offline-tiles',
    );
    return;
  }

  showStatus(`Map error: ${e.error?.message ?? 'unknown'} — see console`, 'error', 'map-error');
});

map.on('load', () => {
  addPeaksLayer(map, registry);
  // Added at load rather than lazily on first use: adding a source before the style is
  // ready throws, and the planner can be opened at any moment after this point.
  addRouteLayers(map);
  // Downloaded regions are restored without any user action, so a cold offline launch
  // renders from OPFS immediately (Phase 3 acceptance).
  void restoreRegions();
});

/**
 * Regions whose archives are actually present in OPFS.
 *
 * The route planner reads its network and its elevation data straight out of these
 * archives (Phase 4), so it needs to know which ones are live — not which ones the
 * catalogue lists.
 */
let downloadedRegions: Region[] = [];

async function restoreRegions(): Promise<void> {
  try {
    const manifest = await fetchManifest();
    const restored = await restoreDownloadedRegions(map, registry, manifest.regions);
    downloadedRegions = restored;
    applyAvailableDetail(restored);
  } catch {
    // Offline with no cached catalogue is normal and not an error worth surfacing:
    // any already-downloaded region still needs restoring from OPFS.
    await restoreFromOpfsWithoutManifest();
  }
}

/**
 * Set the detail ceiling from whatever regions are actually present.
 *
 * Assigned unconditionally rather than only raised: deleting a region has to lower it
 * again, or the app would keep claiming detail it no longer has.
 */
function applyAvailableDetail(regions: Region[]): void {
  maxDataZoom = bestAvailableZoom(regions, BASEMAP_MAX_ZOOM);
  renderDetailLimit();
}

/**
 * Fallback restore for a cold *offline* start: the manifest lives on the network, but the
 * archives are already local. Without this, the very scenario Phase 3 exists for — no
 * signal, relaunch, expect your downloaded region — would show the blurry global map.
 */
async function restoreFromOpfsWithoutManifest(): Promise<void> {
  const cached = loadCachedManifest();
  if (!cached) return;
  const restored = await restoreDownloadedRegions(map, registry, cached.regions);
  downloadedRegions = restored;
  applyAvailableDetail(restored);
}

// --- Detail-limit notice (§8.2 catalog-only makes this reachable) --------------------

const detailNotice = document.querySelector<HTMLDivElement>('#detail-notice')!;

// Raised once a downloaded region is loaded: the notice must reflect the best data
// actually available, not the global catalogue's ceiling, or it would keep claiming
// "limited detail" over a region the user has just downloaded.
//
// Derived from the artifacts' real PMTiles zoom ranges rather than a constant — a
// hardcoded guess drifts from whatever the pipeline last built and made the notice fire
// over a fully-downloaded region.
let maxDataZoom = BASEMAP_MAX_ZOOM;

map.on('zoom', renderDetailLimit);
map.on('load', renderDetailLimit);

function renderDetailLimit(): void {
  const state = describeDetailLimit(map.getZoom(), maxDataZoom);
  detailNotice.hidden = !state.overzoomed;
  if (!state.overzoomed) return;

  detailNotice.textContent = state.label;
  detailNotice.title = state.detail ?? '';
}

// --- Route planning (Phase 4) --------------------------------------------------------

const routePanel = document.querySelector<HTMLDivElement>('#route-panel')!;

/**
 * The planner routes over the `roads` layer inside downloaded region archives and samples
 * elevation from their terrain archives — no engine, no server, no network. Both come from
 * the same registry that backs the map itself, so a route can only be planned where the
 * map has real data, which is the honest boundary.
 */
const planner = new RoutePlanner({
  map,
  registry,
  downloadedRegions: () => downloadedRegions,
  // A tap that lands on a summit makes it a named waypoint, so a route reads
  // "Achintee → Ben Nevis" rather than as a list of coordinates.
  describePoint: (event) => {
    const peak = peakAt(map, event.point);
    if (!peak) return null;
    return {
      ...(peak.name ? { name: peak.name } : {}),
      ...(typeof peak.ele === 'number' ? { ele: peak.ele } : {}),
    };
  },
  onChange: (summary: RouteSummary) => {
    renderRoutePanel(summary, routesUi);
    routesBtn.classList.toggle('active', summary.active || summary.following);
  },
  onStatus: (message, kind) => showStatus(message, kind),
});

const routesBtn = document.querySelector<HTMLButtonElement>('#routes-btn')!;

const routesUi = {
  planner,
  panel: routePanel,
  sheet,
  onStatus: (message: string, kind: 'ok' | 'warn' | 'error') => {
    showStatus(message, kind);
  },
};

routesBtn.addEventListener('click', () => {
  void renderRoutesSheet(routesUi);
});

// Debug handle, same convention as __ratmapMap above: it lets the e2e suite assert on the
// real planner state — leg kinds, computed ascent — rather than reading it back out of the
// rendered DOM. Read-only; nothing in the app reads it.
(window as unknown as { __ratmapPlanner: RoutePlanner }).__ratmapPlanner = planner;

// --- Peak detail sheet -------------------------------------------------------------

map.on('click', (e) => {
  // While planning, a tap places a waypoint instead of opening a summit — including a tap
  // on a summit, which becomes a named waypoint rather than a detail sheet.
  if (planner.handleMapClick(e)) return;

  const peak = peakAt(map, e.point);
  if (peak) {
    showPeakSheet(peak, e.lngLat);
  } else {
    hideSheet();
  }
});

map.on('mousemove', (e) => {
  // Planning mode owns the cursor (crosshair); don't fight it over summits.
  if (planner.isActive()) return;
  map.getCanvas().style.cursor = peakAt(map, e.point) ? 'pointer' : '';
});

function showPeakSheet(peak: PeakProperties, lngLat: maplibregl.LngLat): void {
  const name = peak.name?.trim() || 'Unnamed summit';
  const ele = formatElevation(peak.ele);
  const wikidata = peak.wikidata;

  sheet.innerHTML = `
    <button class="sheet-close" type="button" aria-label="Close">×</button>
    <h2></h2>
    <p class="sheet-ele"></p>
    <p class="sheet-coords"></p>
    <div class="sheet-actions">
      <button class="sheet-save" type="button">Save place</button>
      ${wikidata ? `<a class="sheet-link" target="_blank" rel="noreferrer">Wikidata</a>` : ''}
    </div>
  `;
  // textContent, not interpolation: names come from OSM, which is user-editable data.
  sheet.querySelector('h2')!.textContent = name;
  sheet.querySelector('.sheet-ele')!.textContent = ele ?? 'Elevation unknown';
  sheet.querySelector('.sheet-coords')!.textContent =
    `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  if (wikidata) {
    const link = sheet.querySelector<HTMLAnchorElement>('.sheet-link')!;
    link.href = `https://www.wikidata.org/wiki/${encodeURIComponent(wikidata)}`;
  }

  sheet.querySelector('.sheet-close')!.addEventListener('click', hideSheet);
  sheet.querySelector('.sheet-save')!.addEventListener('click', () => {
    void savePlace({
      name,
      lng: lngLat.lng,
      lat: lngLat.lat,
      ...(typeof peak.ele === 'number' ? { ele: peak.ele } : {}),
    })
      .then(() => showStatus(`Saved “${name}”`, 'ok'))
      .catch((err: Error) => showStatus(`Could not save: ${err.message}`, 'error'));
  });

  sheet.hidden = false;
}

function hideSheet(): void {
  sheet.hidden = true;
  sheet.innerHTML = '';
}

// --- Saved places ------------------------------------------------------------------

document.querySelector('#places-btn')!.addEventListener('click', () => {
  void showPlacesSheet();
});

document.querySelector('#regions-btn')!.addEventListener('click', () => {
  void renderRegionsSheet({
    map,
    registry,
    container: sheet,
    onStatus: (message, kind) => {
      showStatus(message, kind);
      // A completed download (or a delete) changes what detail is available, so
      // re-derive the ceiling from what is actually on disk rather than assuming.
      void restoreRegions().then(() => {
        // The router caches decoded tiles per archive, including "there is nothing here".
        // A new region would otherwise stay unroutable until a reload.
        planner.invalidateRegions();
      });
    },
  });
});

async function showPlacesSheet(): Promise<void> {
  let places: SavedPlace[];
  try {
    places = await listPlaces();
  } catch (err) {
    showStatus(`Could not read saved places: ${(err as Error).message}`, 'error');
    return;
  }

  sheet.innerHTML = `
    <button class="sheet-close" type="button" aria-label="Close">×</button>
    <h2>Saved places</h2>
    <ul class="places-list"></ul>
  `;
  sheet.querySelector('.sheet-close')!.addEventListener('click', hideSheet);

  const list = sheet.querySelector<HTMLUListElement>('.places-list')!;
  if (places.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'places-empty';
    empty.textContent = 'No saved places yet — tap a summit and choose “Save place”.';
    list.append(empty);
  }

  for (const place of places) {
    const item = document.createElement('li');

    const goto = document.createElement('button');
    goto.type = 'button';
    goto.className = 'place-goto';
    const ele = formatElevation(place.ele);
    goto.textContent = ele ? `${place.name} · ${ele}` : place.name;
    goto.addEventListener('click', () => {
      map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 10) });
      hideSheet();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'place-delete';
    remove.setAttribute('aria-label', `Delete ${place.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      void deletePlace(place.id).then(() => showPlacesSheet());
    });

    item.append(goto, remove);
    list.append(item);
  }

  sheet.hidden = false;
}

// --- Search (C9: local FTS5, no geocoding API) --------------------------------------

const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const searchResults = document.querySelector<HTMLUListElement>('#search-results')!;
const search = new PlacesSearch();

let searchSeq = 0;

searchInput.addEventListener('input', () => {
  void runSearch(searchInput.value);
});

// Load the index on first focus rather than at startup: it pulls the SQLite runtime plus
// the index, and the map should render first.
searchInput.addEventListener('focus', () => {
  void search.load().catch((err: Error) => {
    showStatus(`Search unavailable: ${err.message}`, 'warn');
  });
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Node)) return;
  if (!document.querySelector('#search')!.contains(event.target)) hideSearchResults();
});

async function runSearch(query: string): Promise<void> {
  const seq = ++searchSeq;

  if (query.trim().length < 2) {
    hideSearchResults();
    return;
  }

  try {
    await search.load();
  } catch (err) {
    showStatus(`Search unavailable: ${(err as Error).message}`, 'warn');
    return;
  }

  // A slower earlier keystroke must not overwrite a newer result set.
  if (seq !== searchSeq) return;

  const centre = map.getCenter();
  const results = search.search(query, { lat: centre.lat, lon: centre.lng });
  renderSearchResults(results);
}

function renderSearchResults(results: SearchResult[]): void {
  searchResults.innerHTML = '';

  if (results.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'search-empty';
    empty.textContent = 'No matches';
    searchResults.append(empty);
    searchResults.hidden = false;
    return;
  }

  for (const result of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';

    // textContent throughout — these names come from OSM, which is user-editable.
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = result.name;

    const meta = document.createElement('span');
    meta.className = 'result-meta';
    const ele = formatElevation(result.ele);
    meta.textContent = ele ? `${result.kind} · ${ele}` : result.kind;

    button.append(name, meta);
    button.addEventListener('click', () => {
      map.easeTo({ center: [result.lon, result.lat], zoom: Math.max(map.getZoom(), 11) });
      hideSearchResults();
      searchInput.blur();
    });

    item.append(button);
    searchResults.append(item);
  }

  searchResults.hidden = false;
}

function hideSearchResults(): void {
  searchResults.hidden = true;
  searchResults.innerHTML = '';
}

// --- Location ----------------------------------------------------------------------

const locateBtn = document.querySelector<HTMLButtonElement>('#locate-btn')!;
const location = new LocationController({ map, onStateChange: renderLocationState });

locateBtn.addEventListener('click', () => {
  if (location.isFollowing()) {
    location.stop();
  } else {
    location.start();
  }
});

// Any deliberate pan drops follow mode, so the map doesn't fight the user.
map.on('dragstart', () => location.cancelFollow());

function renderLocationState(state: LocationState): void {
  locateBtn.classList.toggle('active', location.isFollowing());

  // Route following runs off the same watch as the location dot rather than starting a
  // second one: two concurrent watchPosition calls double the GPS wake-ups for no extra
  // information, and battery is the binding constraint on a long day out.
  if (state.status === 'tracking') {
    planner.updatePosition([state.position.coords.longitude, state.position.coords.latitude]);
  }

  switch (state.status) {
    case 'locating':
      locateBtn.textContent = 'Locating…';
      break;
    case 'tracking':
      locateBtn.textContent = location.isFollowing() ? 'Following' : 'Locate';
      break;
    case 'denied':
      locateBtn.textContent = 'Locate';
      showStatus(
        'Location permission denied. Enable it in browser settings to see your position.',
        'warn',
      );
      break;
    case 'unavailable':
      locateBtn.textContent = 'Locate';
      showStatus(`Location unavailable: ${state.message}`, 'warn');
      break;
    default:
      locateBtn.textContent = 'Locate';
  }
}

// --- Storage + install onboarding (C1, C2) ------------------------------------------

const installWatcher = createInstallWatcher();
installWatcher.onChange(() => void renderStorageStatus());
void renderStorageStatus();

async function renderStorageStatus(): Promise<void> {
  const status = await bootstrapStorage();

  if (status.supported && status.persisted) {
    showStatus('Persistent storage granted — offline maps are safe to download.', 'ok');
    return;
  }

  if (!status.supported) {
    showStatus('Storage API unsupported — offline maps cannot be guaranteed here (C1).', 'warn');
    return;
  }

  // Not persisted. Whether that's fixable depends on how this browser handles install.
  const capability = installWatcher.capability();

  if (capability.kind === 'prompt') {
    const card = showStatus(`Install ratmap to keep offline maps. ${INSTALL_RATIONALE}`, 'warn');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Install';
    button.addEventListener('click', () => {
      void capability.prompt().then((outcome) => {
        if (outcome === 'accepted') void renderStorageStatus();
      });
    });
    card.append(button);
    return;
  }

  if (capability.kind === 'manual-ios') {
    const card = showStatus(`Add ratmap to your Home Screen. ${INSTALL_RATIONALE}`, 'warn');
    const steps = document.createElement('ol');
    for (const step of IOS_INSTALL_STEPS) {
      const li = document.createElement('li');
      li.textContent = step;
      steps.append(li);
    }
    card.append(steps);
    return;
  }

  showStatus(
    isStandalone()
      ? 'Installed, but the browser has not granted persistent storage. Downloads stay blocked (C1).'
      : 'This browser will not guarantee offline storage. Downloads stay blocked (C1).',
    'warn',
  );
}

// --- Status panel -------------------------------------------------------------------

/**
 * @param dedupeKey when given, repeat calls reuse the existing card and show a repeat
 *   count instead of stacking duplicates. Needed because MapLibre emits one error per
 *   failed tile — without this, going offline buries the map under identical banners.
 */
function showStatus(
  message: string,
  kind: 'ok' | 'warn' | 'error',
  dedupeKey?: string,
): HTMLDivElement {
  if (dedupeKey) {
    const existing = statusPanel.querySelector<HTMLDivElement>(
      `.status-card[data-key="${dedupeKey}"]`,
    );
    if (existing) {
      const count = Number(existing.dataset.count ?? '1') + 1;
      existing.dataset.count = String(count);
      existing.querySelector('.status-count')!.textContent = `×${count}`;
      return existing;
    }
  }

  const el = document.createElement('div');
  el.className = `status-card ${kind}`;
  if (dedupeKey) {
    el.dataset.key = dedupeKey;
    el.dataset.count = '1';
  }

  const text = document.createElement('p');
  text.textContent = message;
  el.append(text);

  if (dedupeKey) {
    const count = document.createElement('span');
    count.className = 'status-count';
    el.append(count);
  }

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'status-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => el.remove());
  el.append(dismiss);

  statusPanel.prepend(el);
  return el;
}
