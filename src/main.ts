import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Self-hosted, Latin subset, only the weights style.css uses — see the --font-* tokens.
// Bundled rather than linked so they precache with the shell and render offline (C7's
// reasoning, applied to the chrome's fonts rather than the map's glyphs).
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-semi-condensed/latin-500.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './style.css';
import { BASEMAP_PMTILES_URL, TERRAIN_PMTILES_URL, USE_FALLBACK_TERRAIN } from './app/config';
import { renderInstallSheet, startStorageOnboarding } from './app/onboarding';
import { startAppUpdates } from './app/update';
import { APP_VERSION } from './app/version';
import { buildBaseStyle } from './map/base-style';
import { mapInk } from './map/flavor';
import { applyAllStoredVisibility } from './map/layers';
import { watchMapHealth } from './map/network-status';
import { TileSourceRegistry } from './map/tile-source-registry';
import {
  PeakTooltip,
  renderCoordsSheet,
  renderPathSheet,
  renderPeakSheet,
} from './overlays/feature-sheets';
import { addPeaksLayer, peakAt } from './overlays/peaks';
import { sacPathAt } from './overlays/sac';
import { setUpLocation } from './location/location-ui';
import { RegionCoverage } from './regions/coverage';
import { downloadsInFlight } from './regions/downloader';
import { renderRegionsSheet } from './regions/regions-ui';
import { onPressHold } from './routes/press-hold';
import { addRouteLayers } from './routes/route-layers';
import { RoutePlanner, type RouteSummary } from './routes/route-planner';
import { renderRoutePanel, renderRoutesSheet, type RoutesUiDeps } from './routes/routes-ui';
import { renderPlacesSheet } from './search/places-view';
import { SearchBox } from './search/search-view';
import { setUpCompass } from './ui/compass';
import { renderLayersView } from './ui/layers-view';
import { renderLegend } from './ui/legend-view';
import { isCoarsePointer } from './ui/pointer';
import { renderSettingsView, syncDebugOverlay } from './ui/settings-view';
import { BottomSheet } from './ui/sheet';
import { SheetViews } from './ui/sheet-views';
import { StatusCentre } from './ui/status';
import { ThemeController } from './ui/theme';

// The app's bootstrap: builds the page, the map and the sheet, and wires the feature
// modules to each other. Anything with logic of its own lives in one of those modules.

// C17: the registry is the single owner of addProtocol/Protocol.add for the whole app.
const registry = TileSourceRegistry.install();
registry.addRemote(BASEMAP_PMTILES_URL);
if (!USE_FALLBACK_TERRAIN) registry.addRemote(TERRAIN_PMTILES_URL);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="map"></div>
  <div id="conditions" hidden></div>
  <button id="detail-notice" type="button" hidden></button>
  <div id="peak-tooltip" hidden></div>
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

const sheetElement = document.querySelector<HTMLDivElement>('#sheet')!;

const sheet = new BottomSheet({
  element: sheetElement,
  onLayout: () => {
    // Everything positioned above the sheet reads this: the map attribution (which is
    // legally required and must never sit underneath it), toasts, and the detail notice.
    document.documentElement.style.setProperty('--sheet-visible', `${sheet.visibleHeight()}px`);
    views.renderChips();
  },
});

(window as unknown as { __ratmapSheet: BottomSheet }).__ratmapSheet = sheet;

sheet.peek.innerHTML = `
  <div id="search">
    <input id="search-input" type="search" placeholder="Search places and summits"
           autocomplete="off" autocorrect="off" spellcheck="false"
           role="combobox" aria-expanded="false" aria-controls="search-results" />
    <ul id="search-results" role="listbox" aria-label="Search results" hidden></ul>
  </div>
  <div class="peek-row">
    <div id="chips"></div>
    <button id="legend-btn" type="button" class="chip chip-icon" aria-label="Map legend">▤</button>
    <button id="settings-btn" type="button" class="chip chip-icon" aria-label="Settings">⚙</button>
  </div>
`;

const legendBtn = sheet.peek.querySelector<HTMLButtonElement>('#legend-btn')!;
const settingsBtn = sheet.peek.querySelector<HTMLButtonElement>('#settings-btn')!;

const views = new SheetViews({
  sheet,
  chipsHost: sheet.peek.querySelector<HTMLDivElement>('#chips')!,
  iconButtons: { legend: legendBtn, settings: settingsBtn },
});

views.setDestinations([
  { view: 'routes', label: 'Routes', open: () => void openRoutesView() },
  { view: 'regions', label: 'Offline', open: () => openRegionsView() },
  { view: 'places', label: 'Saved', open: () => void openPlacesView() },
  { view: 'layers', label: 'Layers', open: () => openLayersView() },
]);

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
  if (searchBox.resultsOpen()) {
    searchBox.hideResults();
    return;
  }
  if (views.view() !== null) views.close();
  else if (sheet.detent() !== 'peek') sheet.collapse();
});

/**
 * Cmd/Ctrl+K focuses search from anywhere.
 *
 * On the docked desktop panel (plans/desktop-ux-review.md B2) search sits at the top of a
 * fixed-width sidebar rather than 800px up a thumb-reach bottom sheet — reachable, but
 * still not somewhere a keyboard-first user should have to look for. Closing whatever
 * view is open first means the field lands in the same reachable place every time,
 * rather than merely present but scrolled behind the view's own content.
 */
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  if (views.view() !== null) views.close();
  searchBox.focus();
});

settingsBtn.addEventListener('click', () => views.toggle('settings', openSettingsView));
legendBtn.addEventListener('click', () => views.toggle('legend', openLegendView));

syncDebugOverlay(sheetElement);

sheet.open('peek');

// --- The map ------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  center: [-4.5, 56.8],
  zoom: 6,
  // Attribution is legally required (ODbL) and must not be auto-hidden without user
  // action — so it stays expanded rather than collapsing to an "i" on narrow screens.
  attributionControl: { compact: false },
  style: buildBaseStyle(theme.get(), registry),
});

theme.onChange((next) => {
  // Protomaps flavours are whole layer sets, so switching means replacing the style —
  // which drops every source and layer the app added on top of it. `styledata` is the
  // signal that the replacement has landed; MapLibre has no `style.load` (that is Mapbox
  // GL JS), checked against the installed typings.
  //
  // Nothing may add a layer between these two lines: the old style's layers are already
  // gone and the new one is not installed yet.
  coverage.setStyleReady(false);
  map.setStyle(buildBaseStyle(next, registry));
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

setUpCompass(map, document.querySelector<HTMLButtonElement>('#compass-btn')!);

// Debug handle. Lets the e2e suite assert on real style state (which layers and sources
// actually exist) rather than inferring it from screenshots, and is genuinely useful from
// a devtools console. Read-only by convention — nothing in the app reads it back.
(window as unknown as { __ratmapMap: maplibregl.Map }).__ratmapMap = map;

watchMapHealth(map, status);

/**
 * Everything the app puts on top of the base style.
 *
 * Runs on first load *and* after every theme swap, because replacing the style throws all
 * of it away. Each of these is idempotent against an existing source, so re-running is
 * safe even if a style event arrives twice.
 */
function installAppLayers(): void {
  coverage.setStyleReady(true);
  addPeaksLayer(map, registry, theme.get());
  // Added here rather than lazily on first use: adding a source before the style is
  // ready throws, and the planner can be opened at any moment after this point.
  addRouteLayers(map, theme.get());
  // Peaks and the catalog hillshade; regions and footprints re-apply their own as they land.
  applyAllStoredVisibility(map);
  // Downloaded regions are restored without any user action, so a cold offline launch
  // renders from OPFS immediately (Phase 3 acceptance). This also redraws the coverage
  // footprints.
  void coverage.restore();
  // A route being planned or followed has to survive a theme change — losing someone's
  // half-built route because they turned the map dark would be its own bug.
  planner.redrawGeometry();
}

// `styledata`, not `load`: `load` also waits for every tile in the initial view to
// arrive — the world catalog basemap and terrain, over the network — which can take
// long enough on a slow connection that a downloaded region sits unrestored and the
// detail-ceiling notice keeps citing the catalog's zoom 5 over ground that is already
// on disk. `installAppLayers` only needs a style that will accept sources (see
// RegionCoverage.setStyleReady), which `styledata` already gives it — the same event the
// theme-swap path above uses for the same reason.
map.once('styledata', () => installAppLayers());

const coverage = new RegionCoverage({
  map,
  registry,
  theme: () => theme.get(),
  notice: document.querySelector<HTMLButtonElement>('#detail-notice')!,
  onOpenRegions: () => openRegionsView(),
});

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
  theme: () => theme.get(),
  downloadedRegions: () => coverage.downloadedRegions(),
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
    views.setPlanMode(summary.following ? 'Following' : 'Planning');

    if (routeInProgress) {
      // views.open only moves the sheet when the view *changes*, so the re-render fired by
      // every waypoint drag redraws the panel without hauling the sheet back over a map
      // the user has just dragged it off.
      views.open('plan', (body) => renderRoutePanel(summary, routesUi(body)));
    } else if (views.view() === 'plan') {
      views.close();
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
    onPlanStarted: () => views.open('plan', (body) => renderRoutePanel(planner.summary(), routesUi(body))),
    onPlanFinished: () => planner.deactivate(),
    onStatus: (message, kind) => status.toast(message, { kind }),
    onUndoableStatus: (message, action) => status.toast(message, { action }),
  };
}

// Debug handle, same convention as __ratmapMap above: it lets the e2e suite assert on the
// real planner state — leg kinds, computed ascent — rather than reading it back out of the
// rendered DOM. Read-only; nothing in the app reads it.
(window as unknown as { __ratmapPlanner: RoutePlanner }).__ratmapPlanner = planner;

// --- Tapping the map ----------------------------------------------------------------

const peakTooltip = new PeakTooltip(document.querySelector<HTMLDivElement>('#peak-tooltip')!);

map.on('click', (e) => {
  peakTooltip.hide();

  // While planning, a tap places a waypoint instead of opening a summit — including a tap
  // on a summit, which becomes a named waypoint rather than a detail sheet.
  if (planner.handleMapClick(e)) return;

  const hit = peakAt(map, e.point);
  if (hit) {
    // The summit's own position, falling back to the tap only if the feature somehow
    // carried no geometry — otherwise the sheet reports, and "Save place" stores, the
    // spot the finger landed on rather than the summit.
    const lngLat = hit.lngLat ? new maplibregl.LngLat(...hit.lngLat) : e.lngLat;
    views.open('peak', (body) => renderPeakSheet(body, hit.properties, lngLat, { status }));
    return;
  }

  // Summits win a shared tap: they are the smaller target, and a graded path is usually
  // running right past one.
  const graded = sacPathAt(map, e.point);
  if (graded?.grade) {
    const withGrade = { ...graded, grade: graded.grade };
    views.open('path', (body) => renderPathSheet(body, withGrade));
  } else {
    views.closeDetailCard();
  }
});

function showCoordsSheet(lngLat: maplibregl.LngLat): void {
  views.open('coords', (body) => renderCoordsSheet(body, lngLat, { status }));
}

// Coordinates for a bare point are a secondary action, not the primary tap — a plain click
// on empty map already means "dismiss the sheet" (see above), so reusing it here would make
// dismissal impossible. Right-click is the desktop convention; long-press is its touch
// equivalent (contextmenu is dead on iOS since Safari 13 — see press-hold.ts), so both are
// wired the same way route-planner.ts wires waypoint removal.
map.on('contextmenu', (e) => {
  e.preventDefault();
  if (planner.isActive()) return;
  showCoordsSheet(e.lngLat);
});

onPressHold(map.getCanvasContainer(), {
  onHold: (point) => {
    if (planner.isActive()) return;
    const rect = map.getCanvasContainer().getBoundingClientRect();
    showCoordsSheet(map.unproject([point.x - rect.left, point.y - rect.top]));
  },
});

map.on('mousemove', (e) => {
  // Planning mode owns the cursor (crosshair); don't fight it over summits.
  if (planner.isActive()) return;

  const hit = peakAt(map, e.point);
  map.getCanvas().style.cursor = hit || sacPathAt(map, e.point) ? 'pointer' : '';

  if (isCoarsePointer()) return; // no hover on touch — see PeakTooltip
  if (hit) peakTooltip.show(hit.properties, e.point);
  else peakTooltip.hide();
});

map.on('mouseout', () => peakTooltip.hide());

// --- Sheet destinations --------------------------------------------------------------

function openSettingsView(): void {
  views.open('settings', (body) => renderSettingsView(body, { theme, sheetElement }));
}

function openLegendView(): void {
  views.open('legend', (body) => renderLegend(body, mapInk(theme.get())));
}

function openLayersView(): void {
  views.open('layers', (body) => renderLayersView(body, { map, ink: mapInk(theme.get()) }));
}

function openRegionsView(): void {
  views.open('regions', (body) => {
    void renderRegionsSheet({
      map,
      registry,
      theme: () => theme.get(),
      container: body,
      onStatus: (message, kind) => status.toast(message, { kind }),
      onRegionsChanged: () => {
        // A download (or a delete) changes what detail is available, so re-derive the
        // ceiling from what is actually on disk rather than assuming.
        void coverage.restore().then(() => {
          // The router caches decoded tiles per archive, including "there is nothing
          // here". A new region would otherwise stay unroutable until a reload.
          planner.invalidateRegions();
        });
      },
    });
  });
}

async function openRoutesView(): Promise<void> {
  views.open('routes', () => {});
  await renderRoutesSheet(routesUi());
}

async function openPlacesView(): Promise<void> {
  views.open('places', () => {});
  await renderPlacesSheet(sheet.body, { map, status, onGoTo: () => sheet.collapse() });
}

// --- Search (C9: local FTS5, no geocoding API) --------------------------------------

const searchBox = new SearchBox({
  container: document.querySelector<HTMLElement>('#search')!,
  input: document.querySelector<HTMLInputElement>('#search-input')!,
  results: document.querySelector<HTMLUListElement>('#search-results')!,
  map,
  status,
  onCoordinates: (coords) => showCoordsSheet(new maplibregl.LngLat(coords.lng, coords.lat)),
});

// --- Location ----------------------------------------------------------------------

setUpLocation({
  map,
  button: document.querySelector<HTMLButtonElement>('#locate-btn')!,
  status,
  onPosition: (lngLat) => planner.updatePosition(lngLat),
  onDotClick: ([lng, lat]) => showCoordsSheet(new maplibregl.LngLat(lng, lat)),
});

// --- Storage + install onboarding (C1, C2) ------------------------------------------

startStorageOnboarding({
  status,
  showInstallSteps: () => views.open('install', renderInstallSheet),
});

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
