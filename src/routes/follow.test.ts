import { describe, expect, it } from 'vitest';
import { RouteFollower } from './follow';
import { distanceMetres, pathLengthMetres, type LngLat } from './geo';

// A straight west-to-east line at the equator, so "100 m north" is unambiguous.
const ROUTE: LngLat[] = [
  [0, 0],
  [0.02, 0],
];
const TOTAL = pathLengthMetres(ROUTE);

/** Roughly `metres` north of the line. */
function north(lng: number, metres: number): LngLat {
  return [lng, metres / 111_195];
}

describe('RouteFollower', () => {
  it('reports progress along the route', () => {
    const follower = new RouteFollower(ROUTE);
    const state = follower.update([0.01, 0])!;
    expect(state.alongM).toBeCloseTo(TOTAL / 2, 0);
    expect(state.remainingM).toBeCloseTo(TOTAL / 2, 0);
    expect(state.fraction).toBeCloseTo(0.5, 3);
  });

  it('measures perpendicular distance from the line', () => {
    const follower = new RouteFollower(ROUTE);
    expect(follower.update(north(0.01, 100))!.offRouteM).toBeCloseTo(100, 0);
  });

  it('stays on route within the threshold', () => {
    const follower = new RouteFollower(ROUTE);
    expect(follower.update(north(0.01, 40))!.isOffRoute).toBe(false);
  });

  it('reports off route beyond it', () => {
    const follower = new RouteFollower(ROUTE);
    expect(follower.update(north(0.01, 120))!.isOffRoute).toBe(true);
  });

  it('does not flap at the boundary', () => {
    // The failure this prevents: with one threshold, standing right at it — exactly where
    // someone is when they have just strayed — toggles the alert on every fix.
    const follower = new RouteFollower(ROUTE, { offRouteM: 60, rejoinM: 30 });
    expect(follower.update(north(0.01, 65))!.isOffRoute).toBe(true);
    expect(follower.update(north(0.01, 55))!.isOffRoute).toBe(true);
    expect(follower.update(north(0.01, 45))!.isOffRoute).toBe(true);
    // Only a genuine return to the line clears it.
    expect(follower.update(north(0.01, 20))!.isOffRoute).toBe(false);
  });

  it('clamps progress at the end rather than overshooting', () => {
    const follower = new RouteFollower(ROUTE);
    const state = follower.update([0.03, 0])!;
    expect(state.remainingM).toBe(0);
    expect(state.fraction).toBeLessThanOrEqual(1);
  });

  it('reports no progress before the start', () => {
    const follower = new RouteFollower(ROUTE);
    const state = follower.update([-0.01, 0])!;
    expect(state.alongM).toBe(0);
    expect(state.remainingM).toBeCloseTo(TOTAL, 0);
  });

  it('follows a route that doubles back', () => {
    const outAndBack: LngLat[] = [
      [0, 0],
      [0.02, 0],
      [0, 0],
    ];
    const follower = new RouteFollower(outAndBack);
    const state = follower.update([0.019, 0])!;
    // Near the turn-around, so roughly halfway through the whole walk.
    expect(state.fraction).toBeGreaterThan(0.4);
    expect(state.fraction).toBeLessThan(0.6);
  });

  it('gives the point on the route to draw a leader line to', () => {
    const follower = new RouteFollower(ROUTE);
    const state = follower.update(north(0.01, 100))!;
    expect(distanceMetres(state.nearest, [0.01, 0])).toBeLessThan(1);
  });

  it('returns null with no geometry to follow', () => {
    expect(new RouteFollower([]).update([0, 0])).toBeNull();
  });

  it('handles a single-point route without dividing by zero', () => {
    const state = new RouteFollower([[0, 0]]).update(north(0, 50))!;
    expect(state.fraction).toBe(0);
    expect(state.totalM).toBe(0);
    expect(Number.isFinite(state.offRouteM)).toBe(true);
  });

  it('forgets off-route state on reset', () => {
    const follower = new RouteFollower(ROUTE);
    follower.update(north(0.01, 200));
    follower.reset();
    expect(follower.update(north(0.01, 50))!.isOffRoute).toBe(false);
  });
});
