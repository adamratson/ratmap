import { describe, expect, it } from 'vitest';
import { PathGraph } from './path-graph';
import { globalToLngLat, lngLatToGlobal, type PathLine } from './path-tiles';
import { distanceMetres, type LngLat } from './geo';

// Real zoom and extent from the built region archives (z15, extent 4096), so the unit
// tolerances under test are the ones the app actually runs with.
const WORLD = 4096 * 2 ** 15;

/** Build a PathLine from [lng, lat] pairs, the way a decoded tile would supply it. */
function line(points: LngLat[], props: Partial<PathLine> = {}): PathLine {
  const coords: number[] = [];
  for (const [lng, lat] of points) {
    const [gx, gy] = lngLatToGlobal(lng, lat, WORLD);
    // Tile geometry is integral; rounding here keeps the fixtures honest about that.
    coords.push(Math.round(gx), Math.round(gy));
  }
  return { coords, kind: 'path', kindDetail: 'path', name: null, ...props };
}

const A: LngLat = [-5.01, 56.79];
const B: LngLat = [-5.0, 56.79];
const C: LngLat = [-4.99, 56.79];

describe('PathGraph.addLine', () => {
  it('makes a node per vertex and an edge per segment', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B, C]));
    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
  });

  it('shares a node where two ways meet at the same vertex', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B]));
    graph.addLine(line([B, C]));
    expect(graph.nodeCount).toBe(3);
    expect(graph.route(0, 2)).not.toBeNull();
  });

  it('stitches ends that a tile seam left a fraction of a unit apart', () => {
    // The failure this guards: adjacent tiles round the same crossing independently, so
    // the two clipped ends are near-identical and never equal. Without the merge
    // tolerance the router treats one continuous path as two, and silently refuses to
    // cross every tile boundary.
    const graph = new PathGraph(WORLD);
    const first = line([A, B]);
    const second = line([B, C]);
    second.coords[0] += 1;
    second.coords[1] -= 1;

    graph.addLine(first);
    graph.addLine(second);

    expect(graph.nodeCount).toBe(3);
    const leg = graph.route(0, 2);
    expect(leg).not.toBeNull();
    expect(leg!.coords).toHaveLength(3);
  });

  it('keeps genuinely separate vertices separate', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B]));
    graph.addLine(line([[-5.0, 56.795], C]));
    expect(graph.nodeCount).toBe(4);
    expect(graph.route(0, 3)).toBeNull();
  });

  it('does not double the graph when two tiles carry the same way', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B, C]));
    graph.addLine(line([A, B, C]));
    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
  });

  it('ignores a line with only one vertex', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A]));
    expect(graph.nodeCount).toBe(0);
  });
});

describe('PathGraph.route', () => {
  it('measures ground distance, not graph cost', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B, C]));
    const leg = graph.route(0, 2)!;
    // Cost multipliers must not leak into the reported distance — this is the number a
    // walker plans their day around.
    expect(leg.distanceM).toBeCloseTo(distanceMetres(A, B) + distanceMetres(B, C), 0);
  });

  it('returns null between disconnected components', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B]));
    graph.addLine(line([[-4.9, 56.79], [-4.89, 56.79]]));
    expect(graph.route(0, 2)).toBeNull();
  });

  it('returns the start alone for a zero-length request', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B]));
    const leg = graph.route(0, 0)!;
    expect(leg.distanceM).toBe(0);
    expect(leg.coords).toHaveLength(1);
  });

  it('prefers a path over a parallel main road on foot', () => {
    const graph = new PathGraph(WORLD);
    const detourNorth: LngLat = [-5.0, 56.7925];
    // Slightly *longer* on the ground, so only the costing can prefer it.
    graph.addLine(line([A, detourNorth, C], { kind: 'path', kindDetail: 'path' }));
    graph.addLine(line([A, B, C], { kind: 'major_road', kindDetail: null }));

    const leg = graph.routeBetween(A, C, { costing: 'walking' })!;
    expect(leg).not.toBeNull();
    expect(leg.distanceM).toBeGreaterThan(distanceMetres(A, C));
  });

  it('prefers the road over a footway on a bike', () => {
    const graph = new PathGraph(WORLD);
    const detourNorth: LngLat = [-5.0, 56.7925];
    graph.addLine(line([A, detourNorth, C], { kind: 'path', kindDetail: 'footway' }));
    graph.addLine(line([A, B, C], { kind: 'minor_road', kindDetail: null }));

    const leg = graph.routeBetween(A, C, { costing: 'cycling' })!;
    expect(leg.distanceM).toBeCloseTo(distanceMetres(A, B) + distanceMetres(B, C), 0);
  });

  it('reports the names of the ways used', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B], { name: 'Ben Nevis Mountain Path' }));
    graph.addLine(line([B, C], { name: 'Carn Mor Dearg Arete' }));
    const leg = graph.route(0, 2)!;
    expect(leg.wayNames).toEqual(['Ben Nevis Mountain Path', 'Carn Mor Dearg Arete']);
  });
});

describe('PathGraph.snap', () => {
  it('finds the nearest node within the radius', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B, C]));
    const node = graph.snap([-5.0001, 56.7901], 200);
    expect(node).not.toBeNull();
    const snapped = graph.nodeLngLat(node!);
    expect(distanceMetres(snapped, B)).toBeLessThan(30);
  });

  it('returns null when nothing is close enough', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B, C]));
    // Roughly 5 km north of the network.
    expect(graph.snap([-5.0, 56.835], 150)).toBeNull();
  });

  it('refuses to snap across a wide gap rather than inventing a start point', () => {
    const graph = new PathGraph(WORLD);
    graph.addLine(line([A, B]));
    expect(graph.routeBetween(A, [-4.8, 56.79], { maxSnapM: 150 })).toBeNull();
  });
});

describe('PathGraph.routeBetween connectivity-aware snap', () => {
  it('skips an isolated stub for a connected node a little further out', () => {
    const graph = new PathGraph(WORLD);

    // A short dead-end lane, ~4 m from the tapped point — nothing routes from it.
    const tap: LngLat = [-5.005, 56.79];
    const stub: LngLat = [-5.00495, 56.79002];
    graph.addLine(line([stub, [-5.0049, 56.79004]]));
    expect(distanceMetres(tap, stub)).toBeLessThan(5);

    // The real network, further away but still well within the snap radius.
    const real1: LngLat = [-5.0035, 56.79];
    const real2: LngLat = [-5.0005, 56.79];
    graph.addLine(line([real1, real2]));
    expect(distanceMetres(tap, real1)).toBeLessThan(150);

    // Plain nearest-vertex snap would land on the stub and find nothing.
    const nearest = graph.snap(tap, 150)!;
    expect(distanceMetres(graph.nodeLngLat(nearest), stub)).toBeLessThan(1);

    const leg = graph.routeBetween(tap, real2, { maxSnapM: 150 });
    expect(leg).not.toBeNull();
  });

  it('picks the pair with the shortest route, not the pair with the shortest snap', () => {
    const graph = new PathGraph(WORLD);

    // The single nearest candidate to `tap` only reaches the junction by a ~5 km detour.
    const tap: LngLat = [-5.005, 56.79];
    const nodeA: LngLat = [-5.00495, 56.79002];
    const detour1: LngLat = [-4.98, 56.8];
    const detour2: LngLat = [-4.97, 56.79];
    const junction: LngLat = [-5.003, 56.7902];
    graph.addLine(line([nodeA, detour1, detour2, junction]));
    expect(distanceMetres(tap, nodeA)).toBeLessThan(5);

    // A candidate ~13 m further from `tap` reaches the same junction directly, in ~110 m.
    const nodeB: LngLat = [-5.0048, 56.7901];
    graph.addLine(line([nodeB, junction]));
    expect(distanceMetres(tap, nodeB)).toBeLessThan(20);
    expect(distanceMetres(nodeB, junction)).toBeLessThan(150);

    const target: LngLat = [-5.0029, 56.7902];
    const leg = graph.routeBetween(tap, target, { maxSnapM: 150 })!;
    expect(leg).not.toBeNull();
    // The detour route is ~5 km; picking the direct one keeps this well under 1 km.
    expect(leg.distanceM).toBeLessThan(1000);
  });
});

describe('PathGraph gap bridging', () => {
  it('links two features a genuine mapping gap apart into one route', () => {
    const graph = new PathGraph(WORLD);
    // Two lanes traced independently that end a few metres short of touching —
    // the same shape as a driveway that never got a shared vertex with its street.
    const gapEnd: LngLat = [-5.0, 56.79005];
    const acrossGap: LngLat = [-5.0, 56.78997];
    expect(distanceMetres(gapEnd, acrossGap)).toBeLessThan(20);

    graph.addLine(line([A, gapEnd]));
    graph.addLine(line([acrossGap, C]));

    expect(graph.route(0, 3)).not.toBeNull();
  });

  it('does not bridge a gap wide enough to be a genuinely different road', () => {
    const graph = new PathGraph(WORLD);
    const farEnd: LngLat = [-5.0, 56.795];
    const farAcross: LngLat = [-5.0, 56.7965];
    expect(distanceMetres(farEnd, farAcross)).toBeGreaterThan(20);

    graph.addLine(line([A, farEnd]));
    graph.addLine(line([farAcross, C]));

    expect(graph.route(0, 3)).toBeNull();
  });
});

describe('global unit conversion', () => {
  it('round-trips a coordinate', () => {
    const [gx, gy] = lngLatToGlobal(-5.0037, 56.7969, WORLD);
    const [lng, lat] = globalToLngLat(gx, gy, WORLD);
    expect(lng).toBeCloseTo(-5.0037, 9);
    expect(lat).toBeCloseTo(56.7969, 9);
  });

  it('keeps one tile unit under a metre at z15', () => {
    const [gx, gy] = lngLatToGlobal(-5.0037, 56.7969, WORLD);
    const shifted = globalToLngLat(gx + 1, gy, WORLD);
    expect(distanceMetres(globalToLngLat(gx, gy, WORLD), shifted)).toBeLessThan(1);
  });
});
