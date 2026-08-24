import { nearestPointOnPath, pathLengthMetres, type LngLat } from './geo';

// Following a saved route against the GPS dot.
//
// §4 puts this in Phase 4 and notes it "needs no engine" — which is why it is pure
// geometry over the stored coordinate array (C10) and has no dependency on the router, the
// tiles, or the network. A GPX imported from anywhere follows exactly as well as one
// planned here.
//
// §7 applies without softening: **foreground only**. There is no background geolocation on
// any platform, so following means the app is open and the screen is on. The UI has to say
// that rather than implying a capability that does not exist.

export interface FollowState {
  /** Perpendicular distance from the route, metres. */
  offRouteM: number;
  /** True once off-route by more than the threshold — hysteretic, see below. */
  isOffRoute: boolean;
  /** Distance from the route start to the nearest point, metres. */
  alongM: number;
  /** Distance from there to the end, metres. */
  remainingM: number;
  totalM: number;
  /** Progress along the route, 0..1. */
  fraction: number;
  /** The point on the route the position is nearest to. */
  nearest: LngLat;
}

export interface FollowOptions {
  /** Beyond this, report off-route. */
  offRouteM?: number;
  /** Within this, report back on route. Must be below `offRouteM`. */
  rejoinM?: number;
}

/**
 * Two thresholds, not one.
 *
 * With a single threshold, standing at the boundary — which is exactly where someone is
 * when they have just strayed — flips the state on every fix. On a hill that means an
 * alert that fires and clears every few seconds, which people learn to ignore, which
 * defeats the point of having it.
 *
 * The defaults are wide enough not to fire on GPS noise under a crag (a 20-30 m error is
 * ordinary in a steep glen) and tight enough to catch a genuine wrong turn.
 */
const DEFAULT_OFF_ROUTE_M = 60;
const DEFAULT_REJOIN_M = 30;

export class RouteFollower {
  private readonly coords: LngLat[];
  private readonly totalM: number;
  private readonly offRouteThresholdM: number;
  private readonly rejoinThresholdM: number;
  private offRoute = false;

  constructor(coords: readonly LngLat[], options: FollowOptions = {}) {
    this.coords = [...coords];
    this.totalM = pathLengthMetres(this.coords);
    this.offRouteThresholdM = options.offRouteM ?? DEFAULT_OFF_ROUTE_M;
    this.rejoinThresholdM = Math.min(
      options.rejoinM ?? DEFAULT_REJOIN_M,
      options.offRouteM ?? DEFAULT_OFF_ROUTE_M,
    );
  }

  /** Null when there is no route geometry to follow. */
  update(position: LngLat): FollowState | null {
    const nearest = nearestPointOnPath(this.coords, position);
    if (!nearest) return null;

    if (this.offRoute) {
      if (nearest.distanceM <= this.rejoinThresholdM) this.offRoute = false;
    } else if (nearest.distanceM > this.offRouteThresholdM) {
      this.offRoute = true;
    }

    const alongM = Math.min(nearest.alongM, this.totalM);

    return {
      offRouteM: nearest.distanceM,
      isOffRoute: this.offRoute,
      alongM,
      remainingM: Math.max(0, this.totalM - alongM),
      totalM: this.totalM,
      fraction: this.totalM > 0 ? alongM / this.totalM : 0,
      nearest: nearest.point,
    };
  }

  /** Forget the off-route state — for when following restarts on a different route. */
  reset(): void {
    this.offRoute = false;
  }
}
