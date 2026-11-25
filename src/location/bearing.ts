import { distanceMetres, trueBearing } from '../routes/geo';
import type { MagneticField } from './declination';
import { COMPASS_UNRELIABLE_NT } from './declination';

// Bearing and distance from where you are to a point: the number you set on a compass and
// walk on in cloud.
//
// Magnetic, because that is what a compass — the phone's included (heading.ts) — reads.
// Corrected with the declination at your own position, which is where the compass is.

export interface Fix {
  lng: number;
  lat: number;
  /** The fix's own error radius, metres; null where the platform gave none. */
  accuracyM: number | null;
}

export interface BearingToPoint {
  true: number;
  /** Null where there is no declination to correct by (heading.ts, trueHeading). */
  magnetic: number | null;
  distanceM: number;
  /**
   * Too close for a bearing to mean anything: the fix itself could be on the far side of
   * the point. Within twice the fix's error the bearing can be out by 30° or more.
   */
  tooClose: boolean;
}

/** The nearest a bearing is offered, whatever the fix claims: a phone's GPS is ±5 m at best. */
const MIN_BEARING_M = 20;

export function bearingTo(fix: Fix, target: [number, number], field: MagneticField | null): BearingToPoint {
  const from: [number, number] = [fix.lng, fix.lat];
  const truth = trueBearing(from, target);
  const usable = field !== null && field.horizontal >= COMPASS_UNRELIABLE_NT;
  const distanceM = distanceMetres(from, target);
  return {
    true: truth,
    // Magnetic north is `declination` east of true, so a magnetic bearing is that much less.
    magnetic: usable ? normalise(truth - field.declination) : null,
    distanceM,
    tooClose: distanceM < Math.max(MIN_BEARING_M, 2 * (fix.accuracyM ?? 0)),
  };
}

/** "047°": three figures, as a bearing is said and set on a compass. */
export function formatBearing(degrees: number): string {
  const whole = Math.round(normalise(degrees)) % 360;
  return `${whole.toString().padStart(3, '0')}°`;
}

/**
 * Which way to turn from `heading` to face `target`, both degrees: positive is right.
 * Always the shorter way round, so -180 to 180.
 */
export function turnTo(heading: number, target: number): number {
  return ((((target - heading) % 360) + 540) % 360) - 180;
}

function normalise(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
