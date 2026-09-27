// Walking time by Naismith's rule. Pure: distance and climb in, an estimate out.
//
// The rule as W. W. Naismith gave it (1892): an hour for every three miles on the flat,
// plus an hour for every 2000 feet of ascent. In metric, as every UK hillwalking guide now
// quotes it, 5 km/h plus an hour per 600 m. Descent is not in the rule — on moderate
// ground going down is roughly as quick as the flat, and the rule does not pretend to know
// better than that.
//
// It is a planning figure for a fit party on a dry day, without stops. It knows nothing
// about terrain, weather, load or pace, and it is optimistic on rough or steep ground and
// on long days — so it is labelled as Naismith, never as "the time", and nobody should
// read it as a promise.

/** Horizontal walking speed, metres per hour. */
export const NAISMITH_FLAT_M_PER_HR = 5000;

/** Ascent that costs one extra hour, metres. */
export const NAISMITH_CLIMB_M_PER_HR = 600;

/**
 * Estimated walking time, seconds.
 *
 * Takes the threshold-filtered ascent from profile.ts, not a raw sum of DEM differences:
 * the rule prices climb at ten minutes per 100 m, so phantom climb from DEM noise would
 * turn straight into phantom hours.
 */
export function naismithSeconds(distanceM: number, ascentM: number): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(ascentM)) return NaN;
  const hours =
    Math.max(0, distanceM) / NAISMITH_FLAT_M_PER_HR +
    Math.max(0, ascentM) / NAISMITH_CLIMB_M_PER_HR;
  return hours * 3600;
}

/** Precision the estimate is written to, minutes. Finer than this is false precision. */
const ROUND_TO_MIN = 5;

/** "3 hr 25 min" — rounded to five minutes, never less than five for a real route. */
export function formatWalkingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds === 0) return '0 min';

  const minutes = Math.max(ROUND_TO_MIN, Math.round(seconds / 60 / ROUND_TO_MIN) * ROUND_TO_MIN);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
