import type { PMTiles } from 'pmtiles';
import { boundsOf, distanceMetres, pathLengthMetres, type Bbox, type LngLat } from './geo';
import { PathGraph, type RouteLeg } from './path-graph';
import { decodePathLines, tilesForBbox, type PathLine, type TileCoord } from './path-tiles';
import type { Region } from '../regions/manifest';
import type { TileSourceRegistry } from '../tile-source-registry';

// Turns a downloaded region's basemap archive into a routable network, on the device,
// with the network off.
//
// §4 Phase 4 originally specified Valhalla behind an async cancellable interface. That was
// dropped on 2026-08-23 in favour of routing over the tiles we already ship — see the
// spec's Phase 4 section. The *interface* survives the change unaltered: async, cancellable
// via AbortSignal, and free to fail, because C11 requires waypoint placement to work
// whether or not a route can be computed. Only the implementation behind it moved from a
// server to this file.

/**
 * Zoom the network is read at.
 *
 * The region basemaps are built to z15 and paths appear from z14, so this is the archive's
 * own maximum detail. Reading a lower zoom would drop geometry — planetiler simplifies as
 * it generalises — and a simplified path is a *wrong* path length, which is the number
 * someone uses to decide whether they get back before dark.
 */
export const ROUTING_ZOOM = 15;

/**
 * How far outside the straight line between two waypoints to load the network.
 *
 * The shortest walkable route between two points is routinely nothing like the straight
 * line — a zigzag ascent, a detour to a bridge, a path around a crag. Too tight a box and
 * the router either finds a worse route or none at all, with nothing to indicate the box
 * was the reason.
 */
function padForLeg(from: LngLat, to: LngLat): number {
  return Math.max(1_200, distanceMetres(from, to) * 0.35);
}

/**
 * Tile budget per leg. At z15 and 57°N a tile is about 670 m across, so this covers a
 * box roughly 21 km on a side.
 *
 * A cap rather than an unbounded load: a waypoint dropped on the far side of the country
 * would otherwise try to decode tens of thousands of tiles and hang the app. Exceeding it
 * is reported as an explicit fallback reason, not a silent straight line (C1's principle:
 * never let the user believe they have something they do not).
 */
const MAX_TILES_PER_LEG = 1024;

/** Nothing further than this from a path can be snapped onto the network. */
const MAX_SNAP_M = 250;

export type LegKind = 'snapped' | 'straight';

export interface ComputedLeg {
  coords: LngLat[];
  distanceM: number;
  kind: LegKind;
  /** Named ways the route follows, in order. Empty for a straight leg. */
  wayNames: string[];
  /** Why this leg is straight rather than snapped. Absent when it snapped. */
  reason?: string;
}

export interface RouteRequest {
  signal?: AbortSignal;
}

export interface OfflineRouterOptions {
  registry: TileSourceRegistry;
  /** The regions whose archives are actually present in OPFS right now. */
  downloadedRegions: () => Region[];
}

export class OfflineRouter {
  private readonly registry: TileSourceRegistry;
  private readonly downloadedRegions: () => Region[];
  /** Decoded lines by `${filename}/${z}/${x}/${y}`. Decoding dominates the cost. */
  private readonly tileCache = new Map<string, PathLine[]>();

  constructor(options: OfflineRouterOptions) {
    this.registry = options.registry;
    this.downloadedRegions = options.downloadedRegions;
  }

  /** True when some downloaded region could route between these points. */
  canRoute(from: LngLat, to: LngLat): boolean {
    return this.regionFor(from, to) !== null;
  }

  /**
   * Route one leg.
   *
   * Never rejects for a routing failure — an unroutable leg comes back as a straight one
   * with a reason. C11: a waypoint must commit whether or not the network can be snapped
   * to, or offline editing becomes impossible. The only rejection is cancellation.
   */
  async computeLeg(from: LngLat, to: LngLat, request: RouteRequest = {}): Promise<ComputedLeg> {
    const straight = (reason: string): ComputedLeg => ({
      coords: [from, to],
      distanceM: distanceMetres(from, to),
      kind: 'straight',
      wayNames: [],
      reason,
    });

    const region = this.regionFor(from, to);
    if (!region) {
      return straight('No downloaded region covers both ends of this leg.');
    }

    const archive = this.archiveFor(region);
    if (!archive) {
      return straight(`${region.name} is listed but its map archive is not loaded.`);
    }

    const bbox = boundsOf([from, to], padForLeg(from, to))!;
    const tiles = tilesForBbox(bbox, ROUTING_ZOOM);
    if (tiles.length > MAX_TILES_PER_LEG) {
      return straight('This leg is too long to route in one go — add a waypoint part-way.');
    }

    const graph = await this.buildGraph(archive, region, tiles, request.signal);
    const leg = graph.routeBetween(from, to, { maxSnapM: MAX_SNAP_M });

    if (!leg) {
      return straight('No connected path between these points in the downloaded map.');
    }

    return {
      coords: withEndpoints(from, to, leg),
      // Recomputed over the returned geometry, which includes the two spurs joining the
      // tapped points to where they snapped. Reporting the graph's own figure would
      // under-report every leg by up to the snap radius at each end.
      distanceM: pathLengthMetres(withEndpoints(from, to, leg)),
      kind: 'snapped',
      wayNames: leg.wayNames,
    };
  }

  /** Drop cached tiles — call when a region is deleted so stale geometry cannot linger. */
  clearCache(): void {
    this.tileCache.clear();
  }

  /**
   * The downloaded region containing both endpoints.
   *
   * Both, not either: a leg spanning two regions would need a graph stitched across two
   * archives, and half a route is worse than an honest straight line.
   */
  private regionFor(from: LngLat, to: LngLat): Region | null {
    for (const region of this.downloadedRegions()) {
      if (!region.artifacts.some((artifact) => artifact.kind === 'basemap')) continue;
      if (containsPoint(region.bbox, from) && containsPoint(region.bbox, to)) return region;
    }
    return null;
  }

  private archiveFor(region: Region): PMTiles | null {
    const basemap = region.artifacts.find((artifact) => artifact.kind === 'basemap');
    if (!basemap) return null;
    // C3 again: the artifact filename is the registry key, because that is what
    // FileSource.getKey() returns for the OPFS file.
    return this.registry.get(basemap.filename) ?? null;
  }

  private async buildGraph(
    archive: PMTiles,
    region: Region,
    tiles: TileCoord[],
    signal?: AbortSignal,
  ): Promise<PathGraph> {
    const basemap = region.artifacts.find((artifact) => artifact.kind === 'basemap')!;
    const graph = new PathGraph(4096 * 2 ** ROUTING_ZOOM);

    for (const tile of tiles) {
      // Cancellation is checked per tile rather than per leg: dragging a waypoint fires a
      // new request on every frame, and an abandoned one must stop reading immediately
      // instead of finishing a few hundred tile decodes nobody is waiting for.
      if (signal?.aborted) throw new DOMException('Route cancelled', 'AbortError');

      const key = `${basemap.filename}/${tile.z}/${tile.x}/${tile.y}`;
      let lines = this.tileCache.get(key);

      if (!lines) {
        const response = await archive.getZxy(tile.z, tile.x, tile.y, signal).catch(() => undefined);
        // An absent tile is normal — most of a mountain region is empty at z15.
        lines = response ? decodePathLines(response.data, tile).lines : [];
        this.tileCache.set(key, lines);
      }

      for (const line of lines) graph.addLine(line);
    }

    return graph;
  }
}

/**
 * Join the tapped points to the route with short spurs.
 *
 * Without this the drawn line starts wherever the snap landed, so a waypoint placed on a
 * summit visibly detaches from its own marker — and the reported distance omits the walk
 * from the marker to the path.
 */
function withEndpoints(from: LngLat, to: LngLat, leg: RouteLeg): LngLat[] {
  const coords = [...leg.coords];
  if (coords.length === 0) return [from, to];

  // A metre of slack: reproducing a coordinate the snap already matched would leave a
  // zero-length segment, which is harmless but shows up as a duplicate vertex in GPX.
  if (distanceMetres(from, coords[0]) > 1) coords.unshift(from);
  if (distanceMetres(to, coords[coords.length - 1]) > 1) coords.push(to);
  return coords;
}

function containsPoint(bbox: Bbox | readonly number[], point: LngLat): boolean {
  return (
    point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]
  );
}
