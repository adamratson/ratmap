import { formatDistance, type LngLat } from './geo';
import { formatElevationChange } from './profile';
import { renderProfileChart } from './profile-chart';
import { parseRouteFile, toGeoJson, toGpx } from './gpx';
import { deleteRoute, listRoutes, saveRoute, type SavedRoute } from './route-store';
import type { RoutePlanner, RouteSummary } from './route-planner';

// The route planner's interface: a panel that lives over the map while planning or
// following, and a sheet listing saved routes.
//
// Text goes in through textContent, never interpolation — route names are user input and
// waypoint names come from OSM, which is user-editable data. Same rule as the peak sheet
// and the search results in main.ts.

export interface RoutesUiDeps {
  planner: RoutePlanner;
  /** The panel over the map. */
  panel: HTMLElement;
  /** The shared bottom sheet. */
  sheet: HTMLElement;
  onStatus(message: string, kind: 'ok' | 'warn' | 'error'): void;
}

// --- Planning panel -------------------------------------------------------------------

export function renderRoutePanel(summary: RouteSummary, deps: RoutesUiDeps): void {
  const { panel, planner, onStatus } = deps;

  if (!summary.active && !summary.following) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;
  panel.innerHTML = '';

  panel.append(
    summary.following
      ? followSection(summary, planner)
      : planSection(summary, planner, deps, onStatus),
  );
}

function planSection(
  summary: RouteSummary,
  planner: RoutePlanner,
  deps: RoutesUiDeps,
  onStatus: RoutesUiDeps['onStatus'],
): HTMLElement {
  const section = el('div', 'route-panel-body');

  const header = el('div', 'route-panel-header');
  header.append(el('h3', 'route-panel-title', 'Plan a route'));

  const modes = el('div', 'route-costing');
  for (const [costing, label] of [
    ['walking', 'Walk'],
    ['cycling', 'Bike'],
  ] as const) {
    const button = buttonEl(label, () => planner.setCosting(costing));
    button.classList.toggle('active', summary.costing === costing);
    modes.append(button);
  }
  header.append(modes);
  section.append(header);

  if (summary.waypointCount === 0) {
    section.append(
      el(
        'p',
        'route-hint',
        'Tap the map to drop waypoints. Tap the line to add one in between, drag a marker to move it, long-press one to remove it.',
      ),
    );
  }

  section.append(statsRow(summary));

  if (summary.pendingLegs > 0) {
    section.append(el('p', 'route-note', 'Working out the route…'));
  }

  if (summary.profile) {
    const chart = renderProfileChart(summary.profile);
    if (chart) section.append(chart);
  }

  if (summary.profileNote) {
    section.append(el('p', 'route-note warn', summary.profileNote));
  }

  if (summary.hasStraightLegs) {
    // C11 in the UI: an unsnapped leg is allowed, but it is a straight line across
    // country and must never be presented as a path.
    section.append(
      el(
        'p',
        'route-note warn',
        'Dashed sections are straight lines, not paths — no route was found between those points in the downloaded map.',
      ),
    );
  }

  const actions = el('div', 'route-actions');

  const undo = buttonEl('Undo', () => planner.undo());
  undo.disabled = !summary.canUndo;
  actions.append(undo);

  const save = buttonEl('Save', () => openSaveForm(section, planner, deps, onStatus));
  save.disabled = summary.waypointCount < 2 || summary.pendingLegs > 0;
  actions.append(save);

  const follow = buttonEl('Follow', () => planner.startFollowing());
  follow.disabled = summary.waypointCount < 2 || summary.pendingLegs > 0;
  actions.append(follow);

  actions.append(buttonEl('Clear', () => planner.clear()));
  actions.append(buttonEl('Done', () => planner.deactivate()));

  section.append(actions);
  return section;
}

function statsRow(summary: RouteSummary): HTMLElement {
  const stats = el('dl', 'route-stats');

  // Each label/value pair is wrapped in its own element (valid inside a <dl>) so the two
  // stay together when the row wraps. Left as bare dt/dd siblings in a grid they flow
  // independently, and a narrow panel ends up showing "Descent" on one line with its
  // figure orphaned on the next.
  stats.append(stat('Distance', formatDistance(summary.distanceM)));

  if (summary.profile) {
    stats.append(
      stat('Ascent', formatElevationChange(summary.profile.ascentM)),
      stat('Descent', formatElevationChange(summary.profile.descentM)),
    );
  }

  return stats;
}

function stat(label: string, value: string): HTMLDivElement {
  const group = el('div', 'route-stat');
  group.append(el('dt', '', label), el('dd', '', value));
  return group;
}

function followSection(summary: RouteSummary, planner: RoutePlanner): HTMLElement {
  const section = el('div', 'route-panel-body');
  section.append(el('h3', 'route-panel-title', 'Following'));

  const follow = summary.follow;
  if (!follow) {
    section.append(el('p', 'route-hint', 'Waiting for a position fix…'));
  } else {
    const stats = el('dl', 'route-stats');
    stats.append(
      stat('Remaining', formatDistance(follow.remainingM)),
      stat('Done', `${Math.round(follow.fraction * 100)}%`),
    );
    section.append(stats);

    const bar = el('div', 'route-progress');
    const fill = el('div', 'route-progress-fill');
    fill.style.width = `${Math.round(follow.fraction * 100)}%`;
    bar.append(fill);
    section.append(bar);

    section.append(
      el(
        'p',
        follow.isOffRoute ? 'route-note warn' : 'route-note',
        follow.isOffRoute
          ? `Off route by ${formatDistance(follow.offRouteM)} — the dashed red line points back.`
          : `On route, ${formatDistance(follow.offRouteM)} from the line.`,
      ),
    );
  }

  // §7, stated in the product rather than only in the plan.
  section.append(
    el(
      'p',
      'route-note',
      'Following works only while the app is open and the screen is on — no browser on any platform can track you in the background.',
    ),
  );

  const actions = el('div', 'route-actions');
  actions.append(buttonEl('Stop following', () => planner.stopFollowing()));
  section.append(actions);

  return section;
}

function openSaveForm(
  section: HTMLElement,
  planner: RoutePlanner,
  deps: RoutesUiDeps,
  onStatus: RoutesUiDeps['onStatus'],
): void {
  if (section.querySelector('.route-save-form')) return;

  const form = document.createElement('form');
  form.className = 'route-save-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = planner.getName();
  input.setAttribute('aria-label', 'Route name');
  form.append(input);

  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.textContent = 'Save';
  form.append(confirm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void persist(planner, input.value.trim() || planner.getName(), deps).then(
      (route) => onStatus(`Saved “${route.name}”`, 'ok'),
      (err: Error) => onStatus(`Could not save: ${err.message}`, 'error'),
    );
    form.remove();
  });

  section.append(form);
  input.focus();
  input.select();
}

async function persist(
  planner: RoutePlanner,
  name: string,
  deps: RoutesUiDeps,
): Promise<SavedRoute> {
  const draft = planner.getDraft();
  const profile = planner.getProfile();

  const saved = await saveRoute({
    ...(planner.getLoadedRouteId() ? { id: planner.getLoadedRouteId()! } : {}),
    name,
    costing: draft.costing,
    // C10: the complete coordinate array, not a reference to anything that would have to
    // be recomputed to render it.
    coords: draft.coordinates(),
    distanceM: draft.totalDistanceM,
    ascentM: profile ? profile.ascentM : null,
    descentM: profile ? profile.descentM : null,
    hasStraightLegs: draft.hasStraightLegs(),
    waypoints: draft.getWaypoints(),
    legs: draft.getLegs(),
  });

  // Reopen the saved record so the planner is now editing it rather than a copy of it —
  // otherwise the next Save writes a second route with the same name.
  planner.load({
    id: saved.id,
    name: saved.name,
    coords: saved.coords,
    waypoints: saved.waypoints,
    legs: saved.legs,
    costing: saved.costing,
  });
  void deps;
  return saved;
}

// --- Saved routes sheet ---------------------------------------------------------------

export async function renderRoutesSheet(deps: RoutesUiDeps): Promise<void> {
  const { sheet, planner, onStatus } = deps;

  sheet.innerHTML = `
    <button class="sheet-close" type="button" aria-label="Close">×</button>
    <h2>Routes</h2>
    <div class="routes-toolbar"></div>
    <ul class="routes-list"></ul>
  `;
  sheet.querySelector('.sheet-close')!.addEventListener('click', () => {
    sheet.hidden = true;
  });
  sheet.hidden = false;

  const toolbar = sheet.querySelector<HTMLDivElement>('.routes-toolbar')!;
  toolbar.append(
    buttonEl('New route', () => {
      planner.clear();
      planner.activate();
      sheet.hidden = true;
    }),
  );
  toolbar.append(importControl(deps));

  const list = sheet.querySelector<HTMLUListElement>('.routes-list')!;

  let routes: SavedRoute[];
  try {
    routes = await listRoutes();
  } catch (err) {
    onStatus(`Could not read saved routes: ${(err as Error).message}`, 'error');
    return;
  }

  if (routes.length === 0) {
    list.append(el('li', 'places-empty', 'No saved routes yet — tap “New route” to plan one.'));
    return;
  }

  for (const route of routes) list.append(routeRow(route, deps));
}

function routeRow(route: SavedRoute, deps: RoutesUiDeps): HTMLLIElement {
  const { planner, sheet, onStatus } = deps;
  const item = document.createElement('li');
  item.className = 'route-row';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'route-open';

  open.append(el('span', 'route-name', route.name));

  const parts = [formatDistance(route.distanceM)];
  if (route.ascentM !== null) parts.push(`↑ ${formatElevationChange(route.ascentM)}`);
  if (route.hasStraightLegs) parts.push('has straight sections');
  open.append(el('span', 'route-meta', parts.join(' · ')));

  open.addEventListener('click', () => {
    planner.load({
      id: route.id,
      name: route.name,
      coords: route.coords,
      waypoints: route.waypoints,
      legs: route.legs,
      costing: route.costing,
    });
    planner.activate();
    sheet.hidden = true;
  });
  item.append(open);

  const actions = el('div', 'route-row-actions');
  actions.append(
    buttonEl('GPX', () => void shareOrDownload(route, 'gpx', onStatus)),
    buttonEl('GeoJSON', () => void shareOrDownload(route, 'geojson', onStatus)),
  );

  const remove = buttonEl('×', () => {
    void deleteRoute(route.id).then(
      () => void renderRoutesSheet(deps),
      (err: Error) => onStatus(`Could not delete: ${err.message}`, 'error'),
    );
  });
  remove.className = 'place-delete';
  remove.setAttribute('aria-label', `Delete ${route.name}`);
  actions.append(remove);

  item.append(actions);
  return item;
}

function importControl(deps: RoutesUiDeps): HTMLElement {
  const label = document.createElement('label');
  label.className = 'route-import';
  label.textContent = 'Import GPX';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gpx,.json,.geojson,application/gpx+xml,application/json';

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((text) => {
        const imported = parseRouteFile(text, file.name);
        deps.planner.load({
          name: imported.name,
          coords: imported.coords,
          waypoints: imported.waypoints,
        });
        deps.planner.activate();
        deps.sheet.hidden = true;
        deps.onStatus(`Opened “${imported.name}”`, 'ok');
      })
      .catch((err: Error) => deps.onStatus(`Could not import: ${err.message}`, 'error'))
      .finally(() => {
        // Cleared so re-picking the same file fires `change` again.
        input.value = '';
      });
  });

  label.append(input);
  return label;
}

/**
 * Hand the route to the OS share sheet where that exists, otherwise download it.
 *
 * Share first because on iOS a downloaded file is awkward to get at from an installed
 * Home Screen app, while the share sheet puts it straight into Files, Mail or another
 * walking app. `canShare` is checked with the actual file — Safari reports support for
 * sharing but not necessarily for sharing *files*.
 */
async function shareOrDownload(
  route: SavedRoute,
  format: 'gpx' | 'geojson',
  onStatus: RoutesUiDeps['onStatus'],
): Promise<void> {
  const exportable = {
    name: route.name,
    coords: route.coords as LngLat[],
    waypoints: route.waypoints,
    createdAt: route.createdAt,
  };

  const [text, mime, extension] =
    format === 'gpx'
      ? [toGpx(exportable), 'application/gpx+xml', 'gpx']
      : [JSON.stringify(toGeoJson(exportable), null, 2), 'application/geo+json', 'geojson'];

  const filename = `${slug(route.name)}.${extension}`;
  const file = new File([text], filename, { type: mime });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: route.name });
      return;
    } catch (err) {
      // A user-cancelled share is not a failure worth reporting.
      if ((err as Error)?.name === 'AbortError') return;
      // Anything else: fall through to a download rather than leaving them with nothing.
    }
  }

  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  onStatus(`Exported ${filename}`, 'ok');
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'route'
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function buttonEl(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
