import { distanceMetres, type LngLat } from './geo';
import { globalToLngLat, lngLatToGlobal, type PathLine } from './path-tiles';

// The offline router's graph. Built from `PathLine`s decoded out of a downloaded region's
// basemap tiles, so there is no routing engine, no routing artifact and no network call
// anywhere in this file.
//
// Every vertex becomes a node. That is more nodes than a contracted graph needs, but a
// junction in vector-tile geometry *is* a shared vertex — two ways meeting have a
// coordinate in common and nothing else marks the connection — so collapsing the
// intermediate vertices would have to reconstruct exactly the information it discarded.
// At the scale this runs at (one route leg, a few hundred tiles) plain Dijkstra over
// every vertex is fast enough to not be worth the complexity.

/** How the network is weighted. Straight distance is the same either way. */
export type Costing = 'walking' | 'cycling';

/**
 * Cost multipliers on ground distance, by Protomaps `kind` / `kind_detail`.
 *
 * These are travel *preferences*, not impossibilities — a route may use anything in the
 * graph if that is genuinely the only way through. Walking prefers paths and tolerates
 * lanes; cycling inverts most of that and treats steps as something you carry a bike up.
 *
 * Defensible defaults rather than a settled model — the same status as the contour and
 * path styling in `region-layers.ts` (§8.3). Tuning them changes which of two parallel
 * ways a route picks, never whether a route exists.
 */
const WALKING_COST: Record<string, number> = {
  path: 1,
  footway: 1,
  track: 1,
  bridleway: 1,
  cycleway: 1.05,
  // Steps are legitimate on foot but slow, and stack up on a stepped ascent.
  steps: 1.35,
  minor_road: 1.2,
  medium_road: 1.6,
  // Walkable in the legal sense, unpleasant and often dangerous in the real one.
  major_road: 2.2,
};

const CYCLING_COST: Record<string, number> = {
  cycleway: 0.85,
  track: 1.2,
  bridleway: 1.4,
  path: 1.6,
  footway: 2.5,
  // Not barred: a short flight between two rideable sections is a normal thing to push up.
  steps: 6,
  minor_road: 1,
  medium_road: 1.2,
  major_road: 1.8,
};

function costMultiplier(kind: string, detail: string | null, costing: Costing): number {
  const table = costing === 'cycling' ? CYCLING_COST : WALKING_COST;
  return table[detail ?? ''] ?? table[kind] ?? 1.5;
}

/**
 * Node-merge tolerance, in global tile units.
 *
 * Exact key matching is not enough at tile seams. A way crossing a boundary is stored as
 * integers in both tiles, each rounded independently, so the two clipped ends land up to
 * about half a unit apart — near-identical, never equal. Merging within a couple of units
 * (sub-metre on the ground at z15) closes that, and is far below the spacing of any two
 * genuinely distinct path vertices.
 */
const MERGE_TOLERANCE_UNITS = 2;

/** Coarser grid used only for snapping a tapped point to the network. */
const SNAP_CELL_UNITS = 256;

export interface RouteLeg {
  coords: LngLat[];
  distanceM: number;
  /** Names of the ways used, in order, deduplicated. Empty when nothing is named. */
  wayNames: string[];
}

export class PathGraph {
  /** `extent * 2 ** zoom` — the global unit grid these coordinates live on. */
  readonly world: number;

  private readonly nodeX: number[] = [];
  private readonly nodeY: number[] = [];
  private readonly adjacency: number[][] = [];
  private readonly mergeCells = new Map<string, number[]>();
  private snapCells: Map<string, number[]> | null = null;

  private readonly edgeA: number[] = [];
  private readonly edgeB: number[] = [];
  private readonly edgeLengthM: number[] = [];
  private readonly edgeKind: string[] = [];
  private readonly edgeDetail: (string | null)[] = [];
  private readonly edgeName: (string | null)[] = [];

  constructor(world: number) {
    this.world = world;
  }

  get nodeCount(): number {
    return this.nodeX.length;
  }

  get edgeCount(): number {
    return this.edgeA.length;
  }

  /** Add one decoded, tile-clipped way. Safe to call with overlapping duplicates. */
  addLine(line: PathLine): void {
    const { coords } = line;
    if (coords.length < 4) return;

    let previous = this.nodeAt(coords[0], coords[1]);
    for (let i = 2; i < coords.length; i += 2) {
      const node = this.nodeAt(coords[i], coords[i + 1]);
      if (node !== previous) {
        this.addEdge(previous, node, line);
        previous = node;
      }
    }
    // Any change to the node set invalidates the snap index.
    this.snapCells = null;
  }

  private nodeAt(gx: number, gy: number): number {
    const cx = Math.floor(gx / MERGE_TOLERANCE_UNITS);
    const cy = Math.floor(gy / MERGE_TOLERANCE_UNITS);

    // Search the 3x3 neighbourhood, not just the containing cell: two points a hair apart
    // can still fall either side of a cell boundary, which is precisely the seam case
    // this exists to fix.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.mergeCells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const id of bucket) {
          if (Math.hypot(this.nodeX[id] - gx, this.nodeY[id] - gy) <= MERGE_TOLERANCE_UNITS) {
            return id;
          }
        }
      }
    }

    const id = this.nodeX.length;
    this.nodeX.push(gx);
    this.nodeY.push(gy);
    this.adjacency.push([]);

    const key = `${cx}:${cy}`;
    const bucket = this.mergeCells.get(key);
    if (bucket) bucket.push(id);
    else this.mergeCells.set(key, [id]);

    return id;
  }

  private addEdge(a: number, b: number, line: PathLine): void {
    // Adjacent tiles both carry the buffer copy of a shared way, so the same edge arrives
    // twice. Duplicates would not change the route, but they double the graph.
    for (const edge of this.adjacency[a]) {
      if (this.edgeA[edge] === b || this.edgeB[edge] === b) return;
    }

    const id = this.edgeA.length;
    this.edgeA.push(a);
    this.edgeB.push(b);
    this.edgeLengthM.push(distanceMetres(this.nodeLngLat(a), this.nodeLngLat(b)));
    this.edgeKind.push(line.kind);
    this.edgeDetail.push(line.kindDetail);
    this.edgeName.push(line.name);
    this.adjacency[a].push(id);
    this.adjacency[b].push(id);
  }

  nodeLngLat(id: number): LngLat {
    return globalToLngLat(this.nodeX[id], this.nodeY[id], this.world);
  }

  /**
   * Nearest network node to a point, or null if nothing is within `maxDistanceM`.
   *
   * Nearest *vertex*, not nearest point along an edge. Tile vertices at z15 sit roughly
   * every 15 m, so the snap is off by at most half that — well inside the accuracy of the
   * tap that produced the query, and it keeps the graph immutable during a route request.
   */
  snap(point: LngLat, maxDistanceM: number): number | null {
    const index = this.snapIndex();
    const [gx, gy] = lngLatToGlobal(point[0], point[1], this.world);
    const cx = Math.floor(gx / SNAP_CELL_UNITS);
    const cy = Math.floor(gy / SNAP_CELL_UNITS);

    // Widen the ring until something is found or the search box exceeds the radius.
    const maxRings = Math.max(1, Math.ceil(metresToUnits(maxDistanceM, point[1], this.world) / SNAP_CELL_UNITS));

    let best: number | null = null;
    let bestDistance = maxDistanceM;
    let foundAtRing = -1;

    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          // Only the newly-added perimeter — inner cells were covered by earlier rings.
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          for (const id of index.get(`${cx + dx}:${cy + dy}`) ?? []) {
            const distance = distanceMetres(point, this.nodeLngLat(id));
            if (distance < bestDistance) {
              bestDistance = distance;
              best = id;
              if (foundAtRing < 0) foundAtRing = ring;
            }
          }
        }
      }
      // Search one ring past the first hit before stopping. Rings are measured in cells,
      // not metres, so a node in the next ring out can still be closer — the corner of
      // ring k reaches further than the edge of ring k+1. Stopping on the hit itself
      // (rather than one ring later) quietly returns the second-nearest node.
      if (foundAtRing >= 0 && ring > foundAtRing) break;
    }

    return best;
  }

  private snapIndex(): Map<string, number[]> {
    if (this.snapCells) return this.snapCells;

    const cells = new Map<string, number[]>();
    for (let id = 0; id < this.nodeX.length; id++) {
      const key = `${Math.floor(this.nodeX[id] / SNAP_CELL_UNITS)}:${Math.floor(this.nodeY[id] / SNAP_CELL_UNITS)}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(id);
      else cells.set(key, [id]);
    }

    this.snapCells = cells;
    return cells;
  }

  /**
   * Shortest weighted path between two nodes, or null when they are not connected.
   *
   * Null is a normal outcome, not a failure: the two sides of a river or a route leg that
   * leaves the downloaded region are genuinely unconnected in this graph, and the planner
   * answers that with a straight-line leg (C11) rather than refusing the waypoint.
   */
  route(startNode: number, endNode: number, costing: Costing = 'walking'): RouteLeg | null {
    if (startNode === endNode) {
      return { coords: [this.nodeLngLat(startNode)], distanceM: 0, wayNames: [] };
    }

    const best = new Float64Array(this.nodeX.length).fill(Infinity);
    const cameFromEdge = new Int32Array(this.nodeX.length).fill(-1);
    const settled = new Uint8Array(this.nodeX.length);
    const queue = new MinHeap();

    best[startNode] = 0;
    queue.push(startNode, 0);

    while (queue.size > 0) {
      const node = queue.pop()!;
      if (settled[node]) continue;
      settled[node] = 1;
      if (node === endNode) break;

      for (const edge of this.adjacency[node]) {
        const next = this.edgeA[edge] === node ? this.edgeB[edge] : this.edgeA[edge];
        if (settled[next]) continue;

        const cost =
          best[node] +
          this.edgeLengthM[edge] *
            costMultiplier(this.edgeKind[edge], this.edgeDetail[edge], costing);

        if (cost < best[next]) {
          best[next] = cost;
          cameFromEdge[next] = edge;
          queue.push(next, cost);
        }
      }
    }

    if (!settled[endNode]) return null;

    const coords: LngLat[] = [];
    const names: string[] = [];
    let distanceM = 0;

    for (let node = endNode; node !== startNode; ) {
      const edge = cameFromEdge[node];
      if (edge < 0) return null;
      coords.push(this.nodeLngLat(node));
      distanceM += this.edgeLengthM[edge];
      const name = this.edgeName[edge];
      if (name && names[names.length - 1] !== name) names.push(name);
      node = this.edgeA[edge] === node ? this.edgeB[edge] : this.edgeA[edge];
    }
    coords.push(this.nodeLngLat(startNode));

    coords.reverse();
    names.reverse();

    // Consecutive duplicates can survive the reverse when a route leaves a named way and
    // rejoins it; collapse them so the description reads as a walker would say it.
    const wayNames = names.filter((name, i) => name !== names[i - 1]);

    return { coords, distanceM, wayNames };
  }

  /** Convenience: snap both ends and route between them in one call. */
  routeBetween(
    from: LngLat,
    to: LngLat,
    options: { costing?: Costing; maxSnapM?: number } = {},
  ): RouteLeg | null {
    const maxSnapM = options.maxSnapM ?? 150;
    const startNode = this.snap(from, maxSnapM);
    const endNode = this.snap(to, maxSnapM);
    if (startNode === null || endNode === null) return null;
    return this.route(startNode, endNode, options.costing ?? 'walking');
  }
}

function metresToUnits(metres: number, lat: number, world: number): number {
  const metresPerUnit = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / world;
  return metres / metresPerUnit;
}

/**
 * Binary min-heap keyed by cost.
 *
 * A sorted array or a linear scan makes Dijkstra quadratic, which is invisible on the
 * handful of nodes a unit test uses and unusable on the ~10^5 a real route leg produces.
 */
class MinHeap {
  private readonly items: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.priorities.push(priority);

    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPriority = this.priorities.pop()!;

    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;

      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) {
          smallest = left;
        }
        if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }

    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
  }
}
