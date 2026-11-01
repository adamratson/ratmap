import { densify, distanceMetres, pathLengthMetres, resamplePath, type LngLat } from './geo';
import { RasterSampler, type DecodedTile } from './terrain-sampler';
import { SLOPE_CLASSES, slopeClassFor } from '../overlays/avalanche';

// Reads slope and aspect out of a region's `<id>-avalanche-N.pmtiles` — the tap readout
// and the route breakdown of plans/avalanche-terrain.md §6.
//
// The tiles are decoded here rather than asked of the map, for the same reasons the
// elevation profile reads its own terrain (see terrain-sampler.ts): viewport-independent,
// and null where there is genuinely no data. The channel layout is the build's (§4):
// R = slope in whole degrees (0 = below the 25° floor, A7), G = aspect octant (0 = none,
// 1-8 = N..NW), B = runout (Stage B; not read yet).

/** What the artifact says about one point on the ground. */
export interface AvalancheCell {
  /**
   * Slope in whole degrees, or 0 for "below the 25° floor". Never "measured flat": the
   * build stores 0 for everything under the threshold it draws (A7).
   */
  slope: number;
  /** Aspect octant 1-8 (N, NE, … NW), or null where the build stored none. */
  aspect: number | null;
}

/**
 * Nearest pixel, not bilinear — the opposite of the elevation profile, on purpose.
 *
 * Interpolating slope across a class boundary invents a value that is in neither cell,
 * and aspect is categorical: halfway between N (1) and NW (8) is not SE. The cell is the
 * measurement, so the readout reports the cell.
 */
function readCell(tile: DecodedTile, px: number, py: number): AvalancheCell | null {
  const x = Math.max(0, Math.min(tile.width - 1, Math.floor(px)));
  const y = Math.max(0, Math.min(tile.height - 1, Math.floor(py)));
  const offset = (y * tile.width + x) * 4;
  if (offset + 2 >= tile.data.length) return null;

  const slope = tile.data[offset];
  const aspect = tile.data[offset + 1];
  // Past 90° is not a slope. The build caps at 60, so this only fires if the artifact and
  // this code ever disagree about the layout — and then no answer is the right one.
  if (slope > 90) return null;
  return { slope, aspect: aspect >= 1 && aspect <= 8 ? aspect : null };
}

export class AvalancheSampler extends RasterSampler {
  /** One cell per point, index for index. `null` where the archive has no tile. */
  cells(points: readonly LngLat[], signal?: AbortSignal): Promise<(AvalancheCell | null)[]> {
    return this.sampleWith(points, readCell, signal);
  }
}

/**
 * Route sample spacing for slope, metres.
 *
 * Finer than the elevation profile's 25 m, because the failure runs the other way. Too
 * fine a profile invents climb out of DEM noise; too coarse a slope sample *skips cells*,
 * and the cell it skips can be the one 40° gully the route crosses. The artifact's cells
 * are ~15-25 m (the build caps its zoom at the DEM's own ~30 m), so 10 m lands at least
 * once in any cell the route passes through along its length. Nearest-pixel reads from
 * cached tiles are cheap, so the extra samples cost almost nothing.
 */
export const AVALANCHE_SAMPLE_SPACING_M = 10;

/** Cap on samples, as for the profile: past it the spacing widens rather than freezing. */
const MAX_SAMPLES = 8000;

/** Coordinates to sample for a route's slope breakdown — densified and capped. */
export function avalancheSampleCoords(coords: readonly LngLat[]): LngLat[] {
  if (coords.length < 2) return [...coords];

  const steps = Math.ceil(pathLengthMetres(coords) / AVALANCHE_SAMPLE_SPACING_M);
  // Resample rather than densify once over the cap: densify never drops a vertex, so on a
  // dense recorded track it cannot get under the cap at all (see profileSampleCoords).
  if (steps >= MAX_SAMPLES || coords.length >= MAX_SAMPLES) {
    return resamplePath(coords, Math.min(MAX_SAMPLES - 1, Math.max(1, steps)));
  }
  return densify(coords, AVALANCHE_SAMPLE_SPACING_M);
}

export interface AvalancheSummary {
  /**
   * Steepest slope crossed, whole degrees — or null when no covered part of the route
   * reaches the 25° floor. Null is "nothing at 25° or more", never "the route is flat".
   */
  steepest: number | null;
  /** Metres of route in each slope class, keyed by the class's `from`. Sparse. */
  metresByClass: Map<number, number>;
  /** Metres of route the artifact has data for, at any slope including below the floor. */
  coveredM: number;
  totalM: number;
  /** coveredM / totalM, 0 when the route has no length. */
  coverage: number;
}

/**
 * Turn per-sample cells into route totals.
 *
 * A stretch counts only when **both** ends have data, as with the SAC summary, and then
 * takes the **steeper** of the two: a stretch that touches a 38° cell at one end crossed
 * 38° ground. That can over-state a class by up to one sample spacing at each boundary,
 * and never under-states one — the right way round for a number whose job is to warn.
 */
export function summariseAvalancheTerrain(
  coords: readonly LngLat[],
  cells: readonly (AvalancheCell | null)[],
): AvalancheSummary {
  const metresByClass = new Map<number, number>();
  let coveredM = 0;
  let totalM = 0;
  let steepest: number | null = null;

  for (let i = 1; i < coords.length; i++) {
    const length = distanceMetres(coords[i - 1], coords[i]);
    totalM += length;

    const a = cells[i - 1];
    const b = cells[i];
    if (!a || !b) continue;
    coveredM += length;

    const slope = Math.max(a.slope, b.slope);
    const slopeClass = slopeClassFor(slope);
    if (!slopeClass) continue;

    metresByClass.set(slopeClass.from, (metresByClass.get(slopeClass.from) ?? 0) + length);
    if (steepest === null || slope > steepest) steepest = slope;
  }

  return {
    steepest,
    metresByClass,
    coveredM,
    totalM,
    coverage: totalM > 0 ? coveredM / totalM : 0,
  };
}

/** The classes in display order with their metres, skipping empty ones. */
export function avalancheClassBreakdown(
  summary: AvalancheSummary,
): { slopeClass: (typeof SLOPE_CLASSES)[number]; index: number; metres: number }[] {
  return SLOPE_CLASSES.flatMap((slopeClass, index) => {
    const metres = summary.metresByClass.get(slopeClass.from);
    return metres ? [{ slopeClass, index, metres }] : [];
  });
}
