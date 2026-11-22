import maplibregl, { type Map as MLMap, type MapMouseEvent } from 'maplibre-gl';
import type { LngLat } from './geo';
import { boundsOf, distanceMetres, formatDistance, nearestPointOnPath, pathLengthMetres } from './geo';
import { OfflineRouter } from './router';
import { RouteDraft, type LegSlot, type Waypoint } from './route-model';
import {
  addRouteLayers,
  clearRouteGeometry,
  ROUTE_CASING_LAYER_ID,
  ROUTE_LINE_LAYER_ID,
  ROUTE_SOURCE_ID,
  setOffRouteLine,
  setRouteGeometry,
} from './route-layers';
import { buildProfile, profileSampleCoords, type ElevationProfile } from './profile';
import { TerrainSampler } from './terrain-sampler';
import { SacSampler, summariseSacGrades, type SacSummary } from './sac-sampler';
import {
  AvalancheSampler,
  avalancheSampleCoords,
  summariseAvalancheTerrain,
  type AvalancheCell,
  type AvalancheSummary,
} from './avalanche-sampler';
import type { SenderStats } from './share-link';
import { RouteFollower, type FollowState } from './follow';
import { onPressHold } from './press-hold';
import { WakeLock } from '../app/wake-lock';
import type { PMTiles } from 'pmtiles';
import type { Region, RegionArtifact } from '../regions/manifest';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import type { Theme } from '../ui/theme';
import { insetOffset, insetPadding, NO_INSET, type ViewInset } from '../map/view-inset';

// Ties the pieces together: the draft (route-model), the offline router (router), the
// elevation profile (terrain-sampler + profile), the map layers and the draggable markers.
//
// Everything asynchronous here is cancellable and single-flight. Dragging a waypoint fires
// an edit per frame, and each one invalidates the legs the last one was still computing —
// so a superseded run must stop rather than race the new one to `setLeg`.

export interface RouteSummary {
  active: boolean;
  waypointCount: number;
  distanceM: number;
  /** Legs still being computed. Non-zero means the figures below are partial. */
  pendingLegs: number;
  /** True if any leg is a straight line: could not be snapped to a path (C11), or freehand. */
  hasStraightLegs: boolean;
  /** True if any leg was drawn freehand, with snap to paths off. */
  hasFreehandLegs: boolean;
  /** True if any leg was meant to follow paths and no route was found for it (C11). */
  hasUnroutedLegs: boolean;
  /** Whether new legs follow the path network, or are drawn as straight lines. */
  snapToPath: boolean;
  /** Whether there is a route to close back to its start, and it is not closed already. */
  canCloseLoop: boolean;
  canUndo: boolean;
  profile: ElevationProfile | null;
  /** Why there is no profile, when there is none. */
  profileNote: string | null;
  /**
   * SAC grades along the route, where the region carries them.
   *
   * Null means "we have nothing to say", never "T1". Its own `coverage` says how much of
   * the route the grades actually cover, which on most routes outside the Alps is very
   * little — see sac-sampler.ts.
   */
  sac: SacSummary | null;
  /** Why there are no grades, when there are none. */
  sacNote: string | null;
  /**
   * Slope classes along the route, where the region carries avalanche terrain.
   *
   * Terrain only — the artifact has never seen the snow, and it colours where a slope
   * could release, not where the debris goes (A6). Null means the region has no avalanche
   * artifact, never "no steep ground"; that is `steepest: null` inside it.
   */
  avalanche: AvalancheSummary | null;
  /** Why there is no avalanche terrain breakdown, when reading it failed. */
  avalancheNote: string | null;
  /** Set while the route on screen is one that arrived as a link, untouched. */
  received: ReceivedLink | null;
  /**
   * Where the route's start is still to come from, when it was begun from its far end —
   * "Route here" on a summit — or from "Start from my location": waiting for a GPS fix, or
   * for a tap on the map. Null when the start is settled.
   */
  startPrompt: StartPrompt | null;
  /** What the route is called: its saved name, or the one Save would suggest. */
  name: string;
  /** Whether the route on screen is a saved one (edited or not). */
  saved: boolean;
  /**
   * Whether the route on screen holds anything no saved record does: a route never saved,
   * or a saved one edited since. What Close asks about before taking it off the map.
   */
  unsaved: boolean;
  follow: FollowState | null;
  following: boolean;
  /**
   * Distance along the route nearest to the last GPS fix, metres — for the "you are here"
   * dot on the elevation chart. Null with no fix yet, no route, or the fix too far from
   * this route to mean anything (see {@link NEARBY_ROUTE_M}).
   */
  currentDistanceM: number | null;
}

/**
 * See {@link RouteSummary.startPrompt}. `locating`: asked the GPS, and a tap will do
 * instead. `tap`: only a tap will — the fix is too far from the route to start it from
 * (`awayM`), or there is no GPS to ask.
 */
export type StartPrompt = { kind: 'locating' } | { kind: 'tap'; awayM?: number };

/** A place to put a waypoint on, from outside the map: a summit card, a search result. */
export interface RoutePoint {
  lng: number;
  lat: number;
  name?: string;
  ele?: number;
}

/**
 * How far from the route your position can be and still start it.
 *
 * Further than that, "from my location" is almost always someone planning from home: a
 * leg from there is across a valley system or a country, routed (if at all) over roads the
 * walk never uses, and slow to work out on a phone. They are asked to tap the start.
 */
const START_FROM_LOCATION_MAX_M = 15_000;

/** A fix older than this is not "where you are" any more. */
const FRESH_FIX_MS = 2 * 60_000;

/** What a route that arrived as a link brought with it, beyond the route itself. */
export interface ReceivedLink {
  /** The link's own payload, so it can be passed on exactly as it came. */
  payload: string;
  /** The sender's climb, measured on their map. Null if they had none to send. */
  stats: SenderStats | null;
}

/**
 * A route that can be opened in the planner: a saved record, or an import.
 *
 * `coords` is required and authoritative (C10). `waypoints`/`legs` are the editing state —
 * present for a route planned here, absent for an imported GPX, and never required to
 * render or follow.
 */
export interface LoadableRoute {
  id?: string;
  name: string;
  coords: LngLat[];
  waypoints?: Waypoint[];
  legs?: LegSlot[];
  received?: ReceivedLink;
}

export interface RoutePlannerOptions {
  map: MLMap;
  registry: TileSourceRegistry;
  downloadedRegions: () => Region[];
  /** Name/elevation for a tapped point, when it landed on something known (a summit). */
  describePoint?: (event: MapMouseEvent) => Partial<Waypoint> | null;
  onChange: (summary: RouteSummary) => void;
  onStatus?: (message: string, kind: 'ok' | 'warn' | 'error') => void;
  /** Read at the moment the route layers are (re)created, since the theme can change. */
  theme: () => Theme;
  /**
   * Ask for a GPS fix, without the map following it. Fixes then arrive through
   * {@link RoutePlanner.updatePosition}, as they always do.
   */
  requestPosition?: () => void;
  /**
   * The route changed in a way worth keeping a copy of — see {@link RoutePlanner.snapshot}.
   * Not on every GPS fix, which `onChange` is: the copy is the route, not where you are on it.
   */
  onDraftChange?: () => void;
  /** What covers the map, so a route is fitted into what is left showing. */
  viewInset?: () => ViewInset;
}

/**
 * The route on screen, as kept across a reload — see {@link RoutePlanner.snapshot}.
 *
 * Its own record rather than a SavedRoute: an unsaved route has no id, an edited saved one
 * is not what the saved record says, and neither may be written over the routes list.
 */
export interface DraftSnapshot {
  waypoints: Waypoint[];
  legs: LegSlot[];
  /** The saved route this is, edited or not. Null for one never saved. */
  routeId: string | null;
  name: string | null;
  /** What the saved route's waypoints were, to tell an edit from none after a reload. */
  savedSignature: string | null;
  snapToPath: boolean;
  following: boolean;
  received: ReceivedLink | null;
}

/**
 * How long after a press-and-hold a map click is ignored.
 *
 * Long enough to cover the click the browser dispatches when the pressed element is
 * removed underneath the pointer, short enough that a deliberate tap straight afterwards
 * still registers.
 */
const CLICK_SUPPRESSION_MS = 400;

/**
 * How far a GPS fix can be from the route and still be shown as "here" on the elevation
 * chart while just viewing a plan, rather than following it.
 *
 * Wider than the off-route follow threshold (60 m, see follow.ts) on purpose: that one is a
 * warning that has to stay tight to mean anything, this is only informational. Someone who
 * has stepped off the path to sit down should still see roughly where they are, not have
 * the dot vanish — but someone planning a route from across town should not see a dot at
 * all, which is what an unbounded "nearest point" would otherwise draw.
 */
const NEARBY_ROUTE_M = 250;

/**
 * How near one of a file's own waypoints has to be to an end of its track to give that end
 * its name. ratmap's own exports put them exactly on the ends; another tool's trailhead or
 * summit marker should sit within a few metres of where its track starts or finishes.
 */
const END_NAME_RADIUS_M = 25;

/**
 * The plan an open replaced, kept so it can be put back: the draft itself, so its undo
 * history comes back with it, and which saved route it was.
 */
interface ReplacedPlan {
  draft: RouteDraft;
  id: string | null;
  name: string | null;
  savedSignature: string | null;
}

/**
 * The route's shape, as far as saving goes: where its waypoints are and how each leg was
 * drawn. Legs are not in it — they follow from the waypoints, and arrive after them.
 */
function signatureOf(draft: RouteDraft): string {
  return JSON.stringify(
    draft.getWaypoints().map((w) => [w.lng, w.lat, w.name ?? null, w.freehand === true]),
  );
}

/** Whether two lines are the same, vertex for vertex. */
function sameLine(a: readonly LngLat[], b: readonly LngLat[]): boolean {
  return a.length === b.length && a.every(([lng, lat], i) => lng === b[i][0] && lat === b[i][1]);
}

/** A route end at `at`, named after whichever of `candidates` sits on it, if any does. */
function endOfTrack(id: string, at: LngLat, candidates: readonly Waypoint[] = []): Waypoint {
  let nearest: Waypoint | null = null;
  let nearestM = END_NAME_RADIUS_M;
  for (const candidate of candidates) {
    const metres = distanceMetres([candidate.lng, candidate.lat], at);
    if (metres <= nearestM) {
      nearest = candidate;
      nearestM = metres;
    }
  }

  return {
    id,
    lng: at[0],
    lat: at[1],
    ...(nearest?.name ? { name: nearest.name } : {}),
    ...(typeof nearest?.ele === 'number' ? { ele: nearest.ele } : {}),
  };
}

export class RoutePlanner {
  private readonly map: MLMap;
  private readonly registry: TileSourceRegistry;
  private readonly downloadedRegions: () => Region[];
  private readonly describePoint?: (event: MapMouseEvent) => Partial<Waypoint> | null;
  private readonly onChange: (summary: RouteSummary) => void;
  private readonly onStatus?: (message: string, kind: 'ok' | 'warn' | 'error') => void;
  private readonly theme: () => Theme;
  private readonly onDraftChange?: () => void;
  private readonly viewInset: () => ViewInset;
  private readonly requestPosition?: () => void;
  /** See {@link RouteSummary.startPrompt}. */
  private startPrompt: StartPrompt | null = null;
  /** When {@link currentPosition} was last set. */
  private positionAt = 0;

  private readonly router: OfflineRouter;
  private draft = new RouteDraft();
  private markers: maplibregl.Marker[] = [];
  /** Torn down with the markers they belong to; see renderMarkers. */
  private markerDisposers: (() => void)[] = [];
  /**
   * Markers live in the same container MapLibre binds its own handlers to, so a press on
   * one also reaches the map as a click. After a press-and-hold removes a waypoint we
   * would otherwise immediately add a new one in its place.
   */
  private suppressClickUntil = 0;

  private active = false;
  /**
   * Applies to legs made from here on, never to ones already drawn — each leg remembers
   * its own mode (see Waypoint.freehand), so a route can mix the two.
   */
  private snapToPath = true;
  private inflight: AbortController | null = null;
  private profile: ElevationProfile | null = null;
  private profileNote: string | null = null;
  private sac: SacSummary | null = null;
  private sacNote: string | null = null;
  private avalanche: AvalancheSummary | null = null;
  private avalancheNote: string | null = null;
  /** The link the current draft came from. Tied to that draft: see {@link receivedLink}. */
  private received: (ReceivedLink & { draft: RouteDraft }) | null = null;

  private follower: RouteFollower | null = null;
  private followState: FollowState | null = null;
  /** Last GPS fix, kept regardless of follow state so the plan panel can show it too. */
  private currentPosition: LngLat | null = null;
  /**
   * Held for as long as a route is being followed.
   *
   * §7 states the limitation plainly: no browser on any platform can track you in the
   * background, so following means the app foregrounded and the screen on. A screen that
   * sleeps every thirty seconds is not that limitation being respected — it is the
   * feature not working.
   */
  private readonly wakeLock = new WakeLock();
  /** Id of the saved route currently loaded, so Save updates rather than duplicates. */
  private loadedRouteId: string | null = null;
  private loadedName: string | null = null;
  /**
   * {@link signatureOf} the saved route as it was opened or last saved. The route has
   * unsaved changes when the draft's own differs. Compared rather than read off the undo
   * history, which is capped: fifty-one edits undone fifty times is not the saved route.
   */
  private savedSignature: string | null = null;

  constructor(options: RoutePlannerOptions) {
    this.map = options.map;
    this.registry = options.registry;
    this.downloadedRegions = options.downloadedRegions;
    this.describePoint = options.describePoint;
    this.onChange = options.onChange;
    this.onStatus = options.onStatus;
    this.theme = options.theme;
    this.onDraftChange = options.onDraftChange;
    this.viewInset = options.viewInset ?? (() => NO_INSET);
    this.requestPosition = options.requestPosition;
    this.router = new OfflineRouter({
      registry: options.registry,
      downloadedRegions: options.downloadedRegions,
    });
  }

  isActive(): boolean {
    return this.active;
  }

  isFollowing(): boolean {
    return this.follower !== null;
  }

  /**
   * Whether taps and drags on the map edit the route: planning, and not following it.
   *
   * Following is the screen used one-handed and glanced at, and the follower tracks the
   * route as it stood when following began. Left editable, a stray tap added a waypoint —
   * redrawing the route while the follower kept to the old one, on a screen with no Undo —
   * and a tap on the line of an imported GPX split it and re-routed both halves, replacing
   * the track itself.
   */
  isEditing(): boolean {
    return this.active && this.follower === null;
  }

  getDraft(): RouteDraft {
    return this.draft;
  }

  getProfile(): ElevationProfile | null {
    return this.profile;
  }

  getLoadedRouteId(): string | null {
    return this.loadedRouteId;
  }

  getName(): string {
    return this.loadedName ?? this.suggestName();
  }

  /** See {@link RouteSummary.unsaved}. */
  hasUnsavedChanges(): boolean {
    if (this.draft.waypointCount === 0) return false;
    if (this.loadedRouteId === null) return true;
    return signatureOf(this.draft) !== this.savedSignature;
  }

  isSnappingToPath(): boolean {
    return this.snapToPath;
  }

  setSnapToPath(snap: boolean): void {
    if (this.snapToPath === snap) return;
    this.snapToPath = snap;
    this.emit();
    this.draftChanged();
  }

  activate(): void {
    if (this.active) return;
    addRouteLayers(this.map, this.theme());
    this.active = true;
    this.syncEditing();
    this.emit();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.syncEditing();
    this.emit();
  }

  /** Bring the cursor and the markers into line with {@link isEditing}. */
  private syncEditing(): void {
    this.map.getCanvas().style.cursor = this.isEditing() ? 'crosshair' : '';
    // Markers are built with `draggable` fixed at creation time, so leaving them alone
    // here would give a just-opened planner a route whose waypoints refuse to move — or a
    // followed one whose waypoints still do.
    this.renderMarkers();
  }

  /**
   * Forget everything cached from region archives.
   *
   * Called when a region is downloaded or deleted. Without it the router keeps its
   * "no tiles here" answers from before the download, so a freshly-downloaded region
   * would route as empty country until a reload — and a deleted one would keep routing
   * over a map that is no longer on the device.
   */
  invalidateRegions(): void {
    this.router.clearCache();
    this.samplers.clear();
    this.sacSamplers.clear();
    this.avalancheSamplers.clear();
    void this.refreshProfile();
  }

  /**
   * Handle a tap on the map while planning.
   *
   * A tap on the drawn route inserts a waypoint into that leg; anywhere else appends one.
   * Both commit immediately, before any routing is attempted — C11: waypoint placement
   * must not require a successful snap, or editing with no usable network is impossible.
   */
  handleMapClick(event: MapMouseEvent): boolean {
    if (!this.isEditing()) return false;

    // A tap that landed on an existing waypoint is about that waypoint, not about adding
    // another one on top of it. Both checks are needed: the target guard covers a plain
    // tap, and the timer covers a press-and-hold, where the element has already been
    // removed by the time the click is dispatched.
    if (Date.now() < this.suppressClickUntil) {
      this.suppressClickUntil = 0;
      return true;
    }
    const target = event.originalEvent.target;
    if (target instanceof Element && target.closest('.route-waypoint')) return true;

    const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
    const meta: Partial<Waypoint> = {
      ...this.describePoint?.(event),
      ...(this.snapToPath ? {} : { freehand: true }),
    };
    const onRoute = this.map
      .queryRenderedFeatures(event.point, {
        layers: [ROUTE_LINE_LAYER_ID, ROUTE_CASING_LAYER_ID].filter((id) =>
          Boolean(this.map.getLayer(id)),
        ),
      })
      .length > 0;

    if (this.startPrompt && this.draft.waypointCount > 0) {
      // Asked for: "tap the map where you'll start".
      this.startPrompt = null;
      this.draft.insertAt(0, point, meta);
    } else if (onRoute && this.draft.waypointCount >= 2) {
      this.draft.insertOnLine(point, meta);
    } else {
      this.draft.add(point, meta);
    }

    this.afterEdit();
    return true;
  }

  /**
   * Put a waypoint at the end of the route — a summit card's "Add to route", or the first
   * point of a route begun from one.
   */
  appendWaypoint(point: RoutePoint): void {
    if (!this.isEditing()) return;
    this.draft.add([point.lng, point.lat], this.waypointMeta(point));
    this.afterEdit();
  }

  /**
   * Start the route from where you are: now, if there is a fresh fix near enough; once
   * one arrives, if not (asking the GPS for it); or, too far away to be the start, by
   * asking for a tap instead. An empty route simply begins there, wherever that is.
   */
  startFromMyLocation(): void {
    if (!this.isEditing()) return;
    if (this.currentPosition && Date.now() - this.positionAt < FRESH_FIX_MS) {
      this.useFixAsStart(this.currentPosition);
      return;
    }
    if (!this.requestPosition) {
      this.startPrompt = { kind: 'tap' };
      this.emit();
      return;
    }
    this.startPrompt = { kind: 'locating' };
    this.requestPosition();
    this.emit();
  }

  /** Settle a start prompt with a fix: the start, or too far away to be one. */
  private useFixAsStart(fix: LngLat): void {
    if (this.draft.waypointCount === 0) {
      this.startPrompt = null;
      this.draft.add(fix, this.snapToPath ? {} : { freehand: true });
      this.afterEdit();
      this.map.easeTo({ center: fix, offset: insetOffset(this.viewInset()), duration: 500 });
      return;
    }
    const first = this.draft.getWaypoints()[0];
    const awayM = distanceMetres(fix, [first.lng, first.lat]);
    if (awayM > START_FROM_LOCATION_MAX_M) {
      this.startPrompt = { kind: 'tap', awayM };
      this.emit();
      return;
    }
    this.startPrompt = null;
    this.draft.insertAt(0, fix, this.snapToPath ? {} : { freehand: true });
    this.afterEdit();
    this.fitToRoute();
  }

  /**
   * The GPS will not be giving a fix: refused, or failing. A prompt still waiting on one
   * asks for a tap instead, rather than go on saying it is finding your location.
   */
  positionUnavailable(): void {
    if (this.startPrompt?.kind !== 'locating') return;
    this.startPrompt = { kind: 'tap' };
    this.emit();
  }

  /** Never mind the start prompt: the route starts where it starts. */
  dismissStartPrompt(): void {
    if (!this.startPrompt) return;
    this.startPrompt = null;
    this.emit();
  }

  private waypointMeta(point: RoutePoint): Partial<Waypoint> {
    return {
      ...(point.name ? { name: point.name } : {}),
      ...(typeof point.ele === 'number' ? { ele: point.ele } : {}),
      ...(this.snapToPath ? {} : { freehand: true }),
    };
  }

  /** Route back to the start — see {@link RouteDraft.closeLoop}. */
  closeLoop(): void {
    if (!this.isEditing()) return;
    if (!this.draft.closeLoop(this.snapToPath ? {} : { freehand: true })) return;
    this.afterEdit();
  }

  undo(): void {
    if (!this.draft.undo()) return;
    this.afterEdit();
  }

  removeWaypoint(id: string): void {
    if (!this.draft.remove(id)) return;
    this.afterEdit();
  }

  clear(): void {
    this.startPrompt = null;
    this.draft.clear();
    this.loadedRouteId = null;
    this.loadedName = null;
    this.savedSignature = null;
    this.profile = null;
    this.profileNote = null;
    this.sac = null;
    this.sacNote = null;
    this.avalanche = null;
    this.avalancheNote = null;
    this.stopFollowing();
    this.afterEdit();
  }

  /**
   * Take the route off the map and leave planning — the planner's way out.
   *
   * Returns a way to put the route back, or null when there was none. Leaving planning used
   * to leave the route drawn, its markers numbered, with nothing on screen that led back to
   * it: no chip, no panel, a tap on the line opening whatever summit was underneath. An
   * unsaved one was then wiped, silently, by the next "New route".
   */
  close(): (() => boolean) | null {
    const closed: ReplacedPlan | null =
      this.draft.waypointCount > 0
        ? { draft: this.draft, id: this.loadedRouteId, name: this.loadedName, savedSignature: this.savedSignature }
        : null;

    this.stopFollowing();
    this.inflight?.abort();
    this.inflight = null;
    this.startPrompt = null;
    this.draft = new RouteDraft();
    this.loadedRouteId = null;
    this.loadedName = null;
    this.savedSignature = null;
    this.received = null;
    this.profile = null;
    this.profileNote = null;
    this.sac = null;
    this.sacNote = null;
    this.avalanche = null;
    this.avalancheNote = null;
    this.active = false;
    // Only if anything was ever drawn: with no source yet there is nothing to take off, and
    // adding one before the style is ready throws.
    if (this.map.getSource(ROUTE_SOURCE_ID)) this.renderGeometry();
    this.syncEditing();
    this.emit();
    this.draftChanged();

    return closed ? () => this.reopen(closed) : null;
  }

  /**
   * Put back a route {@link close} took away. Declines, returning false, once another route
   * has been started or opened: putting this one back would take that one away instead.
   */
  private reopen(closed: ReplacedPlan): boolean {
    if (this.draft.waypointCount > 0) return false;
    this.draft = closed.draft;
    this.loadedRouteId = closed.id;
    this.loadedName = closed.name;
    this.savedSignature = closed.savedSignature;
    if (!this.active) {
      addRouteLayers(this.map, this.theme());
      this.active = true;
    }
    this.map.getCanvas().style.cursor = this.isEditing() ? 'crosshair' : '';
    this.showDraft([]);
    return true;
  }

  /**
   * A copy of the route on screen, to keep across a reload — or null when there is none.
   *
   * iOS ends a backgrounded web app whenever it wants the memory, and an update reloads the
   * page; either used to lose a route being planned, or the one being followed on a hill.
   */
  snapshot(): DraftSnapshot | null {
    if (this.draft.waypointCount === 0) return null;
    const received = this.receivedLink();
    return {
      ...this.draft.toState(),
      routeId: this.loadedRouteId,
      name: this.loadedName,
      savedSignature: this.savedSignature,
      snapToPath: this.snapToPath,
      following: this.follower !== null,
      received,
    };
  }

  /**
   * Put a {@link snapshot} back on screen, in planning: what was on screen before the page
   * went away. Following is not restarted — that needs the GPS, which is the caller's to ask
   * for (and on iOS, from a tap).
   *
   * The map is left where it is. It opens where it was closed (map/last-view.ts), which is
   * the view the route was last seen in; fitting the whole route over that would move
   * someone off the stretch they were looking at.
   */
  restore(saved: DraftSnapshot): void {
    this.startPrompt = null;
    this.stopFollowing();
    this.inflight?.abort();
    this.inflight = null;
    this.draft = new RouteDraft({ waypoints: saved.waypoints, legs: saved.legs });
    this.loadedRouteId = saved.routeId;
    this.loadedName = saved.name;
    this.savedSignature = saved.savedSignature;
    this.snapToPath = saved.snapToPath;
    this.received = saved.received ? { ...saved.received, draft: this.draft } : null;
    if (!this.active) {
      addRouteLayers(this.map, this.theme());
      this.active = true;
    }
    this.map.getCanvas().style.cursor = this.isEditing() ? 'crosshair' : '';
    this.showDraft([], { fit: false });
  }

  /**
   * Replace the draft with a saved or imported route.
   *
   * Returns a way to put back the plan this replaced, or null when there was nothing to
   * lose. Opening a route used to throw away whatever was being planned, with no undo: the
   * undo history belongs to the draft, and the draft was simply replaced. The way back only
   * works while the route opened here is still on screen untouched — after an edit, going
   * back would throw that edit away instead, so it declines and returns false.
   */
  load(route: LoadableRoute): (() => boolean) | null {
    const replaced = this.replaceablePlan(route);
    const previousLine = this.draft.coordinates();

    // The follower holds the route it started on; it must not go on tracking that one
    // under a different route drawn on the map.
    this.stopFollowing();
    this.inflight?.abort();
    this.inflight = null;
    this.startPrompt = null;
    this.loadedRouteId = route.id ?? null;
    this.loadedName = route.name;

    const hasEditingState = Boolean(route.legs?.length && route.waypoints?.length);

    if (hasEditingState) {
      this.draft = new RouteDraft({
        waypoints: route.waypoints!,
        legs: route.legs!,
      });
    } else {
      // No editing state — an import, or a record written before legs were stored. The
      // geometry is authoritative (C10), so present it as a single already-computed leg
      // rather than re-routing it, which would silently change someone's saved route.
      //
      // Its ends are the geometry's own. A file's <wpt>s are whatever its author marked —
      // often points of interest partway along — and making the first and last of them the
      // route's ends left the markers off the line, so dragging one re-routed the whole
      // import between two of them. A waypoint that does sit on an end still names it.
      const start = route.coords[0];
      const end = route.coords[route.coords.length - 1];

      this.draft = new RouteDraft({
        waypoints: [endOfTrack('start', start, route.waypoints), endOfTrack('end', end, route.waypoints)],
        legs: [
          {
            coords: route.coords,
            // Measured from the geometry rather than carried in: an imported GPX has no
            // distance field, and a stored one may predate a change to how it is measured.
            distanceM: pathLengthMetres(route.coords),
            kind: 'snapped',
            wayNames: [],
          },
        ],
      });
    }

    this.received = route.received ? { ...route.received, draft: this.draft } : null;
    // Opened from the saved record, so it holds exactly what the record does.
    this.savedSignature = route.id ? signatureOf(this.draft) : null;

    this.showDraft(previousLine);

    const opened = this.draft;
    return replaced ? () => this.reinstate(replaced, opened) : null;
  }

  /**
   * The link behind the route on screen, while it still is that route.
   *
   * Goes as soon as the route is edited or replaced: the sender's climb belongs to the line
   * they sent, and offering their figures against a different one would be a wrong number
   * with someone else's name on it.
   */
  private receivedLink(): ReceivedLink | null {
    if (this.received?.draft !== this.draft || this.draft.canUndo) return null;
    return { payload: this.received.payload, stats: this.received.stats };
  }

  /** What opening `route` would throw away — null when the answer is nothing. */
  private replaceablePlan(route: LoadableRoute): ReplacedPlan | null {
    if (this.draft.waypointCount === 0) return null;
    // Opening the saved route that is already open, unedited, loses nothing.
    if (route.id !== undefined && route.id === this.loadedRouteId && !this.hasUnsavedChanges()) return null;
    return {
      draft: this.draft,
      id: this.loadedRouteId,
      name: this.loadedName,
      savedSignature: this.savedSignature,
    };
  }

  /** Put back the plan an open replaced — see {@link load}. */
  private reinstate(previous: ReplacedPlan, opened: RouteDraft): boolean {
    if (this.draft !== opened || opened.canUndo) return false;

    const previousLine = this.draft.coordinates();
    this.stopFollowing();
    this.inflight?.abort();
    this.inflight = null;
    this.draft = previous.draft;
    this.loadedRouteId = previous.id;
    this.loadedName = previous.name;
    this.savedSignature = previous.savedSignature;
    this.showDraft(previousLine);
    return true;
  }

  /**
   * Put a draft that has just been swapped in on screen, and bring its figures up to date.
   *
   * The profile and grades describe the line they were measured on. For a different line
   * they are cleared rather than shown against it until its own arrive; the same line
   * keeps them — Save reopens the route it has just stored, and clearing them blanked the
   * chart on every save. `recompute` then measures, after first filling in any leg the
   * draft arrived without, which nothing else would.
   */
  private showDraft(previousLine: readonly LngLat[], { fit = true }: { fit?: boolean } = {}): void {
    if (!sameLine(previousLine, this.draft.coordinates())) {
      this.profile = null;
      this.profileNote = null;
      this.sac = null;
      this.sacNote = null;
      this.avalanche = null;
      this.avalancheNote = null;
    }
    this.renderGeometry();
    this.renderMarkers();
    // After emit, which is what brings the route panel up: the route is fitted into the
    // map that panel leaves showing, not the one before it opened.
    this.emit();
    if (fit) this.fitToRoute();
    this.draftChanged();
    void this.recompute();
  }

  fitToRoute(): void {
    const coords = this.draft.coordinates();
    const bounds = boundsOf(coords, 300);
    if (!bounds || coords.length < 2) return;
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: insetPadding(this.viewInset(), 60), duration: 600 },
    );
  }

  // --- Following ---------------------------------------------------------------------

  startFollowing(): void {
    const coords = this.draft.coordinates();
    if (coords.length < 2) {
      this.onStatus?.('Nothing to follow yet.', 'warn');
      return;
    }
    this.follower = new RouteFollower(coords);
    this.followState = null;
    this.startPrompt = null;
    void this.wakeLock.acquire();
    this.syncEditing();
    this.emit();
    this.draftChanged();
  }

  stopFollowing(): void {
    if (!this.follower) return;
    this.follower = null;
    this.followState = null;
    void this.wakeLock.release();
    setOffRouteLine(this.map, null, null);
    this.syncEditing();
    this.emit();
    this.draftChanged();
  }

  /**
   * Feed a GPS fix in. Kept for the plan panel's "you are here" dot even when not
   * following; the off-route line and progress figures still only update while following.
   */
  updatePosition(position: LngLat): void {
    this.currentPosition = position;
    this.positionAt = Date.now();
    if (this.startPrompt?.kind === 'locating' && this.isEditing()) {
      this.useFixAsStart(position);
    }
    if (this.follower) {
      const state = this.follower.update(position);
      this.followState = state;
      setOffRouteLine(this.map, state?.isOffRoute ? position : null, state?.nearest ?? null);
    }
    this.emit();
  }

  // --- Internals ---------------------------------------------------------------------

  private afterEdit(): void {
    this.renderGeometry();
    this.renderMarkers();
    this.emit();
    this.draftChanged();
    void this.recompute();
  }

  private draftChanged(): void {
    this.onDraftChange?.();
  }

  private async recompute(): Promise<void> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;

    try {
      // Re-read the pending list each pass rather than iterating a snapshot: an edit that
      // lands mid-run shifts leg indices, and writing a result back to a stale index would
      // attach one leg's geometry to a different pair of waypoints.
      for (;;) {
        const [index] = this.draft.pendingLegs();
        if (index === undefined) break;

        const ends = this.draft.legEnds(index);
        if (!ends) break;

        const leg = await this.router.computeLeg(ends[0], ends[1], {
          signal: controller.signal,
          snap: this.draft.legSnaps(index),
        });

        if (controller.signal.aborted) return;
        this.draft.setLeg(index, leg);
        this.renderGeometry();
        this.emit();
        // The computed line is what renders and follows with no router (C10); a copy
        // without it would come back as straight lines, or not at all offline.
        this.draftChanged();
      }

      await this.refreshProfile(controller.signal);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      this.onStatus?.(`Could not plan that leg: ${(err as Error).message}`, 'error');
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  /**
   * Measure the route: elevation profile, SAC grades, then avalanche terrain.
   *
   * The first two read the same sample points — the profile's 25 m densification — so the
   * two sets of numbers describe the same places, and a later feature that colours the
   * chart by grade has them index for index. Slope samples finer (see
   * avalancheSampleCoords), because a skipped cell there is a missed gully. One `emit()` at the end: each of these is a panel
   * re-render, and a waypoint drag already fires one per frame.
   */
  private async refreshProfile(signal?: AbortSignal): Promise<void> {
    const coords = this.draft.coordinates();
    if (coords.length < 2) {
      this.profile = null;
      this.profileNote = null;
      this.sac = null;
      this.sacNote = null;
      this.avalanche = null;
      this.avalancheNote = null;
      this.emit();
      return;
    }

    const samples = profileSampleCoords(coords);
    await this.measureElevation(coords, samples, signal);
    if (signal?.aborted) return;
    await this.measureSacGrades(coords, samples, signal);
    if (signal?.aborted) return;
    await this.measureAvalancheTerrain(coords, signal);
    if (signal?.aborted) return;

    this.emit();
  }

  /**
   * Sample the elevation profile.
   *
   * Requires a downloaded region's terrain archive. The global terrain archive is a z0-4
   * extract — about 5 km per pixel at this latitude — so a profile sampled from it would
   * be a smooth curve bearing no relation to the ground. Saying "download the region"
   * is the honest answer; drawing that curve would not be.
   */
  private async measureElevation(
    coords: readonly LngLat[],
    samples: LngLat[],
    signal?: AbortSignal,
  ): Promise<void> {
    const terrain = this.terrainSourceFor(coords);
    if (!terrain) {
      this.profile = null;
      this.profileNote =
        'Elevation profile needs a downloaded region.';
      return;
    }

    try {
      const elevations = await terrain.sample(samples, signal);
      if (signal?.aborted) return;
      this.profile = buildProfile(samples, elevations);
      this.profileNote =
        this.profile.coverage < 1
          ? `Elevation data covers ${Math.round(this.profile.coverage * 100)}% of this route; climb and time are understated.`
          : null;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      this.profile = null;
      this.profileNote = `Could not read elevation data: ${(err as Error).message}`;
    }
  }

  /**
   * Look up the SAC grade of each sample.
   *
   * Absent grades are the normal case, not a failure: `sac_scale` is tagged on roughly 7%
   * of walkable ways in the Scottish hills and far more in the Alps, so most routes come
   * back mostly ungraded. That is why the summary carries coverage and the UI leads with
   * it — an ungraded path is not an easy path, and this must never be read as one.
   */
  private async measureSacGrades(
    coords: readonly LngLat[],
    samples: LngLat[],
    signal?: AbortSignal,
  ): Promise<void> {
    const sac = this.sacSourceFor(coords);
    if (!sac) {
      this.sac = null;
      this.sacNote = null;
      return;
    }

    try {
      const grades = await sac.grades(samples, signal);
      if (signal?.aborted) return;
      this.sac = summariseSacGrades(samples, grades);
      this.sacNote = null;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      this.sac = null;
      this.sacNote = `Could not read SAC grades: ${(err as Error).message}`;
    }
  }

  /**
   * Total the route's distance by slope class, from the region's avalanche terrain.
   *
   * Absent when the region has no such artifact, which is most regions — it is built only
   * for the alpine set (plans/avalanche-terrain.md §8 decision 2).
   */
  private async measureAvalancheTerrain(
    coords: readonly LngLat[],
    signal?: AbortSignal,
  ): Promise<void> {
    const source = this.avalancheSourceFor(coords);
    if (!source) {
      this.avalanche = null;
      this.avalancheNote = null;
      return;
    }

    try {
      const samples = avalancheSampleCoords(coords);
      const cells = await source.sampler.cells(samples, signal);
      if (signal?.aborted) return;
      this.avalanche = summariseAvalancheTerrain(samples, cells);
      this.avalancheNote = null;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      this.avalanche = null;
      this.avalancheNote = `Could not read avalanche terrain: ${(err as Error).message}`;
    }
  }

  /** The grade archive covering this route, or null — see {@link coveringArchive}. */
  private sacSourceFor(coords: readonly LngLat[]): SacSampler | null {
    const found = this.coveringArchive(coords, 'sac');
    if (!found) return null;

    const existing = this.sacSamplers.get(found.artifact.filename);
    if (existing) return existing;

    // z15 default: the same zoom the router reads the network at, and the archive's own
    // top level — build-sac.sh tiles to z15 because that is where paths stop being
    // generalised away.
    const maxzoom = typeof found.artifact.maxzoom === 'number' ? found.artifact.maxzoom : 15;
    const sampler = new SacSampler({ archive: found.archive, maxzoom });
    this.sacSamplers.set(found.artifact.filename, sampler);
    return sampler;
  }

  private readonly sacSamplers = new Map<string, SacSampler>();

  private terrainSourceFor(coords: readonly LngLat[]): TerrainSampler | null {
    // The whole route must be inside: a profile that silently stops at a region edge
    // would understate the climb without saying so.
    const found = this.coveringArchive(coords, 'terrain');
    if (!found) return null;

    // Cached per artifact so a drag does not rebuild the decode cache on every frame.
    const existing = this.samplers.get(found.artifact.filename);
    if (existing) return existing;

    const maxzoom = typeof found.artifact.maxzoom === 'number' ? found.artifact.maxzoom : 11;
    const sampler = new TerrainSampler({ archive: found.archive, maxzoom });
    this.samplers.set(found.artifact.filename, sampler);
    return sampler;
  }

  private readonly samplers = new Map<string, TerrainSampler>();

  private avalancheSourceFor(
    coords: readonly LngLat[],
  ): { sampler: AvalancheSampler; region: Region } | null {
    const found = this.coveringArchive(coords, 'avalanche');
    if (!found) return null;

    let sampler = this.avalancheSamplers.get(found.artifact.filename);
    if (!sampler) {
      // z11 default: the build caps the zoom at the DEM's own resolution, which is z11 in
      // Scotland and z12 in the Alps — the manifest's own figure is the one to trust.
      const maxzoom = typeof found.artifact.maxzoom === 'number' ? found.artifact.maxzoom : 11;
      sampler = new AvalancheSampler({ archive: found.archive, maxzoom });
      this.avalancheSamplers.set(found.artifact.filename, sampler);
    }
    return { sampler, region: found.region };
  }

  private readonly avalancheSamplers = new Map<string, AvalancheSampler>();

  /**
   * The downloaded region artifact of `kind` whose region wholly contains `coords`.
   *
   * Whole-route containment for every sampler: a route running out of the region would
   * come back with its far part unmeasured, and no way to tell that apart from genuinely
   * empty ground. Saying nothing is the honest answer there.
   */
  private coveringArchive(
    coords: readonly LngLat[],
    kind: RegionArtifact['kind'],
  ): { artifact: RegionArtifact; archive: PMTiles; region: Region } | null {
    const bounds = boundsOf(coords);
    if (!bounds) return null;

    for (const region of this.downloadedRegions()) {
      const artifact = region.artifacts.find((candidate) => candidate.kind === kind);
      if (!artifact) continue;
      if (
        bounds[0] < region.bbox[0] ||
        bounds[1] < region.bbox[1] ||
        bounds[2] > region.bbox[2] ||
        bounds[3] > region.bbox[3]
      ) {
        continue;
      }

      const archive = this.registry.get(artifact.filename);
      if (archive) return { artifact, archive, region };
    }

    return null;
  }

  /**
   * Slope and aspect at one point, from the region's avalanche terrain artifact, plus the
   * region it came from (the tap sheet names that region's forecast service).
   *
   * Null where no downloaded region carries the artifact here. `cell: null` inside one is
   * a point the archive has no tile for — still not "flat".
   */
  async avalancheAt(point: LngLat): Promise<{ cell: AvalancheCell | null; region: Region } | null> {
    const source = this.avalancheSourceFor([point]);
    if (!source) return null;
    const [cell] = await source.sampler.cells([point]);
    return { cell, region: source.region };
  }

  /**
   * The ground height at one point, in metres, read from the same downloaded terrain the
   * profile uses — and through the same cached samplers, so {@link invalidateRegions}
   * covers it too.
   *
   * Null where no downloaded region covers the point. As with the profile, the worldwide
   * terrain layer is no fallback: at ~5 km per pixel it would quote a valley floor's
   * height for a summit, which reads as a real answer and is not one.
   */
  async elevationAt(point: LngLat): Promise<number | null> {
    const terrain = this.terrainSourceFor([point]);
    if (!terrain) return null;
    const [ele] = await terrain.sample([point]);
    return ele;
  }

  /**
   * Put the route back on the map after the style underneath it has been replaced.
   *
   * Switching theme swaps the whole style, which takes the route's source and layers with
   * it. Losing someone's half-built route because they turned the map dark would be its
   * own bug.
   */
  redrawGeometry(): void {
    this.renderGeometry();
  }

  private renderGeometry(): void {
    if (!this.map.getSource('route-geometry')) addRouteLayers(this.map, this.theme());
    setRouteGeometry(this.map, this.draft.getLegs());
    if (this.draft.waypointCount === 0) clearRouteGeometry(this.map);
  }

  /**
   * Rebuild the waypoint markers.
   *
   * Torn down and recreated on every edit rather than diffed. Markers are cheap, a route
   * has tens of them at most, and a diff keyed on waypoint id would have to handle inserts
   * in the middle — which is exactly where an off-by-one would attach a drag handler to
   * the wrong waypoint and move something the user did not touch.
   */
  private renderMarkers(): void {
    for (const dispose of this.markerDisposers) dispose();
    this.markerDisposers = [];
    for (const marker of this.markers) marker.remove();
    this.markers = [];

    const waypoints = this.draft.getWaypoints();
    waypoints.forEach((waypoint, index) => {
      // Two elements, not one: the pin stays small enough to read a map through, while
      // the element MapLibre positions and drags around it is a 44px touch target. A
      // 22px drag handle on a surface that pans when you miss it is not usable with a
      // finger.
      const element = document.createElement('div');
      element.className = 'route-waypoint';
      if (index === 0) element.classList.add('start');
      else if (index === waypoints.length - 1) element.classList.add('end');
      element.title = waypoint.name ?? `Waypoint ${index + 1}`;

      const pin = document.createElement('span');
      pin.className = 'route-waypoint-pin';
      pin.textContent = String(index + 1);
      element.append(pin);

      const marker = new maplibregl.Marker({ element, draggable: this.isEditing() })
        .setLngLat([waypoint.lng, waypoint.lat])
        .addTo(this.map);

      marker.on('dragend', () => {
        const position = marker.getLngLat();
        this.draft.move(waypoint.id, [position.lng, position.lat]);
        this.afterEdit();
      });

      // Removing a waypoint has to be reachable without a list: on a phone the map is the
      // interface. Right-click is the desktop convention and still works...
      element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!this.isEditing()) return;
        this.removeWaypoint(waypoint.id);
      });

      // ...but it is dead on iOS (see press-hold.ts), so the touch gesture is built on
      // pointer events instead. The class swells the pin while the timer runs, which is
      // also the only discoverability this gesture has: rest a finger on a waypoint and
      // it visibly responds.
      this.markerDisposers.push(
        onPressHold(element, {
          onStart: () => element.classList.add('holding'),
          onCancel: () => element.classList.remove('holding'),
          onHold: () => {
            element.classList.remove('holding');
            if (!this.isEditing()) return;
            this.suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
            this.removeWaypoint(waypoint.id);
          },
        }),
      );

      this.markers.push(marker);
    });
  }

  private suggestName(): string {
    const waypoints = this.draft.getWaypoints();
    // A round trip's finish is a copy of its start, and "Achintee" is a poor name for a
    // walk up Ben Nevis and back — the far point is what the walk is to.
    if (this.draft.isLoop()) waypoints.pop();
    const named = waypoints.filter((waypoint) => waypoint.name);
    if (named.length > 0) return named[named.length - 1].name!;
    if (this.draft.totalDistanceM > 0) return `${formatDistance(this.draft.totalDistanceM)} route`;
    return 'Untitled route';
  }

  /**
   * The planner's current state.
   *
   * Public because the UI has to be able to *redraw* itself — reopening the sheet, say —
   * without an edit having happened to push a summary at it.
   */
  summary(): RouteSummary {
    return {
      active: this.active,
      waypointCount: this.draft.waypointCount,
      distanceM: this.draft.totalDistanceM,
      pendingLegs: this.draft.pendingLegs().length,
      hasStraightLegs: this.draft.hasStraightLegs(),
      hasFreehandLegs: this.draft.hasFreehandLegs(),
      hasUnroutedLegs: this.draft.hasUnroutedLegs(),
      snapToPath: this.snapToPath,
      canCloseLoop: this.draft.canCloseLoop(),
      canUndo: this.draft.canUndo,
      profile: this.profile,
      profileNote: this.profileNote,
      sac: this.sac,
      sacNote: this.sacNote,
      avalanche: this.avalanche,
      avalancheNote: this.avalancheNote,
      received: this.receivedLink(),
      startPrompt: this.startPrompt,
      name: this.getName(),
      saved: this.loadedRouteId !== null,
      unsaved: this.hasUnsavedChanges(),
      follow: this.followState,
      following: this.follower !== null,
      currentDistanceM: this.currentDistanceM(),
    };
  }

  /** See {@link RouteSummary.currentDistanceM}. */
  private currentDistanceM(): number | null {
    if (this.followState) return this.followState.alongM;
    if (!this.currentPosition) return null;

    const coords = this.draft.coordinates();
    if (coords.length < 2) return null;

    const nearest = nearestPointOnPath(coords, this.currentPosition);
    if (!nearest || nearest.distanceM > NEARBY_ROUTE_M) return null;
    return nearest.alongM;
  }

  private emit(): void {
    this.onChange(this.summary());
  }
}
