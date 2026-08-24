import { describe, expect, it } from 'vitest';
import { RouteDraft } from './route-model';
import type { ComputedLeg } from './router';
import type { LngLat } from './geo';

const A: LngLat = [-5.08, 56.81];
const B: LngLat = [-5.04, 56.8];
const C: LngLat = [-5.0, 56.797];

function leg(coords: LngLat[], kind: ComputedLeg['kind'] = 'snapped'): ComputedLeg {
  return { coords, distanceM: 1000, kind, wayNames: [] };
}

/** Fill every pending leg with a straight two-point stand-in for the router's answer. */
function computeAll(draft: RouteDraft, kind: ComputedLeg['kind'] = 'snapped'): void {
  for (const index of draft.pendingLegs()) {
    const ends = draft.legEnds(index)!;
    draft.setLeg(index, leg([ends[0], ends[1]], kind));
  }
}

describe('RouteDraft.add', () => {
  it('starts no leg for the first waypoint', () => {
    const draft = new RouteDraft();
    draft.add(A);
    expect(draft.waypointCount).toBe(1);
    expect(draft.pendingLegs()).toEqual([]);
  });

  it('adds a pending leg for each waypoint after the first', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    expect(draft.pendingLegs()).toEqual([0, 1]);
  });

  it('commits the waypoint before any leg is computed (C11)', () => {
    // The constraint in full: placement must not wait on a successful snap, or editing
    // with no usable network becomes impossible.
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    expect(draft.getWaypoints()).toHaveLength(2);
    expect(draft.isComplete()).toBe(false);
  });
});

describe('RouteDraft.move', () => {
  it('invalidates only the legs touching the moved waypoint', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    draft.add([-4.96, 56.79]);
    computeAll(draft);

    const middle = draft.getWaypoints()[1];
    draft.move(middle.id, [-5.05, 56.805]);

    expect(draft.pendingLegs()).toEqual([0, 1]);
  });

  it('drops a name that belonged to the old position', () => {
    const draft = new RouteDraft();
    const waypoint = draft.add(A, { name: 'Ben Nevis', ele: 1345 });
    draft.add(B);
    draft.move(waypoint.id, B);
    expect(draft.getWaypoints()[0].name).toBeUndefined();
    expect(draft.getWaypoints()[0].ele).toBeUndefined();
  });

  it('reports an unknown id rather than moving something else', () => {
    const draft = new RouteDraft();
    draft.add(A);
    expect(draft.move('nope', B)).toBe(false);
  });
});

describe('RouteDraft.remove', () => {
  it('fuses the two legs either side of an interior waypoint', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    computeAll(draft);

    draft.remove(draft.getWaypoints()[1].id);

    expect(draft.waypointCount).toBe(2);
    expect(draft.getLegs()).toHaveLength(1);
    expect(draft.pendingLegs()).toEqual([0]);
  });

  it('drops the trailing leg when the last waypoint goes', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    computeAll(draft);

    draft.remove(draft.getWaypoints()[2].id);

    expect(draft.getLegs()).toHaveLength(1);
    expect(draft.isComplete()).toBe(true);
  });

  it('drops the leading leg when the first waypoint goes', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    computeAll(draft);

    draft.remove(draft.getWaypoints()[0].id);

    expect(draft.getLegs()).toHaveLength(1);
    expect(draft.isComplete()).toBe(true);
  });

  it('leaves no legs behind when the last waypoint is removed', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.remove(draft.getWaypoints()[0].id);
    expect(draft.getLegs()).toEqual([]);
  });
});

describe('RouteDraft.insertOnLine', () => {
  it('splits the leg the point is nearest to', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    computeAll(draft);

    // Just off the second leg.
    draft.insertOnLine([-5.02, 56.7985]);

    expect(draft.waypointCount).toBe(4);
    expect(draft.getWaypoints()[2].lng).toBeCloseTo(-5.02, 6);
    expect(draft.pendingLegs()).toEqual([1, 2]);
  });

  it('picks the leg by its real geometry, not by its endpoints', () => {
    // An out-and-back: both legs share endpoints, but only the first one goes north.
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(C);
    draft.add(A);
    const north: LngLat = [-5.04, 56.83];
    const south: LngLat = [-5.04, 56.77];
    draft.setLeg(0, leg([A, north, C]));
    draft.setLeg(1, leg([C, south, A]));

    draft.insertOnLine([-5.04, 56.769]);

    // Nearest to the southern return leg, so it must land *after* the turn-around point
    // at C — position 2 — not between A and C where the endpoints alone would put it.
    expect(draft.waypointCount).toBe(4);
    expect(draft.getWaypoints()[2].lng).toBeCloseTo(-5.04, 6);
    expect(draft.getWaypoints()[2].lat).toBeCloseTo(56.769, 6);
  });

  it('does nothing with fewer than two waypoints', () => {
    const draft = new RouteDraft();
    draft.add(A);
    expect(draft.insertOnLine(B)).toBeNull();
  });
});

describe('RouteDraft.undo', () => {
  it('restores the previous waypoint set', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    expect(draft.undo()).toBe(true);
    expect(draft.waypointCount).toBe(2);
  });

  it('restores computed geometry, not just waypoints', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    computeAll(draft);
    expect(draft.isComplete()).toBe(true);

    draft.add(C);
    draft.undo();

    // The leg that was already computed must come back computed — otherwise every undo
    // triggers a pointless reroute of geometry that was never invalidated.
    expect(draft.isComplete()).toBe(true);
  });

  it('reports nothing to undo on a fresh draft', () => {
    const draft = new RouteDraft();
    expect(draft.canUndo).toBe(false);
    expect(draft.undo()).toBe(false);
  });

  it('undoes a delete', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.remove(draft.getWaypoints()[0].id);
    draft.undo();
    expect(draft.waypointCount).toBe(2);
  });
});

describe('RouteDraft.coordinates', () => {
  it('joins legs without repeating the shared waypoint', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    draft.setLeg(0, leg([A, B]));
    draft.setLeg(1, leg([B, C]));
    expect(draft.coordinates()).toEqual([A, B, C]);
  });

  it('renders a lone waypoint as a single position', () => {
    const draft = new RouteDraft();
    draft.add(A);
    expect(draft.coordinates()).toEqual([A]);
  });

  it('sums leg distances', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.add(C);
    computeAll(draft);
    expect(draft.totalDistanceM).toBe(2000);
  });

  it('flags a route that fell back to straight legs', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    computeAll(draft, 'straight');
    expect(draft.hasStraightLegs()).toBe(true);
  });
});

describe('RouteDraft.setCosting', () => {
  it('invalidates every leg, because that is the point', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    computeAll(draft);
    draft.setCosting('cycling');
    expect(draft.pendingLegs()).toEqual([0]);
  });

  it('does nothing when set to the mode already in use', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    computeAll(draft);
    draft.setCosting('walking');
    expect(draft.pendingLegs()).toEqual([]);
  });
});

describe('RouteDraft state round-trip', () => {
  it('restores to an independent copy', () => {
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    computeAll(draft);

    const state = draft.toState();
    const restored = new RouteDraft(state);
    // Mutating the source must not reach through into the copy — saved routes are
    // irreplaceable user data and aliasing them is how they get corrupted.
    draft.add(C);

    expect(restored.waypointCount).toBe(2);
    expect(restored.isComplete()).toBe(true);
  });
});

describe('RouteDraft.setLeg', () => {
  it('discards a result whose leg no longer exists', () => {
    // Legs are computed asynchronously; a result can land after its waypoint was deleted.
    const draft = new RouteDraft();
    draft.add(A);
    draft.add(B);
    draft.remove(draft.getWaypoints()[1].id);
    draft.setLeg(0, leg([A, B]));
    expect(draft.getLegs()).toEqual([]);
  });
});
