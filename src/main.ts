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
import { HeadingWatcher } from './heading';
import { LocationController, type LocationState } from './location';
import { createInstallWatcher, INSTALL_RATIONALE, IOS_INSTALL_STEPS } from './install';
import { bootstrapStorage, isStandalone } from './storage';
import { listPlaces, savePlace, deletePlace, type SavedPlace } from './saved-places';
import { PlacesSearch, type SearchResult } from './search';
import { describeDetailLimit } from './detail-limit';
import { ThemeController, nextPreference, type Theme, type ThemePreference } from './theme';
import { isCoarsePointer } from './pointer';
import {
  bestAvailableZoom,
  fetchManifest,
  loadCachedManifest,
  type Region,
} from './regions/manifest';
import {
  regionAt,
  renderFootprints,
  type Footprint,
} from './regions/region-footprints';
import { renderRegionsSheet, restoreDownloadedRegions } from './regions/regions-ui';
import { downloadsInFlight } from './regions/downloader';
import { BottomSheet, type Detent } from './sheet';
import { StatusCentre } from './status';
import { startAppUpdates } from './update';
import { APP_VERSION } from './version';
import { compassBearing, distanceMetres, formatDistance } from './routes/geo';
import { RoutePlanner, type RouteSummary } from './routes/route-planner';
import { renderRoutePanel, renderRoutesSheet, type RoutesUiDeps } from './routes/routes-ui';
import { addRouteLayers } from './routes/route-layers';

// C17: the registry is the single owner of addProtocol/Protocol.add for the whole app.
const registry = TileSourceRegistry.install();
registry.addRemote(BASEMAP_PMTILES_URL);
if (!USE_FALLBACK_TERRAIN) registry.addRemote(TERRAIN_PMTILES_URL);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="map"></div>
  <div id="conditions" hidden></div>
  <button id="detail-notice" type="button" hidden></button>
  <div id="rail">
    <button id="locate-btn" type="button" aria-label="Show my location">
      <span class="rail-icon" aria-hidden="true">◎</span>
    </button>
    <button id="compass-btn" type="button" aria-label="Point the map north" hidden>
      <span class="rail-icon compass-needle" aria-hidden="true">▲</span>
    </button>
  </div>
  <div id="toasts"></div>
  <div id="sheet"></div>
`;

// Constructed before anything reads it: it stamps `data-theme` on the document in its
// constructor, so the first paint is already the right theme rather than a white flash
// that corrects itself.
const theme = new ThemeController();

const status = new StatusCentre({
  toasts: document.querySelector<HTMLDivElement>('#toasts')!,
  conditions: document.querySelector<HTMLDivElement>('#conditions')!,
});

// Debug handle, same convention as __ratmapMap below: "why is that banner up, and what
// put it there?" is otherwise only answerable by reading the source.
(window as unknown as { __ratmapStatus: StatusCentre }).__ratmapStatus = status;

// --- The sheet ----------------------------------------------------------------------

const sheet = new BottomSheet({
  element: document.querySelector<HTMLDivElement>('#sheet')!,
  onLayout: () => {
    // Everything positioned above the sheet reads this: the map attribution (which is
    // legally required and must never sit underneath it), toasts, and the detail notice.
    document.documentElement.style.setProperty('--sheet-visible', `${sheet.visibleHeight()}px`);
    renderChips();
  },
});

(window as unknown as { __ratmapSheet: BottomSheet }).__ratmapSheet = sheet;

sheet.peek.innerHTML = `
  <div id="search">
    <input id="search-input" type="search" placeholder="Search places and summits"
           autocomplete="off" autocorrect="off" spellcheck="false" />
    <ul id="search-results" aria-label="Search results" hidden></ul>
  </div>
  <div class="peek-row">
    <div id="chips"></div>
    <button id="theme-btn" type="button" class="chip chip-icon"></button>
  </div>
`;

/** What the sheet body is currently showing. `null` is the resting state. */
type View = 'peak' | 'places' | 'regions' | 'routes' | 'plan' | 'install';

let view: View | null = null;

/**
 * Whether the `plan` view is planning or following.
 *
 * They are different modes with different rules — one takes map taps as waypoints, the
 * other does not — so the peek row has to name which one is on, or the mode is invisible
 * whenever the sheet is at rest.
 */
let planMode: 'Planning' | 'Following' = 'Planning';

/**
 * Show something in the sheet.
 *
 * The detent is only set when the view *changes*. A view that re-renders — the planner
 * does so on every waypoint drag — must not haul the sheet back up over a map the user
 * has just dragged it off.
 */
function openView(name: View, render: (body: HTMLElement) => void, detent: Detent = 'content'): void {
  const entering = view !== name;
  view = name;
  sheet.body.setAttribute('aria-label', VIEW_LABEL[name]);
  render(sheet.body);
  if (entering) {
    sheet.scrollToTop();
    sheet.open(detent);
  }
  renderChips();
}

function closeView(): void {
  if (view === null) return;
  view = null;
  sheet.body.removeAttribute('aria-label');
  sheet.body.innerHTML = '';
  sheet.collapse();
  renderChips();
}

/**
 * The peek row's destinations.
 *
 * These are what the four-button HUD used to be, moved off the map and into the one
 * surface — and now they also report which view is open, which the HUD could not do
 * because the planning panel covered it.
 */
const CHIPS: { view: View; label: string; open: () => void }[] = [
  { view: 'routes', label: 'Routes', open: () => void openRoutesView() },
  { view: 'regions', label: 'Offline', open: () => openRegionsView() },
  { view: 'places', label: 'Saved', open: () => void openPlacesView() },
];

const chipsHost = sheet.peek.querySelector<HTMLDivElement>('#chips')!;

function renderChips(): void {
  chipsHost.innerHTML = '';

  // Planning is a mode, not a destination: it is entered from the routes list and left
  // with Done, so its chip only exists while it is on. Without it the mode is invisible
  // at peek, and a tap on the map silently means something different.
  if (view === 'plan') {
    const chip = chipEl(planMode, true, () =>
      sheet.detent() === 'peek' ? sheet.open('content') : sheet.collapse(),
    );
    chip.classList.add('chip-mode');
    chipsHost.append(chip);
  }

  for (const entry of CHIPS) {
    const active = view === entry.view;
    chipsHost.append(
      chipEl(entry.label, active, () => {
        // Tapping the open one puts the map back, so every chip is its own way out.
        if (active && sheet.detent() !== 'peek') closeView();
        else entry.open();
      }),
    );
  }
}

/**
 * Escape puts the map back.
 *
 * The one thing every dismissible surface owes a keyboard user, and the sheet swallowed
 * it: with no per-panel close button left, there was otherwise no key that closed
 * anything. Search results take it first, because there Escape means "abandon this
 * search", not "close the sheet I am typing into".
 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!searchResults.hidden) {
    hideSearchResults();
    return;
  }
  if (view !== null) closeView();
  else if (sheet.detent() !== 'peek') sheet.collapse();
});

// --- Theme ---------------------------------------------------------------------------

const themeBtn = sheet.peek.querySelector<HTMLButtonElement>('#theme-btn')!;

const THEME_ICON: Record<ThemePreference, string> = { system: '◐', light: '☀', dark: '☾' };
const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Map theme: follows your device',
  light: 'Map theme: light',
  dark: 'Map theme: dark',
};

themeBtn.addEventListener('click', () => {
  theme.set(nextPreference(theme.getPreference()));
  renderThemeButton();
});

// Also on system changes, which move the effective theme without touching the preference.
theme.onChange(() => renderThemeButton());

function renderThemeButton(): void {
  const preference = theme.getPreference();
  themeBtn.textContent = THEME_ICON[preference];
  // The label says the current state rather than the next one: a control that announces
  // what it will become is unreadable when you are trying to work out where you are.
  themeBtn.setAttribute('aria-label', THEME_LABEL[preference]);
  themeBtn.title = THEME_LABEL[preference];
}

renderThemeButton();

sheet.open('peek');

function chipEl(label: string, active: boolean, onSelect: () => void): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  // A disclosure, not a tab. Tabs imply a panel that is always showing one of a set;
  // here the sheet is usually showing nothing at all, and each chip both opens and
  // closes its own view.
  chip.setAttribute('aria-expanded', String(active));
  chip.setAttribute('aria-controls', 'sheet-body');
  chip.classList.toggle('active', active);
  chip.textContent = label;
  chip.addEventListener('click', onSelect);
  return chip;
}

/** What a screen reader should call the sheet's contents, per view. */
const VIEW_LABEL: Record<View, string> = {
  peak: 'Summit details',
  places: 'Saved places',
  regions: 'Offline regions',
  routes: 'Routes',
  plan: 'Route planner',
  install: 'Add to Home Screen',
};

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

/**
 * The base style, for a given theme.
 *
 * A function rather than a literal because the theme is switchable at runtime and
 * Protomaps ships the flavours as whole layer sets — there is no per-layer paint property
 * to flip. Only the basemap and the terrain live here; everything the app adds on top
 * (peaks, routes, downloaded regions, coverage) is re-installed by installAppLayers.
 */
function buildStyle(theme: Theme): maplibregl.StyleSpecification {
  return {
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
      ...layers('basemap', namedFlavor(theme), { lang: 'en' }),
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain',
        // Style-spec default is 0.5; dialled down 10% to match the region hillshade's own
        // reduction in region-layers.ts.
        paint: { 'hillshade-exaggeration': 0.45 },
      },
    ],
  };
}

const map = new maplibregl.Map({
  container: 'map',
  center: [-4.5, 56.8],
  zoom: 6,
  // Attribution is legally required (ODbL) and must not be auto-hidden without user
  // action — so it stays expanded rather than collapsing to an "i" on narrow screens.
  attributionControl: { compact: false },
  style: buildStyle(theme.get()),
});

theme.onChange((next) => {
  // Protomaps flavours are whole layer sets, so switching means replacing the style —
  // which drops every source and layer the app added on top of it. `styledata` is the
  // signal that the replacement has landed; MapLibre has no `style.load` (that is Mapbox
  // GL JS), checked against the installed typings.
  map.setStyle(buildStyle(next));
  map.once('styledata', () => installAppLayers());
});

// NavigationControl only on a mouse. Its buttons are 29px, they sit in the top corner —
// the furthest point on the screen from a thumb — and on a touch screen they duplicate a
// pinch that already works at full-screen size. What a finger actually needs from it is
// "put north back", which the rail's compass button does, at 44px, in reach.
if (!isCoarsePointer()) {
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
}
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

// --- Compass ------------------------------------------------------------------------

const compassBtn = document.querySelector<HTMLButtonElement>('#compass-btn')!;
const compassNeedle = compassBtn.querySelector<HTMLElement>('.compass-needle')!;

compassBtn.addEventListener('click', () => {
  map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
});

// Only present when it has something to undo. A permanent compass on a map that is always
// north-up is a control that never does anything, taking up the scarcest space there is.
function renderCompass(): void {
  const bearing = map.getBearing();
  compassBtn.hidden = Math.abs(bearing) < 1 && map.getPitch() < 1;
  compassNeedle.style.transform = `rotate(${-bearing}deg)`;
}

map.on('rotate', renderCompass);
map.on('pitch', renderCompass);
renderCompass();

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
  // second. As a condition rather than a message, re-reporting is free: the twentieth
  // failed tile replaces the first instead of stacking a twentieth banner.
  //
  // Losing signal is an expected state for this app, not a fault: say it once, plainly,
  // and take it back down when tiles start arriving again.
  if (isNetworkFailure(e.error)) {
    status.setCondition('offline', {
      message: 'No connection. Downloaded areas still work; everywhere else is blank.',
      kind: 'warn',
    });
    return;
  }

  status.setCondition('map-error', {
    message: `Something went wrong drawing the map: ${e.error?.message ?? 'unknown error'}`,
    kind: 'error',
  });
});

// Tiles arriving again is the only reliable signal that the connection is back:
// `navigator.onLine` reports the OS link state and stays true behind a dead uplink, which
// is exactly this app's situation (see isNetworkFailure above).
map.on('sourcedata', (e) => {
  if (e.isSourceLoaded) status.setCondition('offline', null);
});

/**
 * Everything the app puts on top of the base style.
 *
 * Runs on first load *and* after every theme swap, because replacing the style throws all
 * of it away. Each of these is idempotent against an existing source, so re-running is
 * safe even if a style event arrives twice.
 */
function installAppLayers(): void {
  addPeaksLayer(map, registry);
  // Added here rather than lazily on first use: adding a source before the style is
  // ready throws, and the planner can be opened at any moment after this point.
  addRouteLayers(map);
  // Downloaded regions are restored without any user action, so a cold offline launch
  // renders from OPFS immediately (Phase 3 acceptance). This also redraws the coverage
  // footprints.
  void restoreRegions();
  // A route being planned or followed has to survive a theme change — losing someone's
  // half-built route because they turned the map dark would be its own bug.
  planner.redrawGeometry();
}

map.on('load', () => installAppLayers());

/**
 * Regions whose archives are actually present in OPFS.
 *
 * The route planner reads its network and its elevation data straight out of these
 * archives (Phase 4), so it needs to know which ones are live — not which ones the
 * catalogue lists.
 */
let downloadedRegions: Region[] = [];

/**
 * Everything the catalogue offers, downloaded or not.
 *
 * Kept alongside {@link downloadedRegions} so the map can show where detail *could* come
 * from, not only where it already has some.
 */
let catalogue: Region[] = [];

async function restoreRegions(): Promise<void> {
  try {
    const manifest = await fetchManifest();
    const restored = await restoreDownloadedRegions(map, registry, manifest.regions);
    downloadedRegions = restored;
    catalogue = manifest.regions;
    applyAvailableDetail(restored);
    drawFootprints();
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
  catalogue = cached.regions;
  applyAvailableDetail(restored);
  drawFootprints();
}

/** Current coverage, downloaded state and all. */
function footprints(): Footprint[] {
  const have = new Set(downloadedRegions.map((region) => region.id));
  return catalogue.map((region) => ({ region, downloaded: have.has(region.id) }));
}

function drawFootprints(): void {
  // The style has to exist first — this runs from a restore that can finish before the
  // map has loaded, and addSource throws on a style that is not ready.
  if (!map.isStyleLoaded()) {
    map.once('load', drawFootprints);
    return;
  }
  renderFootprints(map, footprints());
}

// --- Detail-limit notice (§8.2 catalog-only makes this reachable) --------------------

const detailNotice = document.querySelector<HTMLButtonElement>('#detail-notice')!;

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

detailNotice.addEventListener('click', () => openRegionsView());

function renderDetailLimit(): void {
  const state = describeDetailLimit(map.getZoom(), maxDataZoom);
  detailNotice.hidden = !state.overzoomed;
  if (!state.overzoomed) return;

  // Naming the region turns a complaint into an instruction. The notice reports that the
  // map is stretched here; the thing that fixes it is a specific download, and until now
  // nothing connected the two — you had to open a list of four names and work out for
  // yourself which one you were looking at.
  const centre = map.getCenter();
  const covering = regionAt(footprints(), [centre.lng, centre.lat], { downloaded: false });

  detailNotice.textContent = covering
    ? `Limited detail here — get ${covering.name}`
    : (state.label ?? '');
  detailNotice.title = state.detail ?? '';
}

// --- Route planning (Phase 4) --------------------------------------------------------


/**
 * True while a route is being planned or followed — i.e. while an unannounced reload
 * would throw away work, or drop someone mid-navigation on a hill. Read by the update
 * controller below; declared ahead of the planner because `onChange` can fire during
 * construction.
 */
let routeInProgress = false;

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
    const hit = peakAt(map, event.point);
    if (!hit) return null;
    const { properties, lngLat } = hit;
    return {
      ...(properties.name ? { name: properties.name } : {}),
      ...(typeof properties.ele === 'number' ? { ele: properties.ele } : {}),
      // Snapped to the summit, not to the tap. RouteDraft.add spreads this over the
      // tapped coordinates, so a waypoint called "Ben Nevis" is on Ben Nevis rather than
      // up to a tap-box away from it.
      ...(lngLat ? { lng: lngLat[0], lat: lngLat[1] } : {}),
    };
  },
  onChange: (summary: RouteSummary) => {
    routeInProgress = summary.active || summary.following;
    planMode = summary.following ? 'Following' : 'Planning';

    if (routeInProgress) {
      // openView only moves the sheet when the view *changes*, so the re-render fired by
      // every waypoint drag redraws the panel without hauling the sheet back over a map
      // the user has just dragged it off.
      openView('plan', (body) => renderRoutePanel(summary, routesUi(body)));
    } else if (view === 'plan') {
      closeView();
    }
  },
  onStatus: (message, kind) => status.toast(message, { kind }),
});

/**
 * The routes UI's dependencies, bound to wherever it is being asked to draw.
 *
 * A function rather than a constant because the planner and the saved-routes list share
 * the sheet body, and each render is handed the container it should use.
 */
function routesUi(container: HTMLElement = sheet.body): RoutesUiDeps {
  return {
    planner,
    container,
    onPlanStarted: () => openView('plan', (body) => renderRoutePanel(planner.summary(), routesUi(body))),
    onPlanFinished: () => planner.deactivate(),
    onStatus: (message, kind) => status.toast(message, { kind }),
    onUndoableStatus: (message, action) => status.toast(message, { action }),
  };
}

// Debug handle, same convention as __ratmapMap above: it lets the e2e suite assert on the
// real planner state — leg kinds, computed ascent — rather than reading it back out of the
// rendered DOM. Read-only; nothing in the app reads it.
(window as unknown as { __ratmapPlanner: RoutePlanner }).__ratmapPlanner = planner;

// --- Peak detail sheet -------------------------------------------------------------

map.on('click', (e) => {
  // While planning, a tap places a waypoint instead of opening a summit — including a tap
  // on a summit, which becomes a named waypoint rather than a detail sheet.
  if (planner.handleMapClick(e)) return;

  const hit = peakAt(map, e.point);
  if (hit) {
    // The summit's own position, falling back to the tap only if the feature somehow
    // carried no geometry — otherwise the sheet reports, and "Save place" stores, the
    // spot the finger landed on rather than the summit.
    showPeakSheet(hit.properties, hit.lngLat ? new maplibregl.LngLat(...hit.lngLat) : e.lngLat);
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

  openView('peak', (body) => {
    body.innerHTML = `
      <h2></h2>
      <p class="sheet-ele"></p>
      <p class="sheet-coords"></p>
      <div class="sheet-actions">
        <button class="sheet-save" type="button">Save place</button>
        ${wikidata ? `<a class="sheet-link" target="_blank" rel="noreferrer">Wikidata</a>` : ''}
      </div>
    `;
    // textContent, not interpolation: names come from OSM, which is user-editable data.
    body.querySelector('h2')!.textContent = name;
    body.querySelector('.sheet-ele')!.textContent = ele ?? 'Elevation unknown';
    body.querySelector('.sheet-coords')!.textContent =
      `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
    if (wikidata) {
      const link = body.querySelector<HTMLAnchorElement>('.sheet-link')!;
      link.href = `https://www.wikidata.org/wiki/${encodeURIComponent(wikidata)}`;
    }

    body.querySelector('.sheet-save')!.addEventListener('click', () => {
      void savePlace({
        name,
        lng: lngLat.lng,
        lat: lngLat.lat,
        ...(typeof peak.ele === 'number' ? { ele: peak.ele } : {}),
      })
        .then(() => status.toast(`Saved “${name}”`))
        .catch((err: Error) =>
          status.toast(`Could not save “${name}”: ${err.message}`, { kind: 'error' }),
        );
    });
  });
}

/**
 * A summit sheet is a detail card, not a destination: it should not swallow half the map
 * you tapped it on.
 */
function hideSheet(): void {
  if (view === 'peak') closeView();
}

// --- Sheet destinations --------------------------------------------------------------

function openRegionsView(): void {
  openView('regions', (body) => {
    void renderRegionsSheet({
      map,
      registry,
      container: body,
      onStatus: (message, kind) => {
        status.toast(message, { kind });
        // A completed download (or a delete) changes what detail is available, so
        // re-derive the ceiling from what is actually on disk rather than assuming.
        void restoreRegions().then(() => {
          // The router caches decoded tiles per archive, including "there is nothing
          // here". A new region would otherwise stay unroutable until a reload.
          planner.invalidateRegions();
        });
      },
    });
  });
}

async function openRoutesView(): Promise<void> {
  openView('routes', () => {});
  await renderRoutesSheet(routesUi());
}

async function openPlacesView(): Promise<void> {
  openView('places', () => {});
  await showPlacesSheet();
}

async function showPlacesSheet(): Promise<void> {
  let places: SavedPlace[];
  try {
    places = await listPlaces();
  } catch (err) {
    status.toast(`Could not open saved places: ${(err as Error).message}`, { kind: 'error' });
    return;
  }

  sheet.body.innerHTML = `
    <h2>Saved places</h2>
    <ul class="places-list"></ul>
  `;

  const list = sheet.body.querySelector<HTMLUListElement>('.places-list')!;
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
      // Out of the way, but still one drag from the list — going to a place is usually
      // the first of several.
      sheet.collapse();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'place-delete';
    remove.setAttribute('aria-label', `Delete ${place.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      // Deleted immediately, with a way back — rather than a confirmation dialog in front
      // of every delete. savePlace takes an explicit id and savedAt, so undo restores the
      // same record rather than a copy of it.
      void deletePlace(place.id).then(() => {
        void showPlacesSheet();
        status.toast(`Deleted “${place.name}”`, {
          action: {
            label: 'Undo',
            onSelect: () => void savePlace(place).then(() => void showPlacesSheet()),
          },
        });
      });
    });

    item.append(goto, remove);
    list.append(item);
  }

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
    status.toast(`Search is unavailable: ${err.message}`, { kind: 'warn' });
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
    status.toast(`Search is unavailable: ${(err as Error).message}`, { kind: 'warn' });
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
    // Distance and direction, not just kind and height. The query already ranks by
    // distance from the viewport centre, but showing only "peak · 1174 m" hid that
    // ranking entirely — and Scotland has several Ben Mores, rendered as identical rows.
    const centre = map.getCenter();
    const from: [number, number] = [centre.lng, centre.lat];
    const to: [number, number] = [result.lon, result.lat];
    const parts = [result.kind];
    const ele = formatElevation(result.ele);
    if (ele) parts.push(ele);
    parts.push(`${formatDistance(distanceMetres(from, to))} ${compassBearing(from, to)}`);
    meta.textContent = parts.join(' · ');

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

/**
 * The compass.
 *
 * Started from the button tap rather than at load, because iOS gates device orientation
 * behind a permission prompt that must be raised from a user gesture — asked for on page
 * load it is refused outright, and asked for before the user has shown any interest in
 * their own position it is a prompt with no context.
 */
const heading = new HeadingWatcher((degrees) => location.setHeading(degrees));

locateBtn.addEventListener('click', () => {
  if (location.isFollowing()) {
    location.stop();
    heading.stop();
  } else {
    location.start();
    // Not awaited and not reported: a missing compass costs the cone and nothing else,
    // and the dot is the thing that was actually asked for.
    void heading.start();
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

  // A location failure is a state, not an event: it stays true until the permission or
  // the fix changes, and watchPosition re-reports it on every retry. As a toast that
  // meant a new banner every few seconds.
  // The rail button is an icon, and its state is carried by a class rather than by
  // rewriting its label — a control that changes width as it changes state shifts
  // everything next to it, and this one sits under a thumb.
  locateBtn.classList.toggle('locating', state.status === 'locating');
  locateBtn.setAttribute(
    'aria-label',
    location.isFollowing() ? 'Stop following my location' : 'Show my location',
  );

  switch (state.status) {
    case 'locating':
      status.setCondition('location', null);
      break;
    case 'tracking':
      status.setCondition('location', null);
      break;
    case 'denied':
      status.setCondition('location', {
        message: 'ratmap cannot see your location. Allow it in your browser settings.',
        kind: 'warn',
      });
      break;
    case 'unavailable':
      status.setCondition('location', {
        message: `No position fix yet: ${state.message}`,
        kind: 'warn',
      });
      break;
    default:
      status.setCondition('location', null);
  }
}

// --- Storage + install onboarding (C1, C2) ------------------------------------------

const installWatcher = createInstallWatcher();
installWatcher.onChange(() => void renderStorageStatus());
void renderStorageStatus();

async function renderStorageStatus(): Promise<void> {
  const storage = await bootstrapStorage();

  // Nothing to say when it works. This used to announce "Persistent storage granted" on
  // every single launch, which is a banner over the map for a state the user never has to
  // do anything about.
  if (storage.supported && storage.persisted) {
    status.setCondition('storage', null);
    return;
  }

  if (!storage.supported) {
    status.setCondition('storage', {
      message: 'This browser can’t promise to keep downloaded maps, so downloads are off.',
      kind: 'warn',
    });
    return;
  }

  // Not persisted. Whether that's fixable depends on how this browser handles install.
  const capability = installWatcher.capability();

  if (capability.kind === 'prompt') {
    status.setCondition('storage', {
      message: 'Install ratmap to download maps for offline use.',
      kind: 'warn',
      action: {
        label: 'Install',
        onSelect: () => {
          void capability.prompt().then((outcome) => {
            if (outcome === 'accepted') void renderStorageStatus();
          });
        },
      },
    });
    return;
  }

  if (capability.kind === 'manual-ios') {
    status.setCondition('storage', {
      message: 'Add ratmap to your Home Screen to download maps.',
      kind: 'warn',
      // The three Share-sheet steps are too long for a line over the map, and they used to
      // sit there permanently as an ordered list. Behind a button they are available when
      // wanted and gone the rest of the time.
      action: { label: 'How', onSelect: showInstallSheet },
    });
    return;
  }

  status.setCondition('storage', {
    message: isStandalone()
      ? 'Your browser hasn’t granted ratmap permanent storage yet, so downloads are off.'
      : 'Downloads are off until ratmap is installed — a browser tab can’t keep maps safely.',
    kind: 'warn',
  });
}

function showInstallSheet(): void {
  openView('install', (body) => {
    body.innerHTML = `
      <h2>Add ratmap to your Home Screen</h2>
      <p class="sheet-lede"></p>
      <ol class="install-steps"></ol>
    `;
    body.querySelector('.sheet-lede')!.textContent = INSTALL_RATIONALE;

    const steps = body.querySelector<HTMLOListElement>('.install-steps')!;
    for (const step of IOS_INSTALL_STEPS) {
      const item = document.createElement('li');
      item.textContent = step;
      steps.append(item);
    }
  });
}

// --- App updates --------------------------------------------------------------------

// Debug handle, same convention as __ratmapMap above: "which build is this?" is the first
// question worth asking whenever the app behaves like an older one, and until now nothing
// could answer it.
(window as unknown as { __ratmapVersion: string }).__ratmapVersion = APP_VERSION;

// Dev builds have no generated worker, so registering one would only 404. Everything
// under test here — precaching, the update swap — exists solely in a real build, which is
// also what `vite preview` and the e2e suite run.
if (import.meta.env.PROD) {
  startAppUpdates({
    swUrl: `${import.meta.env.BASE_URL}sw.js`,
    scope: import.meta.env.BASE_URL,
    isBusy: () => downloadsInFlight() > 0 || routeInProgress,
    onUpdateHeld: (apply) => {
      // Reached only when the update was held back, so it always has a concrete reason —
      // worth naming, because "update available" with no explanation of why it is not
      // being applied reads as a stuck app.
      const reason =
        downloadsInFlight() > 0 ? 'when the download finishes' : 'when you finish your route';
      status.setCondition('update', {
        message: `A new version is ready. It will load ${reason}.`,
        kind: 'ok',
        action: { label: 'Reload now', onSelect: apply },
      });
    },
  });
}
