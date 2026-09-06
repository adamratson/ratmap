import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { PMTiles } from 'pmtiles';
import { distanceMetres, type LngLat } from './geo';
import { lngLatToGlobal, type TileCoord } from './path-tiles';
import { SAC_SOURCE_LAYER } from '../sac';

// Reads SAC grades for a planned route out of a region's `<id>-sac.pmtiles`.
//
// The route itself is built from Protomaps' `roads` layer (see router.ts) and the grades
// live in our own artifact, so the two are not the same geometry: they are two tilings of
// the same OSM ways, simplified by different tools. There is no shared id to join on —
// Protomaps does not carry the OSM way id — so the join is geometric, and being geometric
// it can be wrong. Two things keep it honest:
//
//   1. A tight distance tolerance (SNAP_TOLERANCE_M). Parallel paths a stone's throw apart
//      are common on a hillside and grabbing the neighbour's grade would be a fabrication.
//   2. A bearing test. Where a graded path *crosses* the route, its geometry is briefly
//      within a few metres of it; without the bearing test the route would inherit the
//      grade of a path it merely stepped over.
//
// Anything that fails those is left ungraded rather than guessed at. The summary reports
// coverage precisely so that "no grade found" can never read as "graded easy".

/** A graded way, in global tile units at the sampler's zoom. */
export interface SacLine {
  coords: number[];
  grade: number;
  name: string | null;
}

/**
 * How far a route sample may sit from a graded way and still take its grade, in metres.
 *
 * Set by what the two tilings actually disagree by, not by what would maximise coverage.
 * Protomaps generalises at z15 and tippecanoe simplifies our own cut; a few metres covers
 * that. Widening it to catch more of the route starts pulling in the path on the other
 * side of the burn.
 */
export const SNAP_TOLERANCE_M = 12;

/** Maximum angle between route and graded way for the match to count, in degrees. */
const MAX_BEARING_DELTA_DEG = 40;

/**
 * Tile extent every coordinate here is expressed in.
 *
 * Fixed rather than read per tile, because these are *global* units — `tile.x * extent +
 * localX` — and mixing two extents in one number line silently misplaces geometry by
 * whole tiles. Our own build uses tippecanoe's default 4096; a tile that disagrees is
 * rescaled at decode time (below) rather than being trusted or dropped.
 */
const TILE_EXTENT = 4096;

export interface SacSamplerOptions {
  archive: PMTiles;
  /** The archive's own maxzoom, from the region manifest. */
  maxzoom: number;
  /** Decoded tiles held in memory, keyed by z/x/y. */
  cacheSize?: number;
  toleranceM?: number;
}

/** Decode one sac tile into lines in global tile units. Buffer geometry is kept. */
export function decodeSacLines(
  bytes: ArrayBuffer | Uint8Array,
  tile: TileCoord,
  sourceLayer = SAC_SOURCE_LAYER,
): { lines: SacLine[]; extent: number } {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const layer = new VectorTile(new Pbf(data)).layers[sourceLayer];
  if (!layer) return { lines: [], extent: 4096 };

  const extent = layer.extent;
  const scale = TILE_EXTENT / extent;
  const originX = tile.x * TILE_EXTENT;
  const originY = tile.y * TILE_EXTENT;
  const lines: SacLine[] = [];

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue; // LineString only.

    const props = feature.properties as Record<string, unknown>;
    const grade = typeof props.t === 'number' ? props.t : Number.NaN;
    // The build drops anything that is not T1-T6, so this only fires if the artifact and
    // this code ever disagree — in which case no grade is the right answer.
    if (!Number.isInteger(grade) || grade < 1 || grade > 6) continue;

    const name = typeof props.name === 'string' ? props.name : null;

    for (const ring of feature.loadGeometry()) {
      const coords: number[] = [];
      for (const point of ring) {
        coords.push(originX + point.x * scale, originY + point.y * scale);
      }
      // Unlike path-tiles.ts this does *not* clip to the tile: nothing here is being
      // stitched into a graph, and the buffer overhang is real geometry from the
      // neighbouring tile, which is exactly what a sample near a tile edge needs.
      if (coords.length >= 4) lines.push({ coords, grade, name });
    }
  }

  return { lines, extent };
}

export class SacSampler {
  private readonly archive: PMTiles;
  private readonly maxzoom: number;
  private readonly cacheSize: number;
  private readonly toleranceM: number;
  private readonly tiles = new Map<string, SacLine[]>();

  constructor(options: SacSamplerOptions) {
    this.archive = options.archive;
    this.maxzoom = options.maxzoom;
    this.cacheSize = options.cacheSize ?? 64;
    this.toleranceM = options.toleranceM ?? SNAP_TOLERANCE_M;
  }

  /**
   * The grade under each point of an ordered route polyline. `null` where the route is
   * not on a graded way — which is most paths, most places.
   */
  async grades(coords: readonly LngLat[], signal?: AbortSignal): Promise<(number | null)[]> {
    const results: (number | null)[] = new Array(coords.length).fill(null);
    if (coords.length === 0) return results;

    const world = TILE_EXTENT * 2 ** this.maxzoom;

    for (let i = 0; i < coords.length; i++) {
      if (signal?.aborted) throw new DOMException('Grades cancelled', 'AbortError');

      const [gx, gy] = lngLatToGlobal(coords[i][0], coords[i][1], world);
      const unitsPerMetre = 1 / metresPerUnit(coords[i][1], world);
      const tolerance = this.toleranceM * unitsPerMetre;

      const candidates = await this.linesNear(gx, gy, tolerance, signal);
      if (candidates.length === 0) continue;

      // The route's own direction here, used for the bearing test. Taken from the
      // neighbouring samples so an endpoint still has one.
      const before = coords[Math.max(0, i - 1)];
      const after = coords[Math.min(coords.length - 1, i + 1)];
      const heading = headingOf(before, after, world);

      results[i] = bestGrade(candidates, gx, gy, tolerance, heading);
    }

    return results;
  }

  /**
   * Lines from every tile within `tolerance` of the point.
   *
   * Usually one tile. Near a tile edge it is two or four, and asking for them is what
   * stops a graded path going momentarily ungraded every time the route crosses a tile
   * boundary — a seam artefact that would look exactly like a real gap in the tagging.
   */
  private async linesNear(
    gx: number,
    gy: number,
    tolerance: number,
    signal?: AbortSignal,
  ): Promise<SacLine[]> {
    const n = 2 ** this.maxzoom;
    const minX = Math.max(0, Math.floor((gx - tolerance) / TILE_EXTENT));
    const maxX = Math.min(n - 1, Math.floor((gx + tolerance) / TILE_EXTENT));
    const minY = Math.max(0, Math.floor((gy - tolerance) / TILE_EXTENT));
    const maxY = Math.min(n - 1, Math.floor((gy + tolerance) / TILE_EXTENT));

    const lines: SacLine[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        lines.push(...(await this.tileAt(x, y, signal)));
      }
    }
    return lines;
  }

  private async tileAt(x: number, y: number, signal?: AbortSignal): Promise<SacLine[]> {
    const key = `${x}/${y}`;
    const cached = this.tiles.get(key);
    // An empty array is a real answer — "nothing graded here" — and most tiles give it.
    if (cached) return cached;
    if (this.tiles.has(key)) return [];

    let lines: SacLine[] = [];
    try {
      const response = await this.archive.getZxy(this.maxzoom, x, y, signal);
      if (response) lines = decodeSacLines(response.data, { z: this.maxzoom, x, y }).lines;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      // A tile that will not decode is missing data, not a crash: the route reports it as
      // uncovered rather than failing.
      lines = [];
    }

    if (this.tiles.size >= this.cacheSize) {
      const oldest = this.tiles.keys().next().value;
      if (oldest !== undefined) this.tiles.delete(oldest);
    }
    this.tiles.set(key, lines);
    return lines;
  }
}

/** Metres per global unit at a latitude — Mercator, so it is latitude-dependent. */
function metresPerUnit(lat: number, world: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / world;
}

/** Direction of travel in global units, radians. Mercator is conformal, so angles hold. */
function headingOf(from: LngLat, to: LngLat, world: number): number | null {
  const [ax, ay] = lngLatToGlobal(from[0], from[1], world);
  const [bx, by] = lngLatToGlobal(to[0], to[1], world);
  if (ax === bx && ay === by) return null;
  return Math.atan2(by - ay, bx - ax);
}

/**
 * The grade of the nearest matching way, or null.
 *
 * Hardest-wins among matches at equal distance is deliberate: where two graded ways are
 * both within tolerance, the harder one is the one a walker needs to know about.
 */
function bestGrade(
  lines: readonly SacLine[],
  gx: number,
  gy: number,
  tolerance: number,
  heading: number | null,
): number | null {
  let bestDistance = tolerance;
  let best: number | null = null;

  for (const line of lines) {
    for (let i = 2; i < line.coords.length; i += 2) {
      const ax = line.coords[i - 2];
      const ay = line.coords[i - 1];
      const bx = line.coords[i];
      const by = line.coords[i + 1];

      const distance = pointSegmentDistance(gx, gy, ax, ay, bx, by);
      if (distance > bestDistance) continue;
      if (heading !== null && !bearingAgrees(heading, Math.atan2(by - ay, bx - ax))) continue;

      if (distance < bestDistance || best === null) {
        bestDistance = distance;
        best = line.grade;
      } else {
        // Same way traced twice, or two graded ways sharing a stretch. Take the harder.
        best = Math.max(best, line.grade);
      }
    }
  }

  return best;
}

/** Undirected: a way tagged in the opposite direction to the walk is still the same way. */
function bearingAgrees(a: number, b: number): boolean {
  let delta = Math.abs(a - b) % (2 * Math.PI);
  if (delta > Math.PI) delta = 2 * Math.PI - delta;
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
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface SacSummary {
  /** Hardest grade found on the route, or null if none of it is graded. */
  hardest: number | null;
  /** Metres of route carrying each grade. Sparse — only grades actually present. */
  metresByGrade: Map<number, number>;
  gradedM: number;
  totalM: number;
  /** gradedM / totalM, 0 when the route has no length. */
  coverage: number;
}

/**
 * Turn per-sample grades into route totals.
 *
 * A stretch counts as graded only when **both** ends of it carry a grade, and then takes
 * the harder of the two. That under-reports coverage by up to one sample spacing at each
 * end of a graded run, and never over-reports it — the right direction to be wrong in,
 * because the number this feeds is a claim about how much of the route we actually know
 * something about.
 */
export function summariseSacGrades(
  coords: readonly LngLat[],
  grades: readonly (number | null)[],
): SacSummary {
  const metresByGrade = new Map<number, number>();
  let gradedM = 0;
  let totalM = 0;
  let hardest: number | null = null;

  for (let i = 1; i < coords.length; i++) {
    const length = distanceMetres(coords[i - 1], coords[i]);
    totalM += length;

    const a = grades[i - 1];
    const b = grades[i];
    if (a == null || b == null) continue;

    const grade = Math.max(a, b);
    metresByGrade.set(grade, (metresByGrade.get(grade) ?? 0) + length);
    gradedM += length;
    if (hardest === null || grade > hardest) hardest = grade;
  }

  return {
    hardest,
    metresByGrade,
    gradedM,
    totalM,
    coverage: totalM > 0 ? gradedM / totalM : 0,
  };
}
