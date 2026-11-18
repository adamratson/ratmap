import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { PathLine, TileCoord } from './path-tiles';

// Which of the basemap's private ways a walker may use.
//
// The basemap's `roads` layer carries a way's `access` tag and nothing else about who may
// use it — no `foot`, no `designation` — so the router has always dropped `access=private`
// and `access=no` outright. Most of those are farm drives, and dropping them is right. But
// a public right of way across a private estate is tagged the same way: the College Valley
// road (OSM way 34571653) is `access=private foot=designated designation=public_bridleway`,
// and dropping it sent Hethpool → Mounthooly 15.6 km over the border ridge instead of 5.9 km
// up the valley (scotland-basemap.pmtiles, 2026-11-18) — presented as a snapped route, with
// nothing to say it was wrong.
//
// `<id>-access-1.pmtiles` (infra/scripts/build-access.sh) is the exceptions: the
// restricted ways whose own `foot` or `designation` opens them to walkers. A restricted
// basemap way is admitted only along the stretches where one of those lies on it.
//
// The two are different tilings of the same OSM ways with no shared id (Protomaps does not
// carry it), so the join is geometric, as for the SAC grades (sac-sampler.ts) — and
// deliberately stricter than that one, because the cost of a false match differs. A wrong
// grade is a wrong label; a wrong match here routes someone up a private drive. So:
//
//   - Both tilings are of the *same* way at the *same* zoom, ours unsimplified, so they
//     should agree to within the basemap's own z15 simplification. MATCH_TOLERANCE_M is set
//     from what they were measured to disagree by, not from what would admit the most.
//   - Every sample along a segment must match, not most of them. A segment half on a
//     bridleway and half on the private drive beyond it stays dropped.
//   - The bearing must agree, so a public path that merely crosses a private track does
//     not open the track.
//
// Anything that fails stays dropped — the behaviour before this existed, and the same
// behaviour as a region downloaded before the artifact did.

/** Source layer in `<id>-access-1.pmtiles`, as build-access.sh names it. */
export const ACCESS_SOURCE_LAYER = 'access';

/**
 * How far a restricted basemap way may stray from an open-on-foot way and still be taken
 * as the same way, in metres.
 *
 * Measured (2026-11-18) over every restricted segment of scotland-basemap.pmtiles in a
 * tile holding one of the 2,148 open ways built from the Scotland and Cumbria extracts:
 * 16,522 segments, 479 km, lie within 0.5 m all along — same OSM geometry, same z15 grid.
 * Between 0.5 and 4 m there are ~110 more, 2.8 km: mostly the same way edited since the
 * basemap's OSM snapshot (2026-03-31; one Edinburgh way had moved 1-4 m), the rest
 * segments that run a few metres past the end of a right of way. 4 m admits the first and
 * barely the second.
 */
export const MATCH_TOLERANCE_M = 4;

/**
 * Maximum angle between the two, in degrees. Undirected: a way has no direction here.
 * Loosening it to 45° in the same measurement added 11 segments within 4 m.
 */
const MAX_BEARING_DELTA_DEG = 25;

/** Longest stretch of a segment left unsampled, in metres. */
const SAMPLE_SPACING_M = 5;

/** Global units are always on this grid, whatever extent a tile was encoded at. */
const TILE_EXTENT = 4096;

/**
 * Decode one access tile into lines in global tile units at its own zoom.
 *
 * Not clipped to the tile: the buffer overhang is real geometry from the neighbouring tile,
 * and it is what lets a basemap way right at the tile edge find its match.
 */
export function decodeAccessLines(
  bytes: ArrayBuffer | Uint8Array,
  tile: TileCoord,
  sourceLayer = ACCESS_SOURCE_LAYER,
): number[][] {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const layer = new VectorTile(new Pbf(data)).layers[sourceLayer];
  if (!layer) return [];

  // Rescaled rather than trusted: global units mix tiles, and two extents on one number
  // line misplace geometry by whole tiles (see sac-sampler.ts).
  const scale = TILE_EXTENT / layer.extent;
  const originX = tile.x * TILE_EXTENT;
  const originY = tile.y * TILE_EXTENT;
  const lines: number[][] = [];

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue;
    for (const ring of feature.loadGeometry()) {
      const coords: number[] = [];
      for (const point of ring) coords.push(originX + point.x * scale, originY + point.y * scale);
      if (coords.length >= 4) lines.push(coords);
    }
  }
  return lines;
}

/**
 * The stretches of a restricted way that an open-on-foot way lies along, as unrestricted
 * lines — or nothing. `world` is `4096 * 2 ** z` for the zoom both are in; `lat` is any
 * latitude in the tile, for the metres-to-units scale.
 */
export function admitRestricted(
  line: PathLine,
  open: readonly number[][],
  world: number,
  lat: number,
): PathLine[] {
  const unitsPerMetre = world / (40_075_016.686 * Math.cos((lat * Math.PI) / 180));
  const tolerance = MATCH_TOLERANCE_M * unitsPerMetre;
  const spacing = SAMPLE_SPACING_M * unitsPerMetre;

  const nearby = open.filter((coords) => overlapsBox(coords, line.coords, tolerance));
  if (nearby.length === 0) return [];

  const pieces: PathLine[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 4) {
      pieces.push({ coords: run, kind: line.kind, kindDetail: line.kindDetail, name: line.name });
    }
    run = [];
  };

  const c = line.coords;
  for (let i = 2; i < c.length; i += 2) {
    const ax = c[i - 2];
    const ay = c[i - 1];
    const bx = c[i];
    const by = c[i + 1];
    if (segmentOpen(ax, ay, bx, by, nearby, tolerance, spacing)) {
      if (run.length === 0) run.push(ax, ay);
      run.push(bx, by);
    } else {
      flush();
    }
  }
  flush();
  return pieces;
}

/** Whether every sample along a–b lies within tolerance of an open way running the same way. */
function segmentOpen(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  open: readonly number[][],
  tolerance: number,
  spacing: number,
): boolean {
  const length = Math.hypot(bx - ax, by - ay);
  if (length === 0) return false;
  const heading = Math.atan2(by - ay, bx - ax);
  const samples = Math.max(1, Math.ceil(length / spacing));

  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const px = ax + t * (bx - ax);
    const py = ay + t * (by - ay);
    if (!nearOpenWay(px, py, heading, open, tolerance)) return false;
  }
  return true;
}

function nearOpenWay(
  px: number,
  py: number,
  heading: number,
  open: readonly number[][],
  tolerance: number,
): boolean {
  for (const coords of open) {
    for (let i = 2; i < coords.length; i += 2) {
      const ax = coords[i - 2];
      const ay = coords[i - 1];
      const bx = coords[i];
      const by = coords[i + 1];
      if (ax === bx && ay === by) continue;
      if (pointSegmentDistance(px, py, ax, ay, bx, by) > tolerance) continue;
      if (bearingsAgree(heading, Math.atan2(by - ay, bx - ax))) return true;
    }
  }
  return false;
}

function bearingsAgree(a: number, b: number): boolean {
  // Undirected: fold the difference into [0, π/2].
  let delta = Math.abs(a - b) % Math.PI;
  if (delta > Math.PI / 2) delta = Math.PI - delta;
  return delta <= (MAX_BEARING_DELTA_DEG * Math.PI) / 180;
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether two polylines' bounding boxes come within `pad` of each other. */
function overlapsBox(a: readonly number[], b: readonly number[], pad: number): boolean {
  const [aMinX, aMinY, aMaxX, aMaxY] = box(a);
  const [bMinX, bMinY, bMaxX, bMaxY] = box(b);
  return aMinX - pad <= bMaxX && bMinX - pad <= aMaxX && aMinY - pad <= bMaxY && bMinY - pad <= aMaxY;
}

function box(coords: readonly number[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    minX = Math.min(minX, coords[i]);
    maxX = Math.max(maxX, coords[i]);
    minY = Math.min(minY, coords[i + 1]);
    maxY = Math.max(maxY, coords[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}
