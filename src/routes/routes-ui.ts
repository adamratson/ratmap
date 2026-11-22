import { formatDistance, pathLengthMetres, type LngLat } from './geo';
import { formatWalkingTime, naismithSeconds } from './naismith';
import { formatElevationChange } from './profile';
import { renderProfileChart } from './profile-chart';
import { parseRouteFile, toGeoJson, toGpx, type ImportedRoute } from './gpx';
import {
  decodeRouteLink,
  encodeRouteLink,
  LinkTooLong,
  payloadFromText,
  routeLinkUrl,
  type LinkRoute,
} from './share-link';
import { deleteRoute, listRoutes, saveRoute, type SavedRoute } from './route-store';
import type { RoutePlanner, RouteSummary } from './route-planner';
import { SAC_GRADES, sacCssColor, sacGradeInfo } from '../overlays/sac';
import { AVALANCHE_TERRAIN_ONLY, slopeCssColor } from '../overlays/avalanche';
import { avalancheClassBreakdown } from './avalanche-sampler';
import { isLayerVisible } from '../map/layers';
import { isStandalone } from '../app/storage';
import { shareOrDownload } from '../app/share-file';
import { formatBytes } from '../regions/manifest';
import type { RouteRegionOffer } from '../regions/coverage';
import { fillReadout } from '../ui/readout';

// The route planner's interface: a panel that lives over the map while planning or
// following, and a sheet listing saved routes.
//
// Text goes in through textContent, never interpolation — route names are user input and
// waypoint names come from OSM, which is user-editable data. Same rule as the peak sheet
// and the search results (overlays/feature-sheets.ts, search/search-view.ts).

export interface RoutesUiDeps {
  planner: RoutePlanner;
  /**
   * Where both the planner and the saved-routes list draw: the one sheet's body. Which
   * of them is showing is the caller's decision, not this module's.
   */
  container: HTMLElement;
  /** Switch the sheet to the planner — opening a saved route, or starting a new one. */
  onPlanStarted(): void;
  /**
   * Show the saved routes, leaving the route on screen as it is. While a route is open the
   * Routes chip is the mode chip and leads back to the planner, so this is the way to the
   * list from there.
   */
  onShowRoutes?(): void;
  onStatus(message: string, kind: 'ok' | 'warn' | 'error'): void;
  /**
   * Report something the user can take back. Distinct from {@link onStatus} because an
   * undo has to outlive an ordinary confirmation and needs somewhere to put its button.
   */
  onUndoableStatus?(message: string, action: { label: string; onSelect(): void }): void;
  /** What to download for a route with no map under it, if anything. */
  regionOffer?(points: readonly [number, number][]): RouteRegionOffer | null;
  /** Open the offline regions sheet, searched for one region. */
  onGetRegion?(name: string): void;
  /** The middle of the map showing, [lng, lat] — where an empty route is about to go. */
  viewCentre?(): [number, number];
}

// --- Planning panel -------------------------------------------------------------------

export function renderRoutePanel(summary: RouteSummary, deps: RoutesUiDeps): void {
  const { container, planner, onStatus } = deps;

  // Redrawn on every GPS fix while a route is open, not only on edits — so whatever the
  // user is in the middle of has to survive it: a name half-typed into the save form, and
  // which control has keyboard focus. Both were thrown away within a second, so a route
  // could not be saved with the location dot on.
  const carried = carryOver(container);

  container.innerHTML = '';
  container.append(
    summary.following
      ? followSection(summary, planner)
      : planSection(summary, planner, deps, onStatus, carried.save),
  );

  if (carried.focusKey) {
    const target = container.querySelector<HTMLElement>(`[data-focus-key="${carried.focusKey}"]`);
    target?.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement && target.type === 'text' && carried.save) {
      target.setSelectionRange(carried.save.selectionStart, carried.save.selectionEnd);
    }
  }
}

/** What the save form held when the panel was last drawn. */
interface SaveFormState {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/** Read off the panel about to be replaced — see renderRoutePanel. */
function carryOver(container: HTMLElement): { save: SaveFormState | null; focusKey: string | null } {
  const input = container.querySelector<HTMLInputElement>('.route-save-form input');
  const focused = document.activeElement;
  return {
    save: input
      ? { value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd }
      : null,
    focusKey:
      focused instanceof HTMLElement && container.contains(focused)
        ? (focused.dataset.focusKey ?? null)
        : null,
  };
}

function planSection(
  summary: RouteSummary,
  planner: RoutePlanner,
  deps: RoutesUiDeps,
  onStatus: RoutesUiDeps['onStatus'],
  carriedSave: SaveFormState | null,
): HTMLElement {
  const section = el('div', 'route-panel-body');

  const ready = summary.waypointCount >= 2 && summary.pendingLegs === 0;
  const head = el('div', 'route-panel-head');
  if (summary.waypointCount > 0) {
    head.append(
      routeStatus(summary, ready ? () => openSaveForm(section, planner, deps, onStatus) : null),
    );
  }
  // Up here rather than in the action row: sending a route is occasional, and the row had
  // grown to six buttons over two lines on a phone.
  if (ready) {
    const share = buttonEl('Share', () => openShareDialog(currentRoute(planner), onStatus));
    share.className = 'route-link route-share';
    head.append(share);
  }
  if (deps.onShowRoutes) {
    const all = buttonEl('All routes', () => deps.onShowRoutes?.());
    all.className = 'route-link route-all';
    head.append(all);
  }
  if (head.childElementCount > 0) section.append(head);

  if (summary.waypointCount === 0 && !summary.startPrompt) {
    section.append(
      el(
        'p',
        'route-hint',
        'Tap the map to add waypoints. Tap the line to insert one, drag to move, press and hold to remove.',
      ),
    );
  }

  const prompt = startPromptBlock(summary, planner);
  if (prompt) section.append(prompt);

  // Before anything is placed, not after: with no map under it, a route is straight lines
  // and no profile, which used to be found out only once the points were down.
  const missingMap = summary.received ? null : missingMapBlock(summary, planner, deps);
  if (missingMap) section.append(missingMap);

  section.append(statsRow(summary));

  const received = receivedSection(summary, planner, deps);
  if (received) section.append(received);

  if (summary.pendingLegs > 0) {
    section.append(el('p', 'route-note', 'Working out the route…'));
  }

  if (summary.profile) {
    const chart = renderProfileChart(summary.profile, {
      currentDistanceM: summary.currentDistanceM,
    });
    if (chart) section.append(chart);
  }

  // Said already, with the way to fix it, when there is no map here at all.
  if (summary.profileNote && !missingMap) {
    section.append(el('p', 'route-note warn', summary.profileNote));
  }

  const sac = sacSection(summary);
  if (sac) section.append(sac);

  const avalanche = avalancheSection(summary);
  if (avalanche) section.append(avalanche);

  // The missing-map warning has already said why the legs are straight — unless some were
  // drawn freehand on purpose, which it does not cover.
  const straight = missingMap && !summary.hasFreehandLegs ? null : straightLegsNote(summary);
  if (straight) section.append(el('p', 'route-note warn', straight));

  section.append(editTools(summary, planner));

  // Four, on one line on a phone. There were six — Undo, Save, Share, Follow, Done, Clear —
  // over two. Share is in the line above (it is occasional); Clear is gone, since Close
  // takes the route away (Discard, with an Undo) and "New route" starts another.
  const actions = el('div', 'route-actions');

  const undo = buttonEl('Undo', () => planner.undo());
  undo.disabled = !summary.canUndo;
  actions.append(undo);

  // One tap, under the name the route already has — its saved one, or the one it would be
  // given: the last summit on it, say. Saving used to open a name field with a second Save
  // button; renaming is a tap on the name instead, for the few who want to.
  const isSaved = summary.saved && !summary.unsaved;
  const save = buttonEl(isSaved ? 'Saved' : 'Save', () => {
    void persist(planner, planner.getName(), deps).then(
      (route) => {
        if (deps.onUndoableStatus) {
          deps.onUndoableStatus(`Saved “${route.name}”`, {
            label: 'Rename',
            onSelect: () => {
              const panel = deps.container.querySelector<HTMLElement>('.route-panel-body');
              if (panel) openSaveForm(panel, planner, deps, onStatus);
            },
          });
        } else {
          onStatus(`Saved “${route.name}”`, 'ok');
        }
      },
      (err: Error) => onStatus(`Could not save: ${err.message}`, 'error'),
    );
  });
  save.dataset.focusKey = 'save';
  save.disabled = !ready || isSaved;
  actions.append(save);

  // Following is what a planned route is *for*, so it is the one action that leads.
  const follow = buttonEl('Follow', () => planner.startFollowing());
  follow.disabled = !ready;
  follow.classList.add('primary');
  actions.append(follow);

  // The way out. It has to stay: while planning, a tap on the map means "waypoint" rather
  // than "open this summit", and there must be an obvious way back. It takes the route off
  // the map with it — it used to be "Done", which only stopped editing and left the route
  // drawn, unreachable, and (unsaved) one "New route" away from being wiped unseen.
  actions.append(buttonEl('Close', () => closeRoute(summary, deps)));

  section.append(actions);

  // Carried over from the panel this one replaces. Only while the route can still be
  // saved: an edit that left a leg pending would otherwise let the form save a route with
  // a hole in it, which is why an edit has always closed the form.
  if (carriedSave && ready) openSaveForm(section, planner, deps, onStatus, carriedSave);

  return section;
}

/**
 * Which route this is and whether it is saved — the one thing that says an edit has not
 * reached the routes list yet, before Close or a reload would lose it.
 */
function routeStatus(summary: RouteSummary, onRename: (() => void) | null): HTMLElement {
  const line = el('p', 'route-status');
  if (onRename) {
    // The name is the way to rename: where you would look for it, with no button of its own.
    const name = buttonEl(summary.name, onRename);
    name.className = 'route-status-name route-rename';
    name.dataset.focusKey = 'rename';
    name.setAttribute('aria-label', `Rename “${summary.name}”`);
    line.append(name);
  } else {
    line.append(el('span', 'route-status-name', summary.name));
  }
  const state = !summary.saved ? 'Not saved' : summary.unsaved ? 'Unsaved changes' : 'Saved';
  line.append(el('span', summary.unsaved ? 'route-status-state unsaved' : 'route-status-state', state));
  return line;
}

/**
 * Leave the planner, taking the route off the map.
 *
 * Nothing to lose — a saved route as it was saved, an empty plan — and it simply closes:
 * the saved route is one tap away in Routes. A route with something unsaved asks first,
 * in a dialog rather than the panel because the panel is redrawn on every GPS fix. A lone
 * waypoint is not worth a question, and goes with an Undo.
 */
function closeRoute(summary: RouteSummary, deps: RoutesUiDeps): void {
  const { planner } = deps;
  if (!summary.unsaved) {
    planner.close();
    return;
  }
  if (summary.waypointCount < 2) {
    discard(summary, deps);
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'share-dialog close-dialog';
  dialog.setAttribute('aria-label', 'Close route');
  const done = (): void => dialog.remove();
  dialog.addEventListener('close', done);

  dialog.append(
    el('h2', '', summary.saved ? `Save changes to “${summary.name}”?` : `Save “${summary.name}”?`),
    el(
      'p',
      '',
      summary.saved
        ? 'You’ve changed this route since it was saved.'
        : 'This route isn’t saved. Closing takes it off the map.',
    ),
  );

  const actions = el('div', 'share-actions');
  const save = buttonEl('Save', () => {
    dialog.close();
    void persist(planner, planner.getName(), deps).then(
      (route) => {
        planner.close();
        deps.onStatus(`Saved “${route.name}”`, 'ok');
      },
      (err: Error) => deps.onStatus(`Could not save: ${err.message}`, 'error'),
    );
  });
  save.classList.add('primary');
  // A leg still being worked out would save with a hole in it — the same rule as the
  // panel's own Save.
  save.disabled = summary.pendingLegs > 0;

  const drop = buttonEl(summary.saved ? 'Discard changes' : 'Discard', () => {
    dialog.close();
    discard(summary, deps);
  });
  drop.classList.add('destructive');

  actions.append(save, drop, buttonEl('Keep editing', () => dialog.close()));
  dialog.append(actions);
  document.body.append(dialog);
  dialog.showModal();
}

/** Close without saving, with the way back every other destructive action here offers. */
function discard(summary: RouteSummary, deps: RoutesUiDeps): void {
  const putBack = deps.planner.close();
  if (!putBack) return;
  const what = summary.saved ? `changes to “${summary.name}”` : `“${summary.name}”`;
  if (deps.onUndoableStatus) {
    deps.onUndoableStatus(`Discarded ${what}`, {
      label: 'Undo',
      onSelect: () => {
        if (putBack()) deps.onPlanStarted();
        else deps.onStatus('Can’t undo: another route is open now.', 'warn');
      },
    });
  }
}

/**
 * What a route that arrived as a link can do before the person holding it has the map.
 *
 * A link draws, follows and exports with no region (C10), but it cannot be measured, so the
 * sender's climb stands in, labelled as theirs, until a downloaded region gives a real
 * profile. Save as GPX makes the link useful to someone who never installs ratmap.
 */
function receivedSection(
  summary: RouteSummary,
  planner: RoutePlanner,
  deps: RoutesUiDeps,
): HTMLElement | null {
  const received = summary.received;
  if (!received) return null;

  const block = el('div', 'route-received');
  block.append(el('h3', '', 'Shared route'));

  if (received.stats && !summary.profile) {
    block.append(
      el(
        'p',
        'route-note',
        `Their figures: ${formatElevationChange(received.stats.ascentM)} up, ` +
          `${formatElevationChange(received.stats.descentM)} down, measured on the sender’s map.`,
      ),
    );
  }

  const coords = planner.getDraft().coordinates();
  const middle = coords[Math.floor(coords.length / 2)];
  const offer = deps.regionOffer?.(
    [coords[0], middle, coords[coords.length - 1]].map(([lng, lat]) => [lng, lat]),
  );
  if (offer?.kind === 'spans') {
    block.append(
      el('p', 'route-note', 'This route crosses more than one region. Download them to see it in detail.'),
    );
  }

  const actions = el('div', 'route-received-actions');
  if (offer?.kind === 'region') {
    const { region } = offer;
    actions.append(
      buttonEl(`Get ${region.name} (${formatBytes(region.totalBytes)})`, () => deps.onGetRegion?.(region.name)),
    );
  }
  actions.append(
    buttonEl('Save as GPX', () => void exportRoute(currentRoute(planner), 'gpx', deps.onStatus)),
  );
  // A link tapped on an iPhone opens here in Safari, whose storage is not the installed
  // app's (plans/route-sharing.md §4.5), so the way into the app is to carry the link over.
  if (!isStandalone()) {
    actions.append(
      buttonEl('Copy link', () => void copyLink(routeLinkUrl(received.payload), deps.onStatus)),
    );
  }
  block.append(actions);

  return block;
}

/**
 * C11 in the UI: an unsnapped leg is allowed, but it is a straight line across country and
 * must never be presented as a path. A freehand one is no different on the ground, but
 * blaming it on the map would send someone looking for a fault that is not there.
 */
function straightLegsNote(summary: RouteSummary): string | null {
  if (!summary.hasStraightLegs) return null;
  if (summary.hasUnroutedLegs && summary.hasFreehandLegs) {
    return 'Dashed sections are straight lines: drawn freehand, or no route was found.';
  }
  if (summary.hasUnroutedLegs) {
    return 'Dashed sections are straight lines where no route was found.';
  }
  return 'Dashed sections are straight lines, drawn freehand.';
}

/**
 * Controls that shape the route rather than act on it: closing it into a round trip, and
 * whether new legs follow paths. A row of their own because the action row below only just
 * fits a phone's width as it is.
 */
function editTools(summary: RouteSummary, planner: RoutePlanner): HTMLElement {
  const row = el('div', 'route-tools');

  const roundTrip = buttonEl('Round trip', () => planner.closeLoop());
  roundTrip.disabled = !summary.canCloseLoop;
  roundTrip.title = 'Add a last leg back to the start';
  // Begins an empty route where you are, or puts your position in front of one already
  // drawn. Hidden while it is already being asked for.
  const fromHere = buttonEl('From my location', () => planner.startFromMyLocation());
  fromHere.title = 'Start the route where you are';
  fromHere.hidden = summary.startPrompt !== null;
  row.append(roundTrip, fromHere, snapToggle(summary, planner));
  return row;
}

/**
 * Where the start is to come from, while it is still to come: the GPS, or a tap. With a way
 * to let the route start where it already does.
 */
function startPromptBlock(summary: RouteSummary, planner: RoutePlanner): HTMLElement | null {
  const prompt = summary.startPrompt;
  if (!prompt) return null;
  const block = el('div', 'route-start-prompt');
  let text: string;
  if (prompt.kind === 'locating') {
    text = 'Finding your location to start from — or tap the map where you’ll start.';
  } else if (prompt.awayM !== undefined) {
    // Whole kilometres at this range: "120.0 km away" is false precision.
    const away = prompt.awayM >= 10_000 ? `${Math.round(prompt.awayM / 1000)} km` : formatDistance(prompt.awayM);
    text = `You’re ${away} away. Tap the map where you’ll start.`;
  } else {
    text = 'Tap the map where you’ll start.';
  }
  block.append(el('p', '', text));
  // Only when there is a waypoint for the route to start at instead.
  if (summary.waypointCount > 0) {
    const skip = buttonEl('Start where it is', () => planner.dismissStartPrompt());
    skip.className = 'route-link route-skip';
    block.append(skip);
  }
  return block;
}

/**
 * No downloaded map under the route, or under the map where an empty one is about to go:
 * say what that costs, and offer the region that fixes it.
 */
function missingMapBlock(
  summary: RouteSummary,
  planner: RoutePlanner,
  deps: RoutesUiDeps,
): HTMLElement | null {
  if (!deps.regionOffer) return null;
  const waypoints = planner.getDraft().getWaypoints();
  const points: [number, number][] =
    waypoints.length > 0
      ? waypoints.map(({ lng, lat }) => [lng, lat])
      : deps.viewCentre
        ? [deps.viewCentre()]
        : [];
  if (points.length === 0) return null;
  const offer = deps.regionOffer(points);
  if (!offer) return null;

  const block = el('div', 'route-missing-map');
  if (offer.kind === 'region') {
    block.append(
      el(
        'p',
        'route-note warn',
        `No map downloaded here, so routes are straight lines with no elevation profile. Get ${offer.region.name} to route along paths.`,
      ),
    );
    const get = buttonEl(`Get ${offer.region.name} (${formatBytes(offer.region.totalBytes)})`, () =>
      deps.onGetRegion?.(offer.region.name),
    );
    get.className = 'route-get-region';
    block.append(get);
  } else {
    block.append(
      el(
        'p',
        'route-note warn',
        summary.waypointCount > 1
          ? 'No one downloaded map covers this route, so it’s straight lines with no elevation profile where the map is missing.'
          : 'No map downloaded here, so routes are straight lines with no elevation profile.',
      ),
    );
  }
  return block;
}

/**
 * Whether new legs follow paths or go straight. A switch rather than a button because a
 * switch shows which way it is set, which a button would have to spell out in its label.
 */
function snapToggle(summary: RouteSummary, planner: RoutePlanner): HTMLElement {
  const row = el('label', 'settings-row route-snap');
  const text = el('span', 'settings-row-text');
  text.append(el('span', 'settings-row-label', 'Snap to paths'));

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = summary.snapToPath;
  input.dataset.focusKey = 'snap-to-path';
  input.addEventListener('change', () => planner.setSnapToPath(input.checked));

  row.append(text, input);
  return row;
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

    // Only with a profile: Naismith without the climb term is just distance over 5 km/h,
    // which on a hill route is badly optimistic and looks exactly like the real thing.
    const time = stat(
      'Naismith',
      formatWalkingTime(naismithSeconds(summary.distanceM, summary.profile.ascentM)),
    );
    time.title = '5 km/h plus an hour per 600 m climbed. No stops, weather or rough ground.';
    stats.append(time);
  }

  const hardest = summary.sac?.hardest != null ? sacGradeInfo(summary.sac.hardest) : null;
  if (hardest) {
    // "Hardest graded", not "Hardest": the figure describes the graded part of the route,
    // and the rest of the route may well be harder than anything the tagging covers.
    const group = stat('Hardest graded', hardest.short);
    const value = group.querySelector('dd');
    if (value) value.style.color = sacCssColor(hardest.grade);
    stats.append(group);
  }

  return stats;
}

/**
 * The SAC breakdown: how much of the route sits at each grade, and how much of it is
 * graded at all.
 *
 * The coverage line is not a footnote here, it is the point. `sac_scale` is tagged on a
 * minority of paths, so "T2" on a route means "the graded parts reach T2" and never "this
 * route is T2" — and a walker reading the second thing off the first is exactly how
 * somebody ends up on ground they did not choose.
 */
function sacSection(summary: RouteSummary): HTMLElement | null {
  if (summary.sacNote) return el('p', 'route-note warn', summary.sacNote);

  const sac = summary.sac;
  if (!sac) return null;

  const block = el('div', 'route-sac');

  if (sac.hardest === null) {
    block.append(
      el(
        'p',
        'route-note',
        'No SAC grades along this route.',
      ),
    );
    return block;
  }

  const chips = el('ul', 'sac-chips');
  for (const info of SAC_GRADES) {
    const metres = sac.metresByGrade.get(info.grade);
    if (!metres) continue;

    const chip = el('li', 'sac-chip');
    const swatch = el('span', 'sac-chip-swatch');
    swatch.style.background = sacCssColor(info.grade);
    chip.append(
      swatch,
      el('span', 'sac-chip-grade', info.short),
      el('span', 'sac-chip-distance', formatDistance(metres)),
    );
    // The grade's meaning, for anyone who does not carry T1-T6 in their head.
    chip.title = `${info.label} — ${info.note}`;
    chips.append(chip);
  }
  block.append(chips);

  block.append(el('p', 'route-note', coverageSentence(sac.coverage)));
  return block;
}

/**
 * How much of the route crosses each slope class, and the steepest slope crossed.
 *
 * Only while the avalanche terrain layer is switched on: that toggle is the opt-in to the
 * whole feature, and a summer route panel that talks about avalanches unasked is noise
 * people learn to skip. It never claims more than the layer can know — the standing line
 * says it is terrain only, and that a route on gentle ground can still be under a slope
 * that is not (A6).
 */
function avalancheSection(summary: RouteSummary): HTMLElement | null {
  if (!isLayerVisible('avalanche')) return null;
  if (summary.avalancheNote) return el('p', 'route-note warn', summary.avalancheNote);

  const avalanche = summary.avalanche;
  if (!avalanche) return null;

  const block = el('div', 'route-avalanche');
  block.append(el('h3', '', 'Avalanche terrain'));

  const percent = Math.round(avalanche.coverage * 100);
  if (avalanche.steepest === null) {
    block.append(
      el(
        'p',
        'route-note',
        percent >= 99
          ? 'Nowhere on this route reaches 25°.'
          : `Nowhere reaches 25° on the ${percent}% of the route with slope data.`,
      ),
    );
  } else {
    // Same chip row as the SAC breakdown: one wrapping row read as a set. The swatch is
    // square because the map draws slope as an area, where a SAC grade is a line.
    const chips = el('ul', 'sac-chips');
    for (const { slopeClass, index, metres } of avalancheClassBreakdown(avalanche)) {
      const chip = el('li', 'sac-chip');
      const swatch = el('span', 'sac-chip-swatch slope-chip-swatch');
      swatch.style.background = slopeCssColor(index);
      chip.append(
        swatch,
        el('span', 'sac-chip-grade', slopeClass.label),
        el('span', 'sac-chip-distance', formatDistance(metres)),
      );
      chip.title = slopeClass.note;
      chips.append(chip);
    }
    block.append(chips);

    const steepest = el('p', 'route-note');
    steepest.append('Steepest slope crossed: ');
    const figure = el('span');
    fillReadout(figure, `${avalanche.steepest}°`);
    steepest.append(figure);
    if (percent < 99) steepest.append(` (slope data covers ${percent}% of the route)`);
    steepest.append('.');
    block.append(steepest);
  }

  block.append(el('p', 'route-note', AVALANCHE_TERRAIN_ONLY));
  return block;
}

function coverageSentence(coverage: number): string {
  const percent = Math.round(coverage * 100);
  if (percent >= 99) return 'Graded along the whole route.';
  return `Graded on ${percent}% of the route; the rest is untagged.`;
}

function stat(label: string, value: string): HTMLDivElement {
  const group = el('div', 'route-stat');
  const figure = el('dd');
  fillReadout(figure, value);
  group.append(el('dt', '', label), figure);
  return group;
}

/**
 * Following is the one screen used one-handed, while moving, possibly in rain, and often
 * glanced at for a second at a time. So it is not a variant of the planning panel: bigger
 * figures, fewer of them, and dark, which is both easier to read outdoors at low
 * brightness and kinder to night vision.
 */
function followSection(summary: RouteSummary, planner: RoutePlanner): HTMLElement {
  const section = el('div', 'route-follow');

  const follow = summary.follow;
  if (!follow) {
    section.append(el('p', 'follow-waiting', 'Waiting for a position fix…'));
  } else {
    const figures = el('dl', 'follow-figures');
    figures.append(
      followFigure('Remaining', formatDistance(follow.remainingM)),
      followFigure('Done', `${Math.round(follow.fraction * 100)}%`),
    );
    section.append(figures);

    const bar = el('div', 'follow-progress');
    const fill = el('div', 'follow-progress-fill');
    fill.style.width = `${Math.round(follow.fraction * 100)}%`;
    bar.append(fill);
    section.append(bar);

    // The single most important thing on this screen, so it is the loudest: on a hill in
    // poor visibility, "am I still on the path" is the whole question.
    const state = el(
      'p',
      follow.isOffRoute ? 'follow-state off' : 'follow-state on',
      follow.isOffRoute
        ? `Off route — ${formatDistance(follow.offRouteM)} away`
        : `On route — ${formatDistance(follow.offRouteM)} from the line`,
    );
    section.append(state);

    if (summary.profile) {
      const chart = renderProfileChart(summary.profile, { currentDistanceM: follow.alongM });
      if (chart) section.append(chart);
    }

    if (follow.isOffRoute) {
      section.append(el('p', 'follow-note', 'The dashed red line points back to the route.'));
    }
  }

  // §7, stated in the product rather than only in the plan.
  section.append(
    el(
      'p',
      'follow-note',
      'Following needs the app open and the screen on. No background tracking; ratmap keeps the screen awake.',
    ),
  );

  const actions = el('div', 'route-actions');
  const stop = buttonEl('Stop following', () => planner.stopFollowing());
  stop.classList.add('primary');
  actions.append(stop);
  section.append(actions);

  return section;
}

function followFigure(label: string, value: string): HTMLDivElement {
  const group = el('div', 'follow-figure');
  const figure = el('dd');
  fillReadout(figure, value);
  group.append(el('dt', '', label), figure);
  return group;
}

/**
 * @param carried what the form held before a redraw replaced it. Focus and selection are
 *   put back by renderRoutePanel, once the section is in the document to take them.
 */
function openSaveForm(
  section: HTMLElement,
  planner: RoutePlanner,
  deps: RoutesUiDeps,
  onStatus: RoutesUiDeps['onStatus'],
  carried?: SaveFormState,
): void {
  if (section.querySelector('.route-save-form')) return;

  const form = document.createElement('form');
  form.className = 'route-save-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = carried ? carried.value : planner.getName();
  input.setAttribute('aria-label', 'Route name');
  input.dataset.focusKey = 'route-name';
  form.append(input);

  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.textContent = planner.getLoadedRouteId() ? 'Rename' : 'Save';
  form.append(confirm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void persist(planner, input.value.trim() || planner.getName(), deps).then(
      (route) => onStatus(`Saved “${route.name}”`, 'ok'),
      (err: Error) => onStatus(`Could not save: ${err.message}`, 'error'),
    );
    form.remove();
  });

  // Under the name it changes.
  const head = section.querySelector('.route-panel-head');
  if (head) head.after(form);
  else section.prepend(form);
  if (carried) return;
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
  });
  void deps;
  return saved;
}

// --- Saved routes sheet ---------------------------------------------------------------

export async function renderRoutesSheet(deps: RoutesUiDeps): Promise<void> {
  const { container, planner, onStatus } = deps;

  container.innerHTML = `
    <div class="routes-toolbar"></div>
    <ul class="routes-list"></ul>
  `;

  const toolbar = container.querySelector<HTMLDivElement>('.routes-toolbar')!;
  toolbar.append(
    buttonEl('New route', () => {
      // Whatever is open closes first. An unsaved one used to be cleared without a word —
      // usually one stranded on the map by the old Done — so it goes with an Undo now.
      const unsaved = planner.hasUnsavedChanges();
      const name = planner.getName();
      const putBack = planner.close();
      planner.activate();
      deps.onPlanStarted();
      if (unsaved) offerPlanBack(putBack, `Closed “${name}”`, deps);
    }),
  );
  toolbar.append(importControl(deps));
  toolbar.append(pasteControl(container, deps));

  const list = container.querySelector<HTMLUListElement>('.routes-list')!;

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
  const { planner, onStatus } = deps;
  const item = document.createElement('li');
  item.className = 'route-row';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'route-open';

  open.append(el('span', 'route-name', route.name));

  const parts = [formatDistance(route.distanceM)];
  if (route.ascentM !== null) {
    parts.push(`↑ ${formatElevationChange(route.ascentM)}`);
    parts.push(`~${formatWalkingTime(naismithSeconds(route.distanceM, route.ascentM))}`);
  }
  if (route.hasStraightLegs) parts.push('has straight sections');
  open.append(el('span', 'route-meta', parts.join(' · ')));

  open.addEventListener('click', () => {
    const putBack = planner.load({
      id: route.id,
      name: route.name,
      coords: route.coords,
      waypoints: route.waypoints,
      legs: route.legs,
    });
    planner.activate();
    deps.onPlanStarted();
    offerPlanBack(putBack, `Opened “${route.name}”`, deps);
  });
  item.append(open);

  const actions = el('div', 'route-row-actions');
  actions.append(buttonEl('Share', () => openShareDialog(route, onStatus)));

  const remove = buttonEl('×', () => {
    void deleteRoute(route.id).then(
      () => {
        void renderRoutesSheet(deps);
        // saveRoute takes an explicit id and createdAt, so this restores the record
        // rather than writing a duplicate of it.
        deps.onUndoableStatus?.(`Deleted “${route.name}”`, {
          label: 'Undo',
          onSelect: () =>
            void saveRoute(route).then(
              () => void renderRoutesSheet(deps),
              // An Undo that fails quietly is worse than none: the route is gone, and the
              // person who pressed it believes it is back.
              (err: Error) => onStatus(`Could not restore “${route.name}”: ${err.message}`, 'error'),
            ),
        });
      },
      (err: Error) => onStatus(`Could not delete “${route.name}”: ${err.message}`, 'error'),
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
        openImported(parseRouteFile(text, file.name), deps);
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

function openImported(imported: ImportedRoute, deps: RoutesUiDeps): void {
  const putBack = deps.planner.load({
    name: imported.name,
    coords: imported.coords,
    waypoints: imported.waypoints,
    legs: imported.legs,
  });
  deps.planner.activate();
  deps.onPlanStarted();
  const message = imported.note
    ? `Opened “${imported.name}”. ${imported.note}`
    : `Opened “${imported.name}”`;
  if (!offerPlanBack(putBack, message, deps)) deps.onStatus(message, imported.note ? 'warn' : 'ok');
}

/**
 * Open a route link in the planner. Throws what {@link decodeRouteLink} throws, with nothing
 * loaded: the callers say so in their own way.
 *
 * Saves nothing, the same as an import.
 */
export function openRouteLink(payload: string, deps: RoutesUiDeps): void {
  const route = decodeRouteLink(payload);
  const putBack = deps.planner.load({
    name: route.name,
    coords: route.coords,
    waypoints: route.waypoints,
    legs: route.legs,
    received: { payload, stats: route.stats },
  });
  deps.planner.activate();
  deps.onPlanStarted();
  const message = `Opened “${route.name}”`;
  if (!offerPlanBack(putBack, message, deps)) deps.onStatus(message, 'ok');
}

/**
 * A field for a route link, or the text of a GPX or GeoJSON file.
 *
 * The way a link gets into the installed app on iOS, where tapping one opens Safari
 * instead (plans/route-sharing.md §4.5). A text field rather than a clipboard read, because
 * it needs no permission and no prompt.
 */
function pasteControl(container: HTMLElement, deps: RoutesUiDeps): HTMLElement {
  const control = buttonEl('Paste a route', () => {
    if (container.querySelector('.route-paste-form')) return;

    const form = document.createElement('form');
    form.className = 'route-paste-form';

    const input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = 'Paste a ratmap link, or GPX or GeoJSON text';
    input.setAttribute('aria-label', 'Route link or file text');
    form.append(input);

    const open = document.createElement('button');
    open.type = 'submit';
    open.textContent = 'Open';
    form.append(open);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      try {
        const payload = payloadFromText(text);
        if (payload !== null) openRouteLink(payload, deps);
        else openImported(parseRouteFile(text, 'pasted route'), deps);
      } catch (err) {
        deps.onStatus((err as Error).message, 'error');
      }
    });

    container.querySelector('.routes-toolbar')!.after(form);
    input.focus();
  });
  control.className = 'route-paste';
  return control;
}

/**
 * Offer back the plan that opening a route replaced, the way Clear and delete offer theirs.
 *
 * False when there was nothing to offer, so the caller can still say what it did.
 */
function offerPlanBack(putBack: (() => boolean) | null, message: string, deps: RoutesUiDeps): boolean {
  if (!putBack || !deps.onUndoableStatus) return false;
  deps.onUndoableStatus(message, {
    label: 'Undo',
    onSelect: () => {
      // The planner declines once the route opened here has been edited: going back would
      // throw that edit away. Saying nothing would look like the Undo had worked.
      if (!putBack()) deps.onStatus('Can’t undo: the route has been changed since it was opened.', 'warn');
    },
  });
  return true;
}

/** What sending a route needs: a saved record, or the one on the planner right now. */
type ShareableRoute = Pick<
  SavedRoute,
  'name' | 'coords' | 'waypoints' | 'legs' | 'ascentM' | 'descentM' | 'createdAt'
>;

function currentRoute(planner: RoutePlanner): ShareableRoute {
  const draft = planner.getDraft();
  const profile = planner.getProfile();
  return {
    name: planner.getName(),
    coords: draft.coordinates(),
    waypoints: draft.getWaypoints(),
    legs: draft.getLegs(),
    ascentM: profile ? profile.ascentM : null,
    descentM: profile ? profile.descentM : null,
    createdAt: Date.now(),
  };
}

/**
 * A route in the shape a link carries.
 *
 * A record with no usable editing state, one saved before legs were stored, goes as a single
 * leg between its own ends: the geometry is authoritative (C10), and the same shape
 * `RoutePlanner.load` gives it on opening.
 */
function linkRouteFrom(route: ShareableRoute): LinkRoute {
  const stats =
    route.ascentM !== null && route.descentM !== null
      ? { ascentM: route.ascentM, descentM: route.descentM }
      : null;

  const legs = route.legs?.filter((leg) => leg !== null) ?? [];
  if (route.waypoints && route.waypoints.length >= 2 && legs.length === route.waypoints.length - 1) {
    return { name: route.name, waypoints: route.waypoints, legs, stats };
  }

  const start = route.coords[0];
  const end = route.coords[route.coords.length - 1];
  return {
    name: route.name,
    waypoints: [
      { lng: start[0], lat: start[1] },
      { lng: end[0], lat: end[1] },
    ],
    legs: [{ coords: route.coords, distanceM: pathLengthMetres(route.coords), kind: 'snapped' }],
    stats,
  };
}

/**
 * Past this a link is long enough that a messenger might cut it.
 *
 * A round figure, not a measured one: which apps truncate at what length has not been tried
 * yet (plans/route-sharing.md §2.3 spike 4). A cut link says it is damaged rather than
 * opening wrong, so this only warns the sender that the file may be the safer choice.
 */
const LONG_LINK_CHARS = 2000;

/**
 * The one way out for a route: a link or a file.
 *
 * A dialog on the page rather than a form in the panel, because the panel is redrawn on
 * every GPS fix and this has to hold still while someone reads the warning. That warning is
 * not optional: a link is the first way a route leaves the phone that cannot be recalled.
 */
function openShareDialog(route: ShareableRoute, onStatus: RoutesUiDeps['onStatus']): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'share-dialog';
  dialog.setAttribute('aria-label', `Share ${route.name}`);

  const close = (): void => dialog.remove();
  dialog.addEventListener('close', close);

  dialog.append(
    el('h2', '', route.name),
    el('p', '', 'Anyone with this link can see this route, and it can’t be taken back.'),
  );

  // Encoded here rather than on the tap, so a route too long for a link never offers one.
  // It is synchronous either way, which matters: navigator.share needs the tap's user
  // activation, and an async pause before it can cost that.
  let url: string | null = null;
  try {
    url = routeLinkUrl(encodeRouteLink(linkRouteFrom(route)));
  } catch (err) {
    if (!(err instanceof LinkTooLong)) throw err;
    dialog.append(el('p', 'share-note', `${err.message} Send it as a file instead.`));
  }

  if (url && url.length > LONG_LINK_CHARS) {
    dialog.append(
      el(
        'p',
        'share-note',
        `This link is ${url.length.toLocaleString('en-GB')} characters, and some apps may cut a ` +
          'link that long. A cut link says it’s damaged rather than opening wrong.',
      ),
    );
  }

  const actions = el('div', 'share-actions');
  if (url) {
    const link = url;
    const send = buttonEl('Send link', () => {
      void sendLink(link, route.name, onStatus).then(close);
    });
    send.classList.add('primary');
    actions.append(send);
  }
  actions.append(
    buttonEl('GPX', () => {
      void exportRoute(route, 'gpx', onStatus).then(close);
    }),
    buttonEl('GeoJSON', () => {
      void exportRoute(route, 'geojson', onStatus).then(close);
    }),
    buttonEl('Cancel', close),
  );
  dialog.append(actions);

  document.body.append(dialog);
  dialog.showModal();
}

/** Through the OS share sheet where there is one, otherwise onto the clipboard. */
async function sendLink(
  url: string,
  title: string,
  onStatus: RoutesUiDeps['onStatus'],
): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ url, title });
      return;
    } catch (err) {
      // A user-cancelled share is not a failure worth reporting.
      if ((err as Error)?.name === 'AbortError') return;
      // Anything else: the clipboard is still a way out.
    }
  }
  await copyLink(url, onStatus);
}

async function copyLink(url: string, onStatus: RoutesUiDeps['onStatus']): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    onStatus('Copied link', 'ok');
  } catch (err) {
    onStatus(`Could not copy the link: ${(err as Error).message}`, 'error');
  }
}

/** Hand the route to the OS share sheet where that exists, otherwise download it. */
async function exportRoute(
  route: ShareableRoute,
  format: 'gpx' | 'geojson',
  onStatus: RoutesUiDeps['onStatus'],
): Promise<void> {
  const exportable = {
    name: route.name,
    coords: route.coords as LngLat[],
    waypoints: route.waypoints,
    // So ratmap can open the file as the route it was planned as (gpx.ts, legSpans).
    legs: route.legs,
    createdAt: route.createdAt,
  };

  const [text, mime, extension] =
    format === 'gpx'
      ? [toGpx(exportable), 'application/gpx+xml', 'gpx']
      : [JSON.stringify(toGeoJson(exportable), null, 2), 'application/geo+json', 'geojson'];

  const filename = `${slug(route.name)}.${extension}`;
  const file = new File([text], filename, { type: mime });

  if ((await shareOrDownload(file, route.name)) === 'downloaded') {
    onStatus(`Exported ${filename}`, 'ok');
  }
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
  // Lets focus follow a button to its replacement when the panel is redrawn under it.
  button.dataset.focusKey = label;
  button.addEventListener('click', onClick);
  return button;
}
