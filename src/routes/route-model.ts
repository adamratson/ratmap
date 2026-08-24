import { distanceMetres, nearestPointOnPath, type LngLat } from './geo';
import type { ComputedLeg } from './router';
import type { Costing } from './path-graph';

// The route being edited, as plain data. No map, no router, no storage — so the editing
// rules (what a drag invalidates, what undo restores, where an inserted waypoint goes) are
// testable without any of that.
//
// C10 lives here: a route *is* its waypoints and its computed leg geometry. There is no
// route id from a server to re-resolve, because there is no server; a saved route renders
// from these arrays with the network permanently off, forever.

export interface Waypoint {
  id: string;
  lng: number;
  lat: number;
  /** Set when the waypoint came from a named summit or search result. */
  name?: string;
  /** Metres, when known at placement time. The profile does not depend on it. */
  ele?: number;
}

/**
 * A leg awaiting computation.
 *
 * `null` rather than a "pending" flag on a leg object: it makes "this geometry is not
 * valid any more" unrepresentable as stale coordinates. A dragged waypoint must never
 * leave the old line on the map claiming to be the route.
 */
export type LegSlot = ComputedLeg | null;

export interface RouteDraftState {
  waypoints: Waypoint[];
  legs: LegSlot[];
  costing: Costing;
}

/** How many edits can be undone. Deep snapshots, so this is a memory bound too. */
const UNDO_DEPTH = 50;

export function newWaypointId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `wp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class RouteDraft {
  private waypoints: Waypoint[] = [];
  private legs: LegSlot[] = [];
  private costingMode: Costing = 'walking';
  private readonly undoStack: RouteDraftState[] = [];

  constructor(state?: Partial<RouteDraftState>) {
    if (state) this.restore({ waypoints: [], legs: [], costing: 'walking', ...state });
  }

  get costing(): Costing {
    return this.costingMode;
  }

  /** Changing costing invalidates every leg — the whole point is that it reroutes. */
  setCosting(costing: Costing): void {
    if (costing === this.costingMode) return;
    this.snapshot();
    this.costingMode = costing;
    this.legs = this.legs.map(() => null);
  }

  getWaypoints(): Waypoint[] {
    return this.waypoints.map((waypoint) => ({ ...waypoint }));
  }

  getLegs(): LegSlot[] {
    return [...this.legs];
  }

  get waypointCount(): number {
    return this.waypoints.length;
  }

  /** Indices of legs that still need computing. */
  pendingLegs(): number[] {
    return this.legs.flatMap((leg, index) => (leg === null ? [index] : []));
  }

  isComplete(): boolean {
    return this.waypoints.length >= 2 && this.legs.every((leg) => leg !== null);
  }

  /** Waypoint pair a leg runs between. */
  legEnds(index: number): [LngLat, LngLat] | null {
    const from = this.waypoints[index];
    const to = this.waypoints[index + 1];
    if (!from || !to) return null;
    return [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ];
  }

  setLeg(index: number, leg: ComputedLeg): void {
    // Guarded because legs arrive asynchronously: a result can land after the waypoint it
    // belonged to was deleted, and writing it back would resurrect a leg that no longer
    // has two ends.
    if (index < 0 || index >= this.legs.length) return;
    this.legs[index] = leg;
  }

  add(point: LngLat, meta: Partial<Waypoint> = {}): Waypoint {
    this.snapshot();
    const waypoint: Waypoint = { id: newWaypointId(), lng: point[0], lat: point[1], ...meta };
    this.waypoints.push(waypoint);
    // The first waypoint starts no leg; every one after it does.
    if (this.waypoints.length > 1) this.legs.push(null);
    return waypoint;
  }

  insertAt(index: number, point: LngLat, meta: Partial<Waypoint> = {}): Waypoint {
    const clamped = Math.max(0, Math.min(index, this.waypoints.length));
    this.snapshot();

    const waypoint: Waypoint = { id: newWaypointId(), lng: point[0], lat: point[1], ...meta };
    this.waypoints.splice(clamped, 0, waypoint);

    if (this.waypoints.length === 1) return waypoint;

    if (clamped === 0) {
      this.legs.unshift(null);
    } else if (clamped >= this.waypoints.length - 1) {
      this.legs.push(null);
    } else {
      // Splitting an existing leg in two: both halves need computing.
      this.legs.splice(clamped - 1, 1, null, null);
    }

    return waypoint;
  }

  /**
   * Insert a waypoint into whichever leg passes closest to `point`.
   *
   * This is what dragging the drawn line does. Choosing the leg by proximity to its actual
   * computed geometry — not to the straight line between its waypoints — is what makes it
   * behave correctly on a route that doubles back on itself, where two legs can have very
   * similar endpoints but run nowhere near each other.
   */
  insertOnLine(point: LngLat, meta: Partial<Waypoint> = {}): Waypoint | null {
    if (this.waypoints.length < 2) return null;

    let bestLeg = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const coords = leg?.coords ?? (this.legEnds(i) as LngLat[] | null);
      if (!coords) continue;
      const nearest = nearestPointOnPath(coords, point);
      if (nearest && nearest.distanceM < bestDistance) {
        bestDistance = nearest.distanceM;
        bestLeg = i;
      }
    }

    return this.insertAt(bestLeg + 1, point, meta);
  }

  /** Move a waypoint, invalidating only the legs that touch it. */
  move(id: string, point: LngLat): boolean {
    const index = this.waypoints.findIndex((waypoint) => waypoint.id === id);
    if (index < 0) return false;

    this.snapshot();
    this.waypoints[index] = { ...this.waypoints[index], lng: point[0], lat: point[1] };
    // A moved waypoint's name came from the place it used to be on.
    delete this.waypoints[index].name;
    delete this.waypoints[index].ele;
    this.invalidateAround(index);
    return true;
  }

  remove(id: string): boolean {
    const index = this.waypoints.findIndex((waypoint) => waypoint.id === id);
    if (index < 0) return false;

    this.snapshot();
    this.waypoints.splice(index, 1);

    if (this.waypoints.length === 0) {
      this.legs = [];
      return true;
    }

    if (index === 0) {
      this.legs.shift();
    } else if (index === this.waypoints.length) {
      this.legs.pop();
    } else {
      // Removing an interior waypoint fuses its two legs into one, which must be recomputed.
      this.legs.splice(index - 1, 2, null);
    }

    return true;
  }

  clear(): void {
    this.snapshot();
    this.waypoints = [];
    this.legs = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.waypoints = previous.waypoints;
    this.legs = previous.legs;
    this.costingMode = previous.costing;
    return true;
  }

  /** Every computed coordinate, end to end. Empty while any leg is still pending. */
  coordinates(): LngLat[] {
    const coords: LngLat[] = [];
    for (const leg of this.legs) {
      if (!leg) continue;
      // Drop the duplicate join: a leg starts where the previous one ended.
      const start = coords.length > 0 && sameCoord(coords[coords.length - 1], leg.coords[0]) ? 1 : 0;
      for (let i = start; i < leg.coords.length; i++) coords.push(leg.coords[i]);
    }

    // A single waypoint has no legs but is still a place on the map.
    if (coords.length === 0 && this.waypoints.length === 1) {
      const only = this.waypoints[0];
      coords.push([only.lng, only.lat]);
    }

    return coords;
  }

  get totalDistanceM(): number {
    return this.legs.reduce((total, leg) => total + (leg?.distanceM ?? 0), 0);
  }

  /** True when any computed leg fell back to a straight line (C11). */
  hasStraightLegs(): boolean {
    return this.legs.some((leg) => leg?.kind === 'straight');
  }

  toState(): RouteDraftState {
    return {
      waypoints: this.getWaypoints(),
      legs: this.legs.map((leg) => (leg ? { ...leg, coords: leg.coords.map(copyCoord) } : null)),
      costing: this.costingMode,
    };
  }

  restore(state: RouteDraftState): void {
    this.waypoints = state.waypoints.map((waypoint) => ({ ...waypoint }));
    this.legs = state.legs.map((leg) =>
      leg ? { ...leg, coords: leg.coords.map(copyCoord) } : null,
    );
    this.costingMode = state.costing;
  }

  private invalidateAround(index: number): void {
    if (index - 1 >= 0) this.legs[index - 1] = null;
    if (index < this.legs.length) this.legs[index] = null;
  }

  private snapshot(): void {
    this.undoStack.push(this.toState());
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }
}

function copyCoord(coord: LngLat): LngLat {
  return [coord[0], coord[1]];
}

function sameCoord(a: LngLat, b: LngLat): boolean {
  // Sub-metre. Legs are joined at the waypoint they share, so exact equality would usually
  // hold — but a snapped leg's endpoint comes back through a projection round-trip.
  return distanceMetres(a, b) < 1;
}
