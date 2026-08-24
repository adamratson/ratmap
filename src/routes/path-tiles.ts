import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

// Reads the walkable network straight out of a downloaded region's basemap PMTiles.
//
// This is what makes Phase 4 offline. There is no routing engine and no routing artifact:
// the `roads` layer is already inside the basemap archive the user downloaded in Phase 3
// (verified 2026-08-23 — the Ben Nevis Mountain Path is present in
// `lochaber-basemap.pmtiles` at z15 as `kind=path, kind_detail=path`), so the network we
// draw the map from is the network we route over. No new bytes, no new build step, and
// nothing to keep in sync.
//
// Everything here works in **global tile units** — `tile.x * extent + localX` at a fixed
// zoom — rather than in degrees. That is deliberate: it is an integer grid shared by every
// tile at that zoom, so a way that crosses a tile boundary yields byte-identical
// coordinates in both tiles and the graph stitches back together by exact key match. Doing
// the same in floating-point degrees would leave hairline gaps at every tile seam, which
// reads as "the router refuses to cross this line on the map" — a bug that only appears
// on long routes, i.e. in the field.

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** A walkable way, clipped to one tile, in global tile units: [gx0, gy0, gx1, gy1, …]. */
export interface PathLine {
  coords: number[];
  kind: string;
  kindDetail: string | null;
  name: string | null;
}

/**
 * Protomaps `roads` kinds we consider travelable on foot or by bike.
 *
 * `highway` (motorway/trunk) is excluded outright rather than penalised: it is not
 * walkable, and in the UK it is not even legal. Rail, ferry and aeroway never appear here.
 * Everything else is included and ranked by cost — see `path-graph.ts` — because a hill
 * route routinely starts on a minor road at a car park.
 */
const ROUTABLE_KINDS = new Set(['path', 'minor_road', 'medium_road', 'major_road']);

/**
 * Access tags that mean "you may not go here".
 *
 * `destination` is deliberately *not* in this set — it means through-traffic is barred,
 * which is a motoring restriction, and the lane is still a legitimate approach on foot.
 */
const BLOCKED_ACCESS = new Set(['private', 'no']);

export interface DecodeOptions {
  /** Layer holding the network. Protomaps v4 calls it `roads`. */
  sourceLayer?: string;
}

/**
 * Decode one vector tile into clipped, walkable lines in global tile units.
 *
 * Returns [] rather than throwing for a tile with no roads layer — most tiles in a
 * mountain region genuinely have none, and that is not an error condition.
 */
export function decodePathLines(
  bytes: ArrayBuffer | Uint8Array,
  tile: TileCoord,
  options: DecodeOptions = {},
): { lines: PathLine[]; extent: number } {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const vt = new VectorTile(new Pbf(data));
  const layer = vt.layers[options.sourceLayer ?? 'roads'];
  if (!layer) return { lines: [], extent: 4096 };

  const extent = layer.extent;
  const originX = tile.x * extent;
  const originY = tile.y * extent;
  const lines: PathLine[] = [];

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    // 2 === LineString. Roads are lines; a stray polygon (a pedestrian square) would
    // route nonsensically along its outline.
    if (feature.type !== 2) continue;

    const props = feature.properties as Record<string, unknown>;
    const kind = typeof props.kind === 'string' ? props.kind : '';
    if (!ROUTABLE_KINDS.has(kind)) continue;

    const access = typeof props.access === 'string' ? props.access : '';
    if (BLOCKED_ACCESS.has(access)) continue;

    const kindDetail = typeof props.kind_detail === 'string' ? props.kind_detail : null;
    const name = typeof props.name === 'string' ? props.name : null;

    for (const ring of feature.loadGeometry()) {
      const global: number[] = [];
      for (const point of ring) {
        global.push(originX + point.x, originY + point.y);
      }
      // Clip away the tile's rendering buffer — see clipToBounds().
      for (const piece of clipToBounds(global, originX, originY, originX + extent, originY + extent)) {
        if (piece.length >= 4) lines.push({ coords: piece, kind, kindDetail, name });
      }
    }
  }

  return { lines, extent };
}

/**
 * Clip a polyline to a rectangle, returning the pieces that fall inside.
 *
 * Discarding the tile buffer is what makes tiles stitch. A vector tile carries geometry
 * some way past its own edge so labels and wide strokes render correctly, and where a way
 * crosses a boundary the two tiles' buffered copies end at *different* points — each
 * cut at its own buffer edge. Joined naively that leaves a gap at every seam, and the
 * router then treats a continuous path as two disconnected ones.
 *
 * Cut both copies at the shared boundary instead and they meet exactly: the crossing
 * segment is the same straight line in both tiles (identical integer endpoints, since the
 * quantisation grid at a given zoom is global), so both intersections resolve to the same
 * point.
 */
export function clipToBounds(
  coords: readonly number[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[][] {
  const pieces: number[][] = [];
  let current: number[] = [];

  const inside = (x: number, y: number): boolean => x >= minX && x <= maxX && y >= minY && y <= maxY;

  const flush = (): void => {
    if (current.length >= 4) pieces.push(current);
    current = [];
  };

  for (let i = 2; i < coords.length; i += 2) {
    const ax = coords[i - 2];
    const ay = coords[i - 1];
    const bx = coords[i];
    const by = coords[i + 1];

    const aIn = inside(ax, ay);
    const bIn = inside(bx, by);

    if (aIn && bIn) {
      if (current.length === 0) current.push(ax, ay);
      current.push(bx, by);
      continue;
    }

    const clipped = clipSegment(ax, ay, bx, by, minX, minY, maxX, maxY);
    if (!clipped) {
      // Segment misses the rectangle entirely; whatever we had accumulated ends here.
      flush();
      continue;
    }

    const [cx0, cy0, cx1, cy1] = clipped;
    if (current.length === 0) current.push(cx0, cy0);
    current.push(cx1, cy1);

    // Leaving the rectangle terminates the run; re-entry starts a fresh one.
    if (!bIn) flush();
  }

  // A single-vertex line (a way whose only point inside is a vertex) has nothing to route
  // along, so the >= 4 check in flush() drops it.
  flush();
  return pieces;
}

/** Liang–Barsky segment clip. Returns [x0, y0, x1, y1] or null if wholly outside. */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): [number, number, number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;

  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // Parallel to this edge: inside iff not beyond it.
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (!clip(-dx, x0 - minX)) return null;
  if (!clip(dx, maxX - x0)) return null;
  if (!clip(-dy, y0 - minY)) return null;
  if (!clip(dy, maxY - y0)) return null;

  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

// --- Web Mercator tile maths --------------------------------------------------------

/** Tile column/row containing a coordinate at zoom `z`. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: clampTile(x, n), y: clampTile(y, n) };
}

function clampTile(value: number, n: number): number {
  return Math.min(n - 1, Math.max(0, value));
}

/** Every tile covering a [west, south, east, north] box at zoom `z`. */
export function tilesForBbox(
  bbox: readonly [number, number, number, number],
  z: number,
): TileCoord[] {
  const min = lngLatToTile(bbox[0], bbox[3], z);
  const max = lngLatToTile(bbox[2], bbox[1], z);
  const tiles: TileCoord[] = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) tiles.push({ z, x, y });
  }
  return tiles;
}

/** Global-unit coordinate → [lng, lat]. `world` is `extent * 2 ** z`. */
export function globalToLngLat(gx: number, gy: number, world: number): [number, number] {
  const lng = (gx / world) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / world))) * 180) / Math.PI;
  return [lng, lat];
}

/** [lng, lat] → global-unit coordinate at the same scale as `globalToLngLat`. */
export function lngLatToGlobal(lng: number, lat: number, world: number): [number, number] {
  const latRad = (lat * Math.PI) / 180;
  const gx = ((lng + 180) / 360) * world;
  const gy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * world;
  return [gx, gy];
}
