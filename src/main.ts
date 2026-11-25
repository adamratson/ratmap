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
import { reportUncaughtErrors } from './app/error-reporting';
import { renderInstallSheet, startStorageOnboarding } from './app/onboarding';
import { startAppUpdates, type AppUpdates } from './app/update';
import { APP_VERSION } from './app/version';
import { buildBaseStyle } from './map/base-style';
import { mapInk } from './map/flavor';
import { applyAllStoredVisibility, isLayerVisible } from './map/layers';
import { watchMapHealth } from './map/network-status';
import { supplyParkingIcons } from './map/parking';
import { TileSourceRegistry } from './map/tile-source-registry';
import {
  type CardRoute,
  PeakTooltip,
  renderCoordsSheet,
  renderPathSheet,
  renderPeakSheet,
} from './overlays/feature-sheets';
import { addPeaksLayer, peakAt } from './overlays/peaks';
import { sacPathAt } from './overlays/sac';
import { setUpLocation } from './location/location-ui';
import { NO_INSET, type ViewInset } from './map/view-inset';
import { readLastView, rememberView } from './map/last-view';
import type { PeakProperties } from './overlays/peaks';
import { RegionCoverage } from './regions/coverage';
import { downloadsInFlight } from './regions/downloader';
import { renderRegionsSheet } from './regions/regions-ui';
import { DraftKeeper, readDraft } from './routes/draft-store';
import { onPressHold } from './routes/press-hold';
import { addRouteLayers } from './routes/route-layers';
import { RoutePlanner, type RoutePoint, type RouteSummary } from './routes/route-planner';
import {
  openRouteLink,
  renderRoutePanel,
  renderRoutesSheet,
  type RoutesUiDeps,
} from './routes/routes-ui';
import { LinkTooNew, payloadFromHash } from './routes/share-link';
import { renderPlacesSheet } from './search/places-view';
import { regionSearchIndexes } from './search/region-indexes';
import { SearchBox } from './search/search-view';
import type { SearchResult } from './search/search';
import { PrintController } from './print/print-view';
import { ROUTE_SOURCE_ID } from './routes/route-layers';
import { setUpCompass } from './ui/compass';
import { CompassView } from './ui/compass-view';
import { PositionReadout } from './location/position-readout';
import { renderLayersView } from './ui/layers-view';
import { renderLegend } from './ui/legend-view';
import { isCoarsePointer, prefersDockedSheet } from './ui/pointer';
import { renderSettingsView, syncDebugOverlay } from './ui/settings-view';
import { BottomSheet } from './ui/sheet';
import { SheetViews } from './ui/sheet-views';
import { StatusCentre } from './ui/status';
import { ThemeController } from './ui/theme';
import { coordsGestureUsed, coordsHint, markCoordsGestureUsed } from './ui/hints';

// The app's bootstrap: builds the page, the map and the sheet, and wires the feature
// modules to each other. Anything with logic of its own lives in one of those modules.

// C17: the registry is the single owner of addProtocol/Protocol.add for the whole app.
const registry = TileSourceRegistry.install();
registry.addRemote(BASEMAP_PMTILES_URL);
if (!USE_FALLBACK_TERRAIN) registry.addRemote(TERRAIN_PMTILES_URL);

// The sheet comes first in the source, although it is drawn over the map (z-index): it
// holds search and the destinations, and on the docked desktop layout it is the panel on
// the left. Placed after the map, a keyboard user tabbed through the map's zoom controls,
// attribution links and the rail before reaching the first thing on screen.
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1 class="visually-hidden">ratmap</h1>
  <div id="sheet"></div>
  <div id="map"></div>
  <div id="conditions" hidden></div>
  <button id="detail-notice" type="button" hidden></button>
  <div id="peak-tooltip" hidden></div>
  <div id="rail">
    <button id="locate-btn" type="button" aria-label="Show my location">
      <span class="rail-icon" aria-hidden="true">◎</span>
    </button>
    <button id="compass-view-btn" type="button" aria-label="Compass">
      <svg class="rail-icon rail-svg" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <path d="M12 4.5 L14.6 12 L9.4 12 Z" class="rail-compass-north"/>
        <path d="M12 19.5 L14.6 12 L9.4 12 Z" fill="currentColor"/>
      </svg>
    </button>
    <button id="compass-btn" type="button" aria-label="Point the map north" hidden>
      <span class="rail-icon compass-needle" aria-hidden="true">▲</span>
    </button>
  </div>
  <div id="toasts"></div>
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

// Registered as soon as there is somewhere to say it, so a failure anywhere in the rest of
// the bootstrap is reported too.
reportUncaughtErrors(status);

// --- The sheet ----------------------------------------------------------------------

const sheetElement = document.querySelector<HTMLDivElement>('#sheet')!;

/** The Print view's frame over the map. Made once the map exists; the sheet reads it first. */
let printer: PrintController | null = null;

const sheet = new BottomSheet({
  element: sheetElement,
  onLayout: () => {
    // Everything positioned above the sheet reads this: the map attribution (which is
    // legally required and must never sit underneath it), toasts, and the detail notice.
    document.documentElement.style.setProperty('--sheet-visible', `${sheet.visibleHeight()}px`);
    views.renderChips();
    // The frame sits in the middle of the map the sheet leaves showing.
    printer?.layoutChanged();
  },
});

(window as unknown as { __ratmapSheet: BottomSheet }).__ratmapSheet = sheet;

sheet.peek.innerHTML = `
  <div id="search" role="search">
    <input id="search-input" type="search" placeholder="Search places and summits"
           aria-label="Search places and summits"
           autocomplete="off" autocorrect="off" spellcheck="false"
           role="combobox" aria-expanded="false" aria-controls="search-results" />
    <ul id="search-results" role="listbox" aria-label="Search results" hidden></ul>
  </div>
  <div class="peek-row">
    <div id="chips"></div>
  </div>
`;


/**
 * The compass panel (src/ui/compass-view.ts). Bearings are corrected for declination and
 * grid convergence where you are, or where the map is looking without a fix.
 */
const compassView = new CompassView({
  place: () => {
    const state = locationUi.location.getState();
    if (state.status === 'tracking') {
      return { lng: state.position.coords.longitude, lat: state.position.coords.latitude };
    }
    const { lng, lat } = map.getCenter().wrap();
    return { lng, lat };
  },
});

const compassViewButton = document.querySelector<HTMLButtonElement>('#compass-view-btn')!;

const views = new SheetViews({
  sheet,
  chipsHost: sheet.peek.querySelector<HTMLDivElement>('#chips')!,
  // Lit while its panel is open, as a chip is.
  iconButtons: { compass: compassViewButton },
  onViewChange: (view) => {
    // The sensor runs only while there is a dial to turn.
    if (view !== 'compass') compassView.close();
    if (view === 'print') printer?.show();
    else printer?.hide();
    // Maps borrows the main search box for regions (see openRegionsView); any other view
    // gives it back.
    if (view !== 'regions') searchBox.takeBack();
  },
});

// Five, all of which fit a phone's row. There were seven controls — five chips and two
// icon buttons — and on an iPhone the row scrolled: Layers cut off at the edge, Print out
// of sight, with nothing to say they were there. The legend is in Layers now (the same
// symbols, beside the switches that show them), and Print and Settings, used now and then,
// are under More.
views.setDestinations([
  { view: 'routes', label: 'Routes', open: () => void openRoutesView() },
  // Named for what is in them. "Offline" named a state, not the regions you download;
  // "Saved" held places only, while saved routes live under Routes.
  { view: 'regions', label: 'Maps', open: () => openRegionsView() },
  { view: 'places', label: 'Places', open: () => void openPlacesView() },
  { view: 'layers', label: 'Layers', open: () => openLayersView(), includes: ['legend'] },
  { view: 'settings', label: 'More', open: () => openSettingsView(), includes: ['print'] },
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


syncDebugOverlay(sheetElement);

sheet.open('peek');

/**
 * What the sheet covers of the map, for camera moves to centre on what is left showing:
 * the bottom of a phone, the left edge of a desktop. Read at the moment of the move, after
 * whatever the move opens has set the sheet's height (sheet.visibleHeight is where the
 * sheet is going, not where it is mid-animation).
 */
function viewInset(): ViewInset {
  if (prefersDockedSheet()) {
    const box = map.getContainer().getBoundingClientRect();
    return { ...NO_INSET, left: Math.max(0, sheetElement.getBoundingClientRect().right - box.left) };
  }
  return { ...NO_INSET, bottom: sheet.visibleHeight() };
}

// --- The map ------------------------------------------------------------------------

// Where it was when ratmap was last closed (see last-view.ts).
const lastView = readLastView();

const map = new maplibregl.Map({
  container: 'map',
  center: lastView.center,
  zoom: lastView.zoom,
  bearing: lastView.bearing,
  pitch: lastView.pitch,
  // Attribution is legally required (ODbL) and must not be auto-hidden without user
  // action — so it stays expanded rather than collapsing to an "i" on narrow screens.
  attributionControl: { compact: false },
  style: buildBaseStyle(theme.get(), registry),
});

rememberView(map);

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

// Opened straight from the tap, with nothing awaited first: iOS only offers the compass
// from inside a user gesture (heading.ts).
compassViewButton.addEventListener('click', () =>
  views.toggle('compass', () => views.open('compass', (body) => compassView.open(body))),
);

// The fix as a grid reference and lat/long, while there is one. Added after the scale bar:
// MapLibre stacks bottom controls upwards, so it sits just above it.
const positionReadout = new PositionReadout({
  onSelect: ([lng, lat]) => showCoordsSheet(new maplibregl.LngLat(lng, lat)),
});
map.addControl(positionReadout, 'bottom-left');

// Debug handle. Lets the e2e suite assert on real style state (which layers and sources
// actually exist) rather than inferring it from screenshots, and is genuinely useful from
// a devtools console. Read-only by convention — nothing in the app reads it back.
(window as unknown as { __ratmapMap: maplibregl.Map }).__ratmapMap = map;

watchMapHealth(map, status);
// Before any tile places a car park, and for every style the theme swaps in after it.
supplyParkingIcons(map);

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
map.once('styledata', () => {
  installAppLayers();
  // Not before: opening a route adds to the style, which throws until it will accept
  // sources, and that would lose the link to a message about map styles. The route that
  // was on screen comes back first, so a link opened over it offers it back (load()).
  void restoreDraft().finally(() => {
    openRouteFromLocation();
    window.addEventListener('hashchange', openRouteFromLocation);
  });
});

const coverage = new RegionCoverage({
  map,
  registry,
  theme: () => theme.get(),
  notice: document.querySelector<HTMLButtonElement>('#detail-notice')!,
  onOpenRegions: () => openRegionsView(),
  onRestoreProblem: (message) =>
    status.setCondition('regions-restore', message ? { message, kind: 'error' } : null),
  // Startup included: a route can be open before the regions on disk have been read back,
  // and it was measured against none of them.
  onDownloadedChange: () => planner.invalidateRegions(),
  // The planner's missing-map warning is read from the catalogue, which can arrive after a
  // route restored at startup has drawn its panel.
  onCatalogueChange: () => {
    if (views.view() === 'plan') openPlanView();
  },
});

// --- Printing ------------------------------------------------------------------------

printer = new PrintController({
  map,
  registry,
  visibleArea: () => {
    // In map-container px: the map minus the sheet, inset so the frame clears the edges.
    const box = map.getContainer().getBoundingClientRect();
    const inset = 16;
    const left = prefersDockedSheet()
      ? Math.max(0, sheetElement.getBoundingClientRect().right - box.left)
      : 0;
    return {
      left: left + inset,
      top: inset,
      right: box.width - inset,
      bottom: box.height - sheet.visibleHeight() - inset,
    };
  },
  downloadedRegions: () => coverage.downloadedRegions(),
  regionOffer: (points) => coverage.regionOfferFor(points),
  route: async () => {
    const source = map.getSource<maplibregl.GeoJSONSource>(ROUTE_SOURCE_ID);
    return source ? await source.getData() : null;
  },
  onStatus: (message, kind) => status.toast(message, { kind }),
});

// --- Route planning (Phase 4) --------------------------------------------------------

/**
 * True while a route is being planned or followed — i.e. while an unannounced reload
 * would throw away work, or drop someone mid-navigation on a hill. Read by the update
 * controller below; declared ahead of the planner because `onChange` can fire during
 * construction.
 */
let routeInProgress = false;

/** Whether a route was being followed at the last change — to start the GPS with it. */
let wasFollowing = false;

/**
 * Keeps a copy of the route on screen, so a reload brings it back (see draft-store.ts).
 * Lazy about the planner, which is made below.
 */
const draftKeeper = new DraftKeeper(
  () => planner.snapshot(),
  (err) =>
    status.toast(`Couldn’t keep a copy of this route: ${err.message}. Save it to be sure of it.`, {
      kind: 'warn',
    }),
);

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
  onDraftChange: () => draftKeeper.changed(),
  viewInset,
  requestPosition: () => locationUi.watch(),
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
    const starting = !routeInProgress;
    routeInProgress = summary.active || summary.following;

    // Following is nothing without a position, and only the locate button asked for one:
    // Follow sat on "Waiting for a position fix…" until someone found it. Synchronous with
    // the tap on Follow (or Resume), which iOS needs before it will offer the compass.
    if (summary.following && !wasFollowing) locationUi.start();
    wasFollowing = summary.following;
    if (summary.following || summary.waypointCount === 0) status.setCondition('resume-follow', null);

    views.setPlan(
      routeInProgress
        ? { mode: summary.following ? 'Following' : 'Planning', open: openPlanView }
        : null,
    );

    if (!routeInProgress) {
      if (views.view() === 'plan') views.close();
    } else if (starting || views.view() === 'plan') {
      // Redrawn where it is, but only brought back over another view when a route starts.
      // This fires on every GPS fix, and re-opening the panel each time meant a summit
      // card, Layers, anything opened while planning or following was replaced within a
      // second. The mode chip is the way back to the panel now.
      //
      // views.open only moves the sheet when the view *changes*, so the re-render fired by
      // every waypoint drag redraws the panel without hauling the sheet back over a map
      // the user has just dragged it off.
      views.open('plan', (body) => renderRoutePanel(summary, routesUi(body)));
    }
  },
  onStatus: (message, kind) => status.toast(message, { kind }),
});

/** Show the route panel — from the routes list, the mode chip, or a tap that edits the route. */
function openPlanView(): void {
  views.open('plan', (body) => renderRoutePanel(planner.summary(), routesUi(body)));
}

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
    onPlanStarted: openPlanView,
    onShowRoutes: () => void openRoutesView(),
    onStatus: (message, kind) => status.toast(message, { kind }),
    onUndoableStatus: (message, action) => status.toast(message, { action }),
    regionOffer: (points) => coverage.regionOfferFor(points),
    onGetRegion: (name) => openRegionsView(name),
    viewCentre: () => {
      const { lng, lat } = map.getCenter();
      return [lng, lat];
    },
  };
}

/**
 * Put back the route that was on screen when the page last went away — an iOS eviction,
 * an update's reload, a crash. One being followed comes back planned, with a banner to
 * resume: restarting the GPS unasked, on a page someone may have opened for another
 * reason, would be its own surprise.
 */
async function restoreDraft(): Promise<void> {
  let saved;
  try {
    saved = await readDraft();
  } catch (err) {
    console.error('Could not read back the route that was on screen', err);
    return;
  }
  // A route opened some other way while this was being read is the newer intent.
  if (!saved || planner.getDraft().waypointCount > 0) return;
  planner.restore(saved);
  if (saved.following) {
    status.setCondition('resume-follow', {
      message: `You were following “${planner.getName()}”.`,
      kind: 'ok',
      action: { label: 'Resume', onSelect: () => planner.startFollowing() },
    });
  }
}

/**
 * Open a route link, if the address holds one (plans/route-sharing.md §4.3).
 *
 * At startup, and again on `hashchange`: a link tapped on Android with the app already open
 * is a same-document navigation, which reloads nothing.
 *
 * It need not wait for the regions on disk. A full link carries its legs, so nothing here
 * routes, and the profile re-measures itself when the restore lands (onDownloadedChange).
 *
 * The fragment is cleared once read, so a reload does not open the route again over
 * whatever has happened since. A link from a later ratmap keeps it: the update that can
 * read it reloads the page, and the link should still be there when it does.
 */
function openRouteFromLocation(): void {
  const payload = payloadFromHash(location.hash);
  if (payload === null) return;

  try {
    openRouteLink(payload, routesUi());
  } catch (err) {
    status.toast((err as Error).message, { kind: 'error' });
    if (err instanceof LinkTooNew) return;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
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
  // on a summit, which becomes a named waypoint rather than a detail sheet. It brings the
  // panel back if another view is up, so the edit is seen.
  if (planner.handleMapClick(e)) {
    if (views.view() !== 'plan') openPlanView();
    return;
  }

  const hit = peakAt(map, e.point);
  if (hit) {
    // The summit's own position, falling back to the tap only if the feature somehow
    // carried no geometry — otherwise the sheet reports, and "Save place" stores, the
    // spot the finger landed on rather than the summit.
    const lngLat = hit.lngLat ? new maplibregl.LngLat(...hit.lngLat) : e.lngLat;
    openPeakCard(hit.properties, lngLat);
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

function openPeakCard(properties: PeakProperties, lngLat: maplibregl.LngLat): void {
  const avalanche = avalancheReading(lngLat);
  const route = cardRoute({
    lng: lngLat.lng,
    lat: lngLat.lat,
    ...(properties.name ? { name: properties.name } : {}),
    ...(typeof properties.ele === 'number' ? { ele: properties.ele } : {}),
  });
  const hint = coordsGestureUsed() ? null : coordsHint(isCoarsePointer());
  views.open('peak', (body) =>
    renderPeakSheet(body, properties, lngLat, {
      status,
      route,
      hint,
      ...(avalanche ? { avalanche } : {}),
    }),
  );
}

/**
 * A card's route buttons, for the planner as it is now: with a route open, "Add to route";
 * otherwise "Route here" (from your location, or a start you tap) and "Route from here".
 */
function cardRoute(point: RoutePoint): CardRoute {
  if (planner.isEditing() && planner.getDraft().waypointCount > 0) {
    return {
      adding: true,
      to: () => {
        planner.appendWaypoint(point);
        openPlanView();
      },
    };
  }
  return {
    adding: false,
    to: () => {
      beginRoute();
      planner.appendWaypoint(point);
      planner.startFromMyLocation();
    },
    from: () => {
      beginRoute();
      planner.appendWaypoint(point);
    },
  };
}

/**
 * A fresh route, from a card — as "New route" begins one: whatever was open closes first,
 * and an unsaved one goes with an Undo rather than without a word.
 */
function beginRoute(): void {
  const unsaved = planner.hasUnsavedChanges();
  const name = planner.getName();
  const putBack = planner.close();
  planner.activate();
  openPlanView();
  if (unsaved && putBack) {
    status.toast(`Closed “${name}”`, {
      action: {
        label: 'Undo',
        onSelect: () => {
          if (!putBack()) status.toast('Can’t undo: another route is open now.', { kind: 'warn' });
        },
      },
    });
  }
}

/** Bumped per search pick, so a card filled in late is only filled for the pick it was for. */
let searchPick = 0;

/**
 * What a search pick opens over the map, before the map moves to it (SearchBox.onResult).
 *
 * A summit opens its card, as a tap on it does — the pick used to move the map and open
 * nothing, so the summit landed unmarked, under a sheet still showing whatever view was up.
 * Anything else puts the sheet away to show it. Print stays: there, a search is choosing
 * where the frame goes.
 */
function onSearchResult(result: SearchResult): void {
  const pick = ++searchPick;
  if (views.view() === 'print') return;
  if (result.kind !== 'peak' && result.kind !== 'volcano') {
    views.close();
    return;
  }

  const lngLat = new maplibregl.LngLat(result.lon, result.lat);
  // The search index has the name and height; the summit as the map draws it has the rest
  // (Wikidata, list membership). Opened with what there is, then filled in once the map
  // has arrived and drawn it.
  openPeakCard({ name: result.name, ...(result.ele !== null ? { ele: result.ele } : {}) }, lngLat);
  map.once('idle', () => {
    if (pick !== searchPick || views.view() !== 'peak') return;
    const hit = peakAt(map, map.project(lngLat));
    if (!hit || hit.properties.name !== result.name) return;
    openPeakCard(hit.properties, hit.lngLat ? new maplibregl.LngLat(...hit.lngLat) : lngLat);
  });
}

function showCoordsSheet(tapped: maplibregl.LngLat, { focus = false } = {}): void {
  // A tap on a repeated world copy reports a longitude past ±180, which the sheet would
  // otherwise show, copy, save and hand to other apps as it stands.
  const lngLat = tapped.wrap();
  const elevation = planner.elevationAt([lngLat.lng, lngLat.lat]);
  const avalanche = avalancheReading(lngLat);
  const route = cardRoute({ lng: lngLat.lng, lat: lngLat.lat });
  views.open(
    'coords',
    (body) =>
      renderCoordsSheet(body, lngLat, {
        status,
        elevation,
        route,
        ...(avalanche ? { avalanche } : {}),
      }),
    { focus },
  );
}

/**
 * Slope at a tapped point — only while the avalanche terrain layer is on. That toggle is
 * the opt-in to the feature; a summer tap on a summit should not lead with avalanches.
 */
function avalancheReading(lngLat: maplibregl.LngLat) {
  return isLayerVisible('avalanche') ? planner.avalancheAt([lngLat.lng, lngLat.lat]) : null;
}

// Coordinates for a bare point are a secondary action, not the primary tap — a plain click
// on empty map already means "dismiss the sheet" (see above), so reusing it here would make
// dismissal impossible. Right-click is the desktop convention; long-press is its touch
// equivalent (contextmenu is dead on iOS since Safari 13 — see press-hold.ts), so both are
// wired the same way route-planner.ts wires waypoint removal.
map.on('contextmenu', (e) => {
  e.preventDefault();
  if (planner.isEditing()) return;
  markCoordsGestureUsed();
  showCoordsSheet(e.lngLat);
});

onPressHold(map.getCanvasContainer(), {
  onHold: (point) => {
    if (planner.isEditing()) return;
    // Found it: the summit card's tip about it can go.
    markCoordsGestureUsed();
    const rect = map.getCanvasContainer().getBoundingClientRect();
    showCoordsSheet(map.unproject([point.x - rect.left, point.y - rect.top]));
  },
});

map.on('mousemove', (e) => {
  // Editing a route owns the cursor (crosshair); don't fight it over summits.
  if (planner.isEditing()) return;

  const hit = peakAt(map, e.point);
  map.getCanvas().style.cursor = hit || sacPathAt(map, e.point) ? 'pointer' : '';

  if (isCoarsePointer()) return; // no hover on touch — see PeakTooltip
  if (hit) peakTooltip.show(hit.properties, e.point);
  else peakTooltip.hide();
});

map.on('mouseout', () => peakTooltip.hide());

// --- Sheet destinations --------------------------------------------------------------

function openSettingsView(): void {
  views.open('settings', (body) =>
    renderSettingsView(body, { theme, sheetElement, onPrint: () => openPrintView() }),
  );
}

/**
 * The layer switches, then the key to everything else on the map. One view: the legend
 * had its own button, and showed the same symbols the switches sit beside.
 */
function openLayersView(): void {
  views.open('layers', (body) => {
    const ink = mapInk(theme.get());
    renderLayersView(body, { map, ink });
    const key = document.createElement('section');
    key.className = 'layers-key';
    key.setAttribute('aria-label', 'Map key');
    const heading = document.createElement('h2');
    heading.textContent = 'Key';
    const legend = document.createElement('div');
    const { lat, lng } = map.getCenter();
    renderLegend(legend, ink, { lat, lng });
    key.append(heading, legend);
    body.append(key);
  });
}

function openRegionsView(initialQuery?: string): void {
  // One search box, which searches regions while Maps is open: a second box stacked under
  // it read as the same thing twice, and hiding the main one moved the peek row every time.
  const searchInput = searchBox.lend('Search regions');
  if (initialQuery !== undefined) searchInput.value = initialQuery;
  views.open('regions', (body) => {
    void renderRegionsSheet({
      map,
      registry,
      theme: () => theme.get(),
      container: body,
      searchInput,
      onStatus: (message, kind) => status.toast(message, { kind }),
      offlineState: () => appUpdates?.offlineState() ?? 'unsupported',
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

function openPrintView(): void {
  views.open('print', (body) => printer!.render(body));
}

async function openRoutesView(): Promise<void> {
  views.open('routes', () => {});
  await renderRoutesSheet(routesUi());
}

async function openPlacesView(): Promise<void> {
  views.open('places', () => {});
  await renderPlacesSheet(sheet.body, { map, status, onGoTo: () => sheet.collapse(), viewInset });
}

// --- Search (C9: local FTS5, no geocoding API) --------------------------------------

const searchBox = new SearchBox({
  container: document.querySelector<HTMLElement>('#search')!,
  input: document.querySelector<HTMLInputElement>('#search-input')!,
  results: document.querySelector<HTMLUListElement>('#search-results')!,
  map,
  status,
  // Focus follows into the sheet: it is what was just asked for, and the search box it
  // came from has nothing more to offer.
  onCoordinates: (coords) =>
    showCoordsSheet(new maplibregl.LngLat(coords.lng, coords.lat), { focus: true }),
  // Every downloaded region's own index, beside the global fallback — see search.ts.
  regionIndexes: () => regionSearchIndexes(coverage.downloadedRegions()),
  onResult: onSearchResult,
  viewInset,
});

// --- Location ----------------------------------------------------------------------

const locationUi = setUpLocation({
  map,
  viewInset,
  button: document.querySelector<HTMLButtonElement>('#locate-btn')!,
  status,
  onPosition: (lngLat) => planner.updatePosition(lngLat),
  onPositionUnavailable: () => planner.positionUnavailable(),
  onDotClick: ([lng, lat]) => showCoordsSheet(new maplibregl.LngLat(lng, lat)),
  onStateChange: (state) => positionReadout.update(state),
});

// --- Storage + install onboarding (C1, C2) ------------------------------------------

startStorageOnboarding({
  status,
  // Opened from a banner at the top of the screen: move focus to the steps, or a
  // keyboard or screen-reader user is left on a button that has already done its job.
  showInstallSteps: () => views.open('install', renderInstallSheet, { focus: true }),
});

// --- App updates --------------------------------------------------------------------

// Debug handle, same convention as __ratmapMap above: "which build is this?" is the first
// question worth asking whenever the app behaves like an older one, and until now nothing
// could answer it.
(window as unknown as { __ratmapVersion: string }).__ratmapVersion = APP_VERSION;

// Dev builds have no generated worker, so registering one would only 404. Everything
// under test here — precaching, the update swap — exists solely in a real build, which is
// also what `vite preview` and the e2e suite run.
/**
 * The update controller, where there is one: production builds only. Read by the regions
 * sheet, which will not start a download for a phone where the app itself cannot open
 * offline (see RegionsUiDeps.offlineState).
 */
let appUpdates: AppUpdates | null = null;

if (import.meta.env.PROD) {
  appUpdates = startAppUpdates({
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
    // One condition for the whole of it, so a registration failure and the install
    // failure that follows it do not flash two banners. The error itself is logged.
    onOfflineStateChange: (state) =>
      status.setCondition(
        'offline-shell',
        state === 'installing'
          ? {
              message: 'Preparing ratmap for offline use…',
              kind: 'ok',
            }
          : state === 'failed'
            ? {
                message: 'Couldn’t prepare ratmap for offline use. It still works online.',
                kind: 'warn',
              }
            : null,
      ),
  });
}
