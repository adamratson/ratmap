import { distanceMetres, nearestPointOnPath, type LngLat } from './geo';
import type { ComputedLeg } from './router';

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
  /**
   * The leg arriving at this waypoint is drawn freehand — a straight line, not routed —
   * because snap to paths was off when that leg was made. Ignored on the first waypoint.
   *
   * Kept on the waypoint rather than the leg because a leg is `null` while it awaits
   * computing: dragging a waypoint would otherwise forget how its legs were drawn, and
   * re-route a freehand leg (or flatten a routed one) according to wherever the switch
   * happens to be now.
   */
  freehand?: boolean;
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
  private readonly undoStack: RouteDraftState[] = [];

  constructor(state?: Partial<RouteDraftState>) {
    if (state) this.restore({ waypoints: [], legs: [], ...state });
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

  /** Whether a leg is routed over the network, rather than drawn freehand. */
  legSnaps(index: number): boolean {
    return this.waypoints[index + 1]?.freehand !== true;
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

  /** Whether the route ends where it starts — a round trip someone has already closed. */
  isLoop(): boolean {
    const first = this.waypoints[0];
    const last = this.waypoints[this.waypoints.length - 1];
    return this.waypoints.length >= 3 && sameCoord([first.lng, first.lat], [last.lng, last.lat]);
  }

  /** Whether {@link closeLoop} has anything to do. */
  canCloseLoop(): boolean {
    return this.waypoints.length >= 2 && !this.isLoop();
  }

  /**
   * Finish back at the start: a new last waypoint on the first one, and a leg to it.
   *
   * A copy of the start, name and all, rather than a reference to it — every other rule
   * here (a drag moves one waypoint, a delete fuses two legs) assumes waypoints are
   * independent, and the finish of a round trip is a place someone may well want to move.
   */
  closeLoop(meta: Partial<Waypoint> = {}): Waypoint | null {
    if (!this.canCloseLoop()) return null;
    const { name, ele, lng, lat } = this.waypoints[0];
    return this.add([lng, lat], {
      ...(name ? { name } : {}),
      ...(typeof ele === 'number' ? { ele } : {}),
      ...meta,
    });
  }

  insertAt(index: number, point: LngLat, meta: Partial<Waypoint> = {}): Waypoint {
    const clamped = Math.max(0, Math.min(index, this.waypoints.length));
    this.snapshot();

    const waypoint: Waypoint = { id: newWaypointId(), lng: point[0], lat: point[1], ...meta };
    this.waypoints.splice(clamped, 0, waypoint);

    if (this.waypoints.length === 1) return waypoint;

    // Every leg this insertion creates is drawn the way the new waypoint asks — including
    // one that arrives at a waypoint already there, which is where that leg's mode lives.
    const freehand = meta.freehand === true;
    if (clamped === 0) {
      this.legs.unshift(null);
      setFreehand(this.waypoints[1], freehand);
    } else if (clamped >= this.waypoints.length - 1) {
      this.legs.push(null);
    } else {
      // Splitting an existing leg in two: both halves need computing.
      this.legs.splice(clamped - 1, 1, null, null);
      setFreehand(this.waypoints[clamped + 1], freehand);
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

  /** True when any computed leg is a straight line — fallen back (C11) or freehand. */
  hasStraightLegs(): boolean {
    return this.legs.some((leg) => leg?.kind === 'straight');
  }

  /** True when any computed leg was drawn freehand on purpose. */
  hasFreehandLegs(): boolean {
    return this.legs.some((leg) => leg?.freehand === true);
  }

  /** True when any computed leg was meant to follow paths and could not (C11). */
  hasUnroutedLegs(): boolean {
    return this.legs.some((leg) => leg?.kind === 'straight' && leg.freehand !== true);
  }

  toState(): RouteDraftState {
    return {
      waypoints: this.getWaypoints(),
      legs: this.legs.map((leg) => (leg ? { ...leg, coords: leg.coords.map(copyCoord) } : null)),
    };
  }

  restore(state: RouteDraftState): void {
    this.waypoints = state.waypoints.map((waypoint) => ({ ...waypoint }));
    this.legs = state.legs.map((leg) =>
      leg ? { ...leg, coords: leg.coords.map(copyCoord) } : null,
    );
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

/** Absent rather than false when routed, so records written before freehand look the same. */
function setFreehand(waypoint: Waypoint, freehand: boolean): void {
  if (freehand) waypoint.freehand = true;
  else delete waypoint.freehand;
}

function copyCoord(coord: LngLat): LngLat {
  return [coord[0], coord[1]];
}

function sameCoord(a: LngLat, b: LngLat): boolean {
  // Sub-metre. Legs are joined at the waypoint they share, so exact equality would usually
  // hold — but a snapped leg's endpoint comes back through a projection round-trip.
  return distanceMetres(a, b) < 1;
}
