import { densify, distanceMetres, type LngLat } from './geo';

// Elevation profile maths. Pure: takes coordinates and their sampled heights, returns the
// profile and the ascent/descent totals. No DEM reading, no map — see terrain-sampler.ts
// for where the heights come from.

export interface ProfilePoint {
  coord: LngLat;
  /** Distance from the start of the route, metres. */
  distanceM: number;
  /** Metres above sea level, or null where the DEM has no coverage. */
  ele: number | null;
}

export interface ElevationProfile {
  points: ProfilePoint[];
  /** Total climb, metres. */
  ascentM: number;
  /** Total descent, metres. */
  descentM: number;
  minEle: number | null;
  maxEle: number | null;
  /** Fraction of samples that got a height, 0..1. Below 1 the totals are understated. */
  coverage: number;
}

/**
 * Horizontal sample spacing, metres.
 *
 * Matched to the DEM rather than chosen for looks: Copernicus GLO-30 is 30 m data, which
 * our terrain archives carry at roughly 21 m per pixel at their top zoom. Sampling much
 * finer than that invents detail that is not in the source — it does not make the profile
 * more accurate, it makes it noisier, and noise inflates the ascent total.
 */
export const SAMPLE_SPACING_M = 25;

/**
 * Cap on samples for one profile.
 *
 * A 40 km route at 25 m spacing is 1600 points, which is fine. This exists so a route
 * crossing a country cannot lock the app decoding DEM tiles; past the cap the spacing
 * widens instead.
 */
const MAX_SAMPLES = 2500;

/**
 * Minimum height change counted as a climb or a drop, metres.
 *
 * Summing every positive difference between consecutive DEM samples is the obvious
 * implementation and it is wrong — badly. Elevation data is noisy at the metre level, and
 * a route with a thousand samples accumulates that noise into hundreds of metres of
 * phantom climb. The reported total then varies with how densely the route was sampled
 * rather than with the hill, which is the kind of plausible-but-wrong number this project
 * exists to avoid.
 *
 * So a change only counts once it reaches this threshold from the last committed height.
 * The cost is under-reporting by less than the threshold at each genuine turning point,
 * and dropping undulations smaller than it. That is the right direction to be wrong in:
 * a total that ignores a 4 m hummock is defensible, one that invents 300 m of climb is
 * not.
 */
const ASCENT_THRESHOLD_M = 5;

/** Coordinates to sample for a profile — densified and capped. */
export function profileSampleCoords(coords: readonly LngLat[]): LngLat[] {
  if (coords.length === 0) return [];
  if (coords.length === 1) return [coords[0]];

  let spacing = SAMPLE_SPACING_M;
  let sampled = densify(coords, spacing);

  // Widen rather than truncate: a truncated profile would silently describe part of the
  // route as if it were the whole of it.
  while (sampled.length > MAX_SAMPLES) {
    spacing *= 2;
    sampled = densify(coords, spacing);
  }

  return sampled;
}

/**
 * Build the profile from sampled coordinates and their heights.
 *
 * `elevations` must line up with `coords` index for index; a null means the DEM had no
 * value there, which is reported through `coverage` rather than guessed at.
 */
export function buildProfile(
  coords: readonly LngLat[],
  elevations: readonly (number | null)[],
): ElevationProfile {
  const points: ProfilePoint[] = [];
  let distanceM = 0;

  for (let i = 0; i < coords.length; i++) {
    if (i > 0) distanceM += distanceMetres(coords[i - 1], coords[i]);
    const ele = elevations[i];
    points.push({
      coord: coords[i],
      distanceM,
      ele: typeof ele === 'number' && Number.isFinite(ele) ? ele : null,
    });
  }

  const known = points.filter((point): point is ProfilePoint & { ele: number } => point.ele !== null);

  return {
    points,
    ...accumulate(known.map((point) => point.ele)),
    minEle: known.length > 0 ? Math.min(...known.map((point) => point.ele)) : null,
    maxEle: known.length > 0 ? Math.max(...known.map((point) => point.ele)) : null,
    coverage: points.length === 0 ? 0 : known.length / points.length,
  };
}

/** Ascent and descent, threshold-filtered — see ASCENT_THRESHOLD_M. */
function accumulate(elevations: readonly number[]): { ascentM: number; descentM: number } {
  if (elevations.length < 2) return { ascentM: 0, descentM: 0 };

  let ascentM = 0;
  let descentM = 0;
  // The last height committed to. Everything is measured against this, not against the
  // previous sample, which is what keeps sample-to-sample noise out of the totals.
  let reference = elevations[0];

  for (const ele of elevations) {
    const delta = ele - reference;
    if (delta >= ASCENT_THRESHOLD_M) {
      ascentM += delta;
      reference = ele;
    } else if (delta <= -ASCENT_THRESHOLD_M) {
      descentM -= delta;
      reference = ele;
    }
  }

  return { ascentM, descentM };
}

export function formatElevationChange(metres: number): string {
  return `${Math.round(metres)} m`;
}
