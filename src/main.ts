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
import { mountOpfsSpike } from './opfs-spike';

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
  </div>
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

map.on('error', (e) => {
  showStatus(`Map error: ${e.error?.message ?? 'unknown'} — see console`, 'error');
  console.error('MapLibre error', e.error);
});

map.on('load', () => {
  addPeaksLayer(map, registry);
  mountOpfsSpike(statusPanel, { protocol: registry.protocol, map });
});

// --- Peak detail sheet -------------------------------------------------------------

map.on('click', (e) => {
  const peak = peakAt(map, e.point);
  if (peak) {
    showPeakSheet(peak, e.lngLat);
  } else {
    hideSheet();
  }
});

map.on('mousemove', (e) => {
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

function showStatus(message: string, kind: 'ok' | 'warn' | 'error'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `status-card ${kind}`;
  const text = document.createElement('p');
  text.textContent = message;
  el.append(text);

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
