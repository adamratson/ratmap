import maplibregl, { type Map as MLMap, type MapMouseEvent } from 'maplibre-gl';
import type { LngLat } from './geo';
import { boundsOf, formatDistance, pathLengthMetres } from './geo';
import type { Costing } from './path-graph';
import { OfflineRouter } from './router';
import { RouteDraft, type LegSlot, type Waypoint } from './route-model';
import {
  addRouteLayers,
  clearRouteGeometry,
  ROUTE_CASING_LAYER_ID,
  ROUTE_LINE_LAYER_ID,
  setOffRouteLine,
  setRouteGeometry,
} from './route-layers';
import { buildProfile, profileSampleCoords, type ElevationProfile } from './profile';
import { TerrainSampler } from './terrain-sampler';
import { RouteFollower, type FollowState } from './follow';
import { onPressHold } from './press-hold';
import { WakeLock } from '../wake-lock';
import type { Region } from '../regions/manifest';
import type { TileSourceRegistry } from '../tile-source-registry';

// Ties the pieces together: the draft (route-model), the offline router (router), the
// elevation profile (terrain-sampler + profile), the map layers and the draggable markers.
//
// Everything asynchronous here is cancellable and single-flight. Dragging a waypoint fires
// an edit per frame, and each one invalidates the legs the last one was still computing —
// so a superseded run must stop rather than race the new one to `setLeg`.

export interface RouteSummary {
  active: boolean;
  costing: Costing;
  waypointCount: number;
  distanceM: number;
  /** Legs still being computed. Non-zero means the figures below are partial. */
  pendingLegs: number;
  /** True if any leg could not be snapped to a path (C11). */
  hasStraightLegs: boolean;
  canUndo: boolean;
  profile: ElevationProfile | null;
  /** Why there is no profile, when there is none. */
  profileNote: string | null;
  follow: FollowState | null;
  following: boolean;
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
  costing?: Costing;
}

export interface RoutePlannerOptions {
  map: MLMap;
  registry: TileSourceRegistry;
  downloadedRegions: () => Region[];
  /** Name/elevation for a tapped point, when it landed on something known (a summit). */
  describePoint?: (event: MapMouseEvent) => Partial<Waypoint> | null;
  onChange: (summary: RouteSummary) => void;
  onStatus?: (message: string, kind: 'ok' | 'warn' | 'error') => void;
}

/**
 * How long after a press-and-hold a map click is ignored.
 *
 * Long enough to cover the click the browser dispatches when the pressed element is
 * removed underneath the pointer, short enough that a deliberate tap straight afterwards
 * still registers.
 */
const CLICK_SUPPRESSION_MS = 400;

export class RoutePlanner {
  private readonly map: MLMap;
  private readonly registry: TileSourceRegistry;
  private readonly downloadedRegions: () => Region[];
  private readonly describePoint?: (event: MapMouseEvent) => Partial<Waypoint> | null;
  private readonly onChange: (summary: RouteSummary) => void;
  private readonly onStatus?: (message: string, kind: 'ok' | 'warn' | 'error') => void;

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
  private inflight: AbortController | null = null;
  private profile: ElevationProfile | null = null;
  private profileNote: string | null = null;

  private follower: RouteFollower | null = null;
  private followState: FollowState | null = null;
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

  constructor(options: RoutePlannerOptions) {
    this.map = options.map;
    this.registry = options.registry;
    this.downloadedRegions = options.downloadedRegions;
    this.describePoint = options.describePoint;
    this.onChange = options.onChange;
    this.onStatus = options.onStatus;
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

  activate(): void {
    if (this.active) return;
    addRouteLayers(this.map);
    this.active = true;
    this.map.getCanvas().style.cursor = 'crosshair';
    // Markers are built with `draggable` fixed at creation time, so leaving them alone
    // here would give a just-opened planner a route whose waypoints refuse to move.
    this.renderMarkers();
    this.emit();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';
    this.renderMarkers();
    this.emit();
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
    if (!this.active) return false;

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
    const meta = this.describePoint?.(event) ?? {};
    const onRoute = this.map
      .queryRenderedFeatures(event.point, {
        layers: [ROUTE_LINE_LAYER_ID, ROUTE_CASING_LAYER_ID].filter((id) =>
          Boolean(this.map.getLayer(id)),
        ),
      })
      .length > 0;

    if (onRoute && this.draft.waypointCount >= 2) {
      this.draft.insertOnLine(point, meta);
    } else {
      this.draft.add(point, meta);
    }

    this.afterEdit();
    return true;
  }

  setCosting(costing: Costing): void {
    this.draft.setCosting(costing);
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
    this.draft.clear();
    this.loadedRouteId = null;
    this.loadedName = null;
    this.profile = null;
    this.profileNote = null;
    this.stopFollowing();
    this.afterEdit();
  }

  /** Replace the draft with a saved or imported route. */
  load(route: LoadableRoute): void {
    this.inflight?.abort();
    this.inflight = null;
    this.loadedRouteId = route.id ?? null;
    this.loadedName = route.name;

    const hasEditingState = Boolean(route.legs?.length && route.waypoints?.length);

    if (hasEditingState) {
      this.draft = new RouteDraft({
        waypoints: route.waypoints!,
        legs: route.legs!,
        costing: route.costing ?? 'walking',
      });
    } else {
      // No editing state — an import, or a record written before legs were stored. The
      // geometry is authoritative (C10), so present it as a single already-computed leg
      // rather than re-routing it, which would silently change someone's saved route.
      const ends: Waypoint[] =
        route.waypoints && route.waypoints.length >= 2
          ? route.waypoints
          : [
              { id: 'start', lng: route.coords[0][0], lat: route.coords[0][1] },
              {
                id: 'end',
                lng: route.coords[route.coords.length - 1][0],
                lat: route.coords[route.coords.length - 1][1],
              },
            ];

      this.draft = new RouteDraft({
        waypoints: [ends[0], ends[ends.length - 1]],
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
        costing: route.costing ?? 'walking',
      });
    }

    this.renderGeometry();
    this.renderMarkers();
    this.fitToRoute();
    void this.refreshProfile();
    this.emit();
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
      { padding: 60, duration: 600 },
    );
  }

  // --- Following ---------------------------------------------------------------------

  startFollowing(): void {
    const coords = this.draft.coordinates();
    if (coords.length < 2) {
      this.onStatus?.('Nothing to follow yet — plan or open a route first.', 'warn');
      return;
    }
    this.follower = new RouteFollower(coords);
    this.followState = null;
    void this.wakeLock.acquire();
    this.emit();
  }

  stopFollowing(): void {
    if (!this.follower) return;
    this.follower = null;
    this.followState = null;
    void this.wakeLock.release();
    setOffRouteLine(this.map, null, null);
    this.emit();
  }

  /** Feed a GPS fix in. No-op unless following is on. */
  updatePosition(position: LngLat): void {
    if (!this.follower) return;
    const state = this.follower.update(position);
    this.followState = state;
    setOffRouteLine(this.map, state?.isOffRoute ? position : null, state?.nearest ?? null);
    this.emit();
  }

  // --- Internals ---------------------------------------------------------------------

  private afterEdit(): void {
    this.renderGeometry();
    this.renderMarkers();
    this.emit();
    void this.recompute();
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
          costing: this.draft.costing,
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;
        this.draft.setLeg(index, leg);
        this.renderGeometry();
        this.emit();
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
   * Sample the elevation profile.
   *
   * Requires a downloaded region's terrain archive. The global terrain archive is a z0-4
   * extract — about 5 km per pixel at this latitude — so a profile sampled from it would
   * be a smooth curve bearing no relation to the ground. Saying "download the region"
   * is the honest answer; drawing that curve would not be.
   */
  private async refreshProfile(signal?: AbortSignal): Promise<void> {
    const coords = this.draft.coordinates();
    if (coords.length < 2) {
      this.profile = null;
      this.profileNote = null;
      this.emit();
      return;
    }

    const terrain = this.terrainSourceFor(coords);
    if (!terrain) {
      this.profile = null;
      this.profileNote =
        'Elevation profile needs a downloaded region — the worldwide terrain layer is far too coarse to measure a climb from.';
      this.emit();
      return;
    }

    const samples = profileSampleCoords(coords);
    try {
      const elevations = await terrain.sample(samples, signal);
      if (signal?.aborted) return;
      this.profile = buildProfile(samples, elevations);
      this.profileNote =
        this.profile.coverage < 1
          ? `Elevation data covers ${Math.round(this.profile.coverage * 100)}% of this route; the climb totals are understated.`
          : null;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      this.profile = null;
      this.profileNote = `Could not read elevation data: ${(err as Error).message}`;
    }

    this.emit();
  }

  private terrainSourceFor(coords: readonly LngLat[]): TerrainSampler | null {
    const bounds = boundsOf(coords);
    if (!bounds) return null;

    for (const region of this.downloadedRegions()) {
      const artifact = region.artifacts.find((candidate) => candidate.kind === 'terrain');
      if (!artifact) continue;
      // The whole route must be inside: a profile that silently stops at a region edge
      // would understate the climb without saying so.
      if (
        bounds[0] < region.bbox[0] ||
        bounds[1] < region.bbox[1] ||
        bounds[2] > region.bbox[2] ||
        bounds[3] > region.bbox[3]
      ) {
        continue;
      }

      const archive = this.registry.get(artifact.filename);
      if (!archive) continue;

      const maxzoom = typeof artifact.maxzoom === 'number' ? artifact.maxzoom : 11;
      // Cached per artifact so a drag does not rebuild the decode cache on every frame.
      const existing = this.samplers.get(artifact.filename);
      if (existing) return existing;

      const sampler = new TerrainSampler({ archive, maxzoom });
      this.samplers.set(artifact.filename, sampler);
      return sampler;
    }

    return null;
  }

  private readonly samplers = new Map<string, TerrainSampler>();

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
    if (!this.map.getSource('route-geometry')) addRouteLayers(this.map);
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

      const marker = new maplibregl.Marker({ element, draggable: this.active })
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
        if (!this.active) return;
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
            if (!this.active) return;
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
      costing: this.draft.costing,
      waypointCount: this.draft.waypointCount,
      distanceM: this.draft.totalDistanceM,
      pendingLegs: this.draft.pendingLegs().length,
      hasStraightLegs: this.draft.hasStraightLegs(),
      canUndo: this.draft.canUndo,
      profile: this.profile,
      profileNote: this.profileNote,
      follow: this.followState,
      following: this.follower !== null,
    };
  }

  private emit(): void {
    this.onChange(this.summary());
  }
}
