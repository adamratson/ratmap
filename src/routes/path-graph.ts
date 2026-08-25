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

/**
 * Cost multipliers on ground distance, by Protomaps `kind` / `kind_detail`.
 *
 * These are travel *preferences*, not impossibilities — a route may use anything in the
 * graph if that is genuinely the only way through. Walking prefers paths and tolerates
 * lanes.
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

function costMultiplier(kind: string, detail: string | null): number {
  return WALKING_COST[detail ?? ''] ?? WALKING_COST[kind] ?? 1.5;
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

/** How many nearby candidates `routeBetween` checks per end before giving up on a snap. */
const SNAP_CANDIDATE_LIMIT = 8;

/**
 * Real-world gap a dead end may be bridged across, in metres.
 *
 * The basemap's road geometry is Protomaps' upstream build (C13) — not ours to fix — and
 * imprecise OSM digitisation routinely leaves a driveway or lane ending short of the road
 * it obviously joins: two features traced independently (different imagery, different
 * survey) that were never given a shared vertex. Verified against a real case in the
 * Montenegro region (2026-08-24): a residential lane's mapped end sat 16 m from the nearest
 * vertex of the surrounding street grid, itself only ~5 m from the tapped point — visually
 * one junction, topologically two islands, so every route touching that exact spot reported
 * unroutable. A defensible default, the same status as the cost multipliers above: generous
 * enough to close a gap like that one, not so generous it would stitch two genuinely
 * separate roads a block apart.
 */
const GAP_BRIDGE_M = 20;

/** How many nearby nodes `bridgeGaps` considers per dead end before picking the closest. */
const GAP_BRIDGE_CANDIDATE_LIMIT = 6;

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

  /**
   * Union-find over nodes, kept live as edges arrive.
   *
   * Lets `routeBetween` reject a snap candidate without running Dijkstra: a village's
   * street grid routinely has a short dead-end stub (a driveway, a cul-de-sac) sitting
   * closer to a tapped point than the connected network a few metres further out. Nearest
   * vertex alone would snap onto the stub and report the whole leg unroutable even though a
   * real route exists just outside that first guess.
   */
  private readonly parent: number[] = [];
  /** Set once `bridgeGaps()` has run — it's a one-time pass, not a per-query search. */
  private gapsBridged = false;

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
    // Any change to the node set invalidates the snap index and the gap bridging, which
    // is keyed off the dead ends this line may have just added or resolved.
    this.snapCells = null;
    this.gapsBridged = false;
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
    this.parent.push(id);

    const key = `${cx}:${cy}`;
    const bucket = this.mergeCells.get(key);
    if (bucket) bucket.push(id);
    else this.mergeCells.set(key, [id]);

    return id;
  }

  private addEdge(a: number, b: number, line: PathLine): void {
    this.union(a, b);

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

  /**
   * Every network node within `maxDistanceM` of a point, nearest first, capped at `limit`.
   *
   * Feeds `routeBetween`'s connectivity check — `snap()` alone always commits to the single
   * closest vertex, which is exactly wrong when that vertex is a short dead-end stub and the
   * real network is only a little further out but still in range.
   */
  private nearestCandidates(
    point: LngLat,
    maxDistanceM: number,
    limit: number,
  ): { id: number; distanceM: number }[] {
    const index = this.snapIndex();
    const [gx, gy] = lngLatToGlobal(point[0], point[1], this.world);
    const cx = Math.floor(gx / SNAP_CELL_UNITS);
    const cy = Math.floor(gy / SNAP_CELL_UNITS);
    const maxRings = Math.max(1, Math.ceil(metresToUnits(maxDistanceM, point[1], this.world) / SNAP_CELL_UNITS));

    const found: { id: number; distanceM: number }[] = [];
    for (let dx = -maxRings; dx <= maxRings; dx++) {
      for (let dy = -maxRings; dy <= maxRings; dy++) {
        for (const id of index.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const distanceM = distanceMetres(point, this.nodeLngLat(id));
          if (distanceM <= maxDistanceM) found.push({ id, distanceM });
        }
      }
    }

    found.sort((a, b) => a.distanceM - b.distanceM);
    found.length = Math.min(found.length, limit);
    return found;
  }

  /** Union-find lookup, with path compression. */
  private find(id: number): number {
    while (this.parent[id] !== id) {
      this.parent[id] = this.parent[this.parent[id]];
      id = this.parent[id];
    }
    return id;
  }

  private union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }

  /**
   * Link each dead end to the nearest node of a different component within `GAP_BRIDGE_M`
   * — see the constant's own comment for why this is needed at all. The far side need not
   * be a dead end itself: a driveway's mapped end typically wants to join the nearest point
   * of the street it approaches, which is usually an ordinary vertex or junction on that
   * street, not another loose end that happens to stop at the same spot.
   *
   * Runs once, lazily, before the first `route()`/`routeBetween()` call: gap distances need
   * every tile in the leg decoded first, so there is no earlier point where "final" degree
   * is known. Each dead end bridges to its single nearest opposite-component match, not
   * every one in range — a defensible default, not a claim that it finds the one true
   * missing link.
   */
  private bridgeGaps(): void {
    if (this.gapsBridged) return;
    this.gapsBridged = true;

    const deadEnds: number[] = [];
    for (let id = 0; id < this.nodeX.length; id++) {
      if (this.adjacency[id].length === 1) deadEnds.push(id);
    }

    for (const id of deadEnds) {
      // An earlier bridge in this same pass may already have resolved this one.
      if (this.adjacency[id].length !== 1) continue;

      const root = this.find(id);
      const candidates = this.nearestCandidates(this.nodeLngLat(id), GAP_BRIDGE_M, GAP_BRIDGE_CANDIDATE_LIMIT);
      const match = candidates.find((candidate) => candidate.id !== id && this.find(candidate.id) !== root);
      if (match) this.addGapEdge(id, match.id, match.distanceM);
    }
  }

  /** A synthetic edge from `bridgeGaps()`. Costed like anything else unlisted — see costMultiplier. */
  private addGapEdge(a: number, b: number, lengthM: number): void {
    this.union(a, b);
    const id = this.edgeA.length;
    this.edgeA.push(a);
    this.edgeB.push(b);
    this.edgeLengthM.push(lengthM);
    this.edgeKind.push('gap');
    this.edgeDetail.push(null);
    this.edgeName.push(null);
    this.adjacency[a].push(id);
    this.adjacency[b].push(id);
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
  route(startNode: number, endNode: number): RouteLeg | null {
    this.bridgeGaps();

    if (startNode === endNode) {
      return { coords: [this.nodeLngLat(startNode)], distanceM: 0, wayNames: [] };
    }

    const { cost, cameFromEdge } = this.dijkstra(startNode, endNode);
    if (!Number.isFinite(cost[endNode])) return null;
    return this.reconstructPath(startNode, endNode, cameFromEdge);
  }

  /**
   * Single-source Dijkstra from `startNode`.
   *
   * Returns the full shortest-path tree (cost to every reached node, plus the edge each
   * arrived by) rather than one distance — `routeBetween` needs to compare several
   * candidate end nodes against the *same* run, not re-search the graph once per pair.
   * Pass `target` to stop as soon as it settles, the way a single fixed pair (`route()`)
   * always could; omit it to run to exhaustion for a multi-target scan.
   */
  private dijkstra(
    startNode: number,
    target?: number,
  ): { cost: Float64Array; cameFromEdge: Int32Array } {
    const cost = new Float64Array(this.nodeX.length).fill(Infinity);
    const cameFromEdge = new Int32Array(this.nodeX.length).fill(-1);
    const settled = new Uint8Array(this.nodeX.length);
    const queue = new MinHeap();

    cost[startNode] = 0;
    queue.push(startNode, 0);

    while (queue.size > 0) {
      const node = queue.pop()!;
      if (settled[node]) continue;
      settled[node] = 1;
      if (node === target) break;

      for (const edge of this.adjacency[node]) {
        const next = this.edgeA[edge] === node ? this.edgeB[edge] : this.edgeA[edge];
        if (settled[next]) continue;

        const nextCost =
          cost[node] +
          this.edgeLengthM[edge] * costMultiplier(this.edgeKind[edge], this.edgeDetail[edge]);

        if (nextCost < cost[next]) {
          cost[next] = nextCost;
          cameFromEdge[next] = edge;
          queue.push(next, nextCost);
        }
      }
    }

    return { cost, cameFromEdge };
  }

  /** Walk a Dijkstra tree back from `endNode` to `startNode` into ground-distance coordinates. */
  private reconstructPath(startNode: number, endNode: number, cameFromEdge: Int32Array): RouteLeg | null {
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

  /**
   * Snap both ends and route between them in one call.
   *
   * Does not just take the single nearest vertex at each end (that's `snap()`) — it tries
   * up to `SNAP_CANDIDATE_LIMIT` nearby nodes per end and picks the pair with the shortest
   * *actual route*, not the pair with the shortest snap-in-plus-snap-out distance. Those
   * are not the same thing: the nearest vertex at each end is sometimes connected only by
   * a long way around (a switchback further up the hill, a loop through the next village),
   * while a vertex a little further from the tap connects by a direct, short path. Ranking
   * candidates on snap distance alone picked routes that were technically connected but
   * absurdly circuitous — confirmed against a real case (2026-08-24) where the nearest-snap
   * pair produced a 2.4 km route between two points 200 m apart, and a pair 12 m worse on
   * snap distance produced the 190 m route that was obviously the right one.
   */
  routeBetween(from: LngLat, to: LngLat, options: { maxSnapM?: number } = {}): RouteLeg | null {
    // Must happen before the component check below, not just inside route(): bridging can
    // merge the very components this method is about to compare.
    this.bridgeGaps();

    const maxSnapM = options.maxSnapM ?? 150;
    const startCandidates = this.nearestCandidates(from, maxSnapM, SNAP_CANDIDATE_LIMIT);
    const endCandidates = this.nearestCandidates(to, maxSnapM, SNAP_CANDIDATE_LIMIT);
    if (startCandidates.length === 0 || endCandidates.length === 0) return null;

    let best: { start: number; end: number; cameFromEdge: Int32Array; score: number } | null = null;

    for (const s of startCandidates) {
      const startRoot = this.find(s.id);
      // Skip a start candidate whose component holds none of the end candidates — no point
      // running Dijkstra just to find every distance is Infinity.
      if (!endCandidates.some((e) => this.find(e.id) === startRoot)) continue;

      const { cost, cameFromEdge } = this.dijkstra(s.id);
      for (const e of endCandidates) {
        const routeCostM = cost[e.id];
        if (!Number.isFinite(routeCostM)) continue;
        // Weighted route cost and the snap spurs are both already in metres-of-ground-
        // distance units (costMultiplier scales ground distance, never converts it), so
        // summing them is a fair score even though the route portion isn't pure distance.
        const score = s.distanceM + routeCostM + e.distanceM;
        if (!best || score < best.score) {
          best = { start: s.id, end: e.id, cameFromEdge, score };
        }
      }
    }

    if (!best) return null;
    if (best.start === best.end) {
      return { coords: [this.nodeLngLat(best.start)], distanceM: 0, wayNames: [] };
    }
    return this.reconstructPath(best.start, best.end, best.cameFromEdge);
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
