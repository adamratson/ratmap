// Magnetic declination: how far a compass needle points from true north, here and now.
//
// The map is drawn to true north, and a compass reads magnetic north, so every bearing
// taken off the map and walked on a compass needs this correction. Where it is a degree it
// barely matters; across a kilometre of featureless plateau in cloud, 5° puts you 90 m
// off, and in Iceland or Svalbard it is tens of degrees.
//
// Calculated on the device from the World Magnetic Model, so it works offline anywhere.
// WMM2025.COF is NOAA/NCEI's coefficient file, byte for byte (WMM2025COF.zip, released
// 17 Dec 2024; header `2025.0  WMM-2025  11/13/2024`). The WMM is a US government work in
// the public domain. WMM2025_TestValues.txt, from the same zip, is what the tests check
// this against.
//
// **The model expires.** It is fitted to 2025.0 and predicts the field's drift forward for
// five years; NOAA retires it at 2030.0 and publishes the next one. After that this returns
// null and nothing is shown, rather than a value that grows quietly wrong. Shipping
// WMM2030 is a coefficient-file swap.
//
// The arithmetic is the WMM technical report's (§1.2, "The Model Equations"): geodetic to
// geocentric coordinates, Schmidt semi-normalised Legendre functions to degree 12, the
// field rotated back to geodetic north, east and down.

import cof from './WMM2025.COF?raw';

export interface MagneticField {
  /** Degrees east of true north; negative is west. */
  declination: number;
  /** How fast the declination is changing, degrees a year; positive is eastward. */
  declinationPerYear: number;
  /** Horizontal field strength, nT — what turns a compass needle. */
  horizontal: number;
}

interface Model {
  epoch: number;
  name: string;
  /** Coefficients indexed [n][m]. */
  g: number[][];
  h: number[][];
  gDot: number[][];
  hDot: number[][];
}

const MAX_DEGREE = 12;
/** The model's validity: five years from its epoch. */
const LIFETIME_YEARS = 5;

// WGS84, and the geomagnetic reference radius (all km).
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const REFERENCE_RADIUS = 6371.2;

/**
 * Below 2,000 nT of horizontal field a compass is unreliable, and below 6,000 it should be
 * used with caution: NOAA's "blackout" and "caution" zones round the magnetic poles.
 */
export const COMPASS_UNRELIABLE_NT = 2000;
export const COMPASS_CAUTION_NT = 6000;

export function parseCof(text: string): Model {
  const lines = text.split(/\r?\n/);
  const [epochText, name] = lines[0]!.trim().split(/\s+/);
  const grid = () => Array.from({ length: MAX_DEGREE + 1 }, () => new Array<number>(MAX_DEGREE + 1).fill(0));
  const model: Model = { epoch: Number(epochText), name: name ?? '', g: grid(), h: grid(), gDot: grid(), hDot: grid() };
  let count = 0;
  for (const line of lines.slice(1)) {
    if (/^9{20,}/.test(line.trim())) break;
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length !== 6 || fields.some(Number.isNaN)) continue;
    const [n, m, g, h, gDot, hDot] = fields as [number, number, number, number, number, number];
    model.g[n]![m] = g;
    model.h[n]![m] = h;
    model.gDot[n]![m] = gDot;
    model.hDot[n]![m] = hDot;
    count++;
  }
  // Degree 1 to 12 is 2 + 3 + … + 13 = 90 coefficient rows. Fewer is a truncated file,
  // which would still produce plausible-looking, wrong numbers.
  if (!Number.isFinite(model.epoch) || count !== 90) {
    throw new Error(`Not a complete WMM coefficient file (epoch ${epochText}, ${count} rows)`);
  }
  return model;
}

let wmm: Model | undefined;
function model(): Model {
  wmm ??= parseCof(cof);
  return wmm;
}

/** The model's name and the date it stops being valid, for anything that cites it. */
export function magneticModel(): { name: string; validUntil: Date } {
  const { name, epoch } = model();
  return { name, validUntil: new Date(Date.UTC(epoch + LIFETIME_YEARS, 0, 1)) };
}

/** A date as the model's decimal year: the year plus the elapsed fraction of it, in days. */
export function decimalYear(date: Date): number {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const days = (Date.UTC(year + 1, 0, 1) - start) / 86_400_000;
  const day = Math.floor((date.getTime() - start) / 86_400_000);
  return year + day / days;
}

/**
 * The magnetic field at a point on the ground, at `when`.
 *
 * Null outside the model's five years (an expired model, or a device clock set wrong) and
 * within a few kilometres of the geographic poles, where declination has no meaning.
 */
export function magneticField(lat: number, lng: number, when: Date, heightKm = 0): MagneticField | null {
  return fieldAt(lat, lng, decimalYear(when), heightKm);
}

/** As {@link magneticField}, at a decimal year — the form the published test values use. */
export function fieldAt(lat: number, lng: number, year: number, heightKm = 0): MagneticField | null {
  const m = model();
  if (!(year >= m.epoch && year < m.epoch + LIFETIME_YEARS)) return null;
  if (!(Math.abs(lat) < 89.99) || !Number.isFinite(lng)) return null;

  const dt = year - m.epoch;
  const rad = Math.PI / 180;
  const phi = lat * rad;
  const lambda = lng * rad;

  // Geodetic to geocentric spherical: the field is a function of distance from the earth's
  // centre and geocentric latitude, not of the ellipsoid.
  const sinPhi = Math.sin(phi);
  const rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const p = (rc + heightKm) * Math.cos(phi);
  const z = (rc * (1 - WGS84_E2) + heightKm) * sinPhi;
  const r = Math.hypot(p, z);
  const phiC = Math.asin(z / r);

  // Legendre functions of colatitude θ, Schmidt semi-normalised, and their θ-derivatives.
  const cosT = Math.sin(phiC);
  const sinT = Math.cos(phiC);
  const P: number[][] = [];
  const dP: number[][] = [];
  for (let n = 0; n <= MAX_DEGREE; n++) {
    P.push(new Array<number>(n + 1).fill(0));
    dP.push(new Array<number>(n + 1).fill(0));
  }
  P[0]![0] = 1;
  for (let n = 1; n <= MAX_DEGREE; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        const k = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n));
        P[n]![n] = k * sinT * P[n - 1]![n - 1]!;
        dP[n]![n] = k * (cosT * P[n - 1]![n - 1]! + sinT * dP[n - 1]![n - 1]!);
      } else {
        const a = (2 * n - 1) / Math.sqrt(n * n - m * m);
        const b = n - 2 >= m ? Math.sqrt(((n - 1) * (n - 1) - m * m) / (n * n - m * m)) : 0;
        const p2 = n - 2 >= m ? P[n - 2]![m]! : 0;
        const d2 = n - 2 >= m ? dP[n - 2]![m]! : 0;
        P[n]![m] = a * cosT * P[n - 1]![m]! - b * p2;
        dP[n]![m] = a * (cosT * dP[n - 1]![m]! - sinT * P[n - 1]![m]!) - b * d2;
      }
    }
  }

  // Sum the field (north, east, down in geocentric terms), and its rate of change from the
  // secular-variation coefficients.
  let xc = 0;
  let yc = 0;
  let zc = 0;
  let xd = 0;
  let yd = 0;
  let zd = 0;
  const ratio = REFERENCE_RADIUS / r;
  let scale = ratio * ratio;
  for (let n = 1; n <= MAX_DEGREE; n++) {
    scale *= ratio;
    for (let mm = 0; mm <= n; mm++) {
      const cosM = Math.cos(mm * lambda);
      const sinM = Math.sin(mm * lambda);
      const g = m.g[n]![mm]! + dt * m.gDot[n]![mm]!;
      const h = m.h[n]![mm]! + dt * m.hDot[n]![mm]!;
      const gD = m.gDot[n]![mm]!;
      const hD = m.hDot[n]![mm]!;
      const pnm = P[n]![mm]!;
      const dpnm = dP[n]![mm]!;
      xc += scale * (g * cosM + h * sinM) * dpnm;
      yc += scale * mm * (g * sinM - h * cosM) * pnm;
      zc -= scale * (n + 1) * (g * cosM + h * sinM) * pnm;
      xd += scale * (gD * cosM + hD * sinM) * dpnm;
      yd += scale * mm * (gD * sinM - hD * cosM) * pnm;
      zd -= scale * (n + 1) * (gD * cosM + hD * sinM) * pnm;
    }
  }
  yc /= sinT;
  yd /= sinT;

  // Back to geodetic north and down: rotate by the difference between the two latitudes.
  const psi = phiC - phi;
  const x = xc * Math.cos(psi) - zc * Math.sin(psi);
  const y = yc;
  const xDot = xd * Math.cos(psi) - zd * Math.sin(psi);
  const yDot = yd;

  const h2 = x * x + y * y;
  return {
    declination: Math.atan2(y, x) / rad,
    declinationPerYear: (x * yDot - y * xDot) / h2 / rad,
    horizontal: Math.sqrt(h2),
  };
}

/** An angle's size as written: a tenth of a degree under 10°, whole degrees beyond. */
function magnitude(degrees: number): string {
  const abs = Math.abs(degrees);
  return abs < 9.95 ? abs.toFixed(1) : Math.round(abs).toString();
}

/** "1.4° W", "12° E". */
export function formatAngle(degrees: number, east: string, west: string): string {
  const text = magnitude(degrees);
  if (Number(text) === 0) return '0°';
  return `${text}° ${degrees > 0 ? east : west}`;
}

/**
 * What to do with it: how to turn a bearing taken off the map (true) into one to set on
 * a compass (magnetic). West of true north, add; east, take off.
 *
 * Under a degree it says so instead: a baseplate compass is marked in 2° steps, and
 * "add 0.3°" asks for a precision nobody can set.
 */
export function compassAdvice(field: MagneticField): string | null {
  if (field.horizontal < COMPASS_UNRELIABLE_NT) return null;
  const text = magnitude(field.declination);
  if (Number(text) < 1) return 'Under 1°, less than a compass can be set to: no correction needed.';
  return field.declination < 0
    ? `Add ${text}° to a bearing taken from the map before following it on a compass.`
    : `Take ${text}° off a bearing taken from the map before following it on a compass.`;
}

/** One line for the foot of a printed sheet, which carries its own date. */
export function declinationLine(field: MagneticField): string {
  if (field.horizontal < COMPASS_UNRELIABLE_NT) return 'Compass unreliable here, near the magnetic pole';
  const where = `Magnetic north ${formatAngle(field.declination, 'E', 'W')} of true`;
  const moving =
    Math.abs(field.declinationPerYear) < 0.05 ? '' : `, moving ${formatAngle(field.declinationPerYear, 'E', 'W')} a year`;
  const caution = field.horizontal < COMPASS_CAUTION_NT ? ' · weak field, use with caution' : '';
  return `${where}${moving}${caution}`;
}

/**
 * The declination as a sentence for a walker: which way and how far magnetic north lies
 * from true north, and which way it is moving.
 *
 * The model is good to a few tenths of a degree, and local rock (gabbro on the Cuillin,
 * famously) can pull a needle further than that — which is why this never claims more
 * than a tenth.
 */
export function describeDeclination(field: MagneticField): string {
  if (field.horizontal < COMPASS_UNRELIABLE_NT) {
    return 'This close to the magnetic pole a compass is unreliable.';
  }
  const where =
    Math.abs(field.declination) < 0.05
      ? 'Magnetic north is the same as true north'
      : `Magnetic north is ${formatAngle(field.declination, 'east', 'west')} of true north`;
  const rate = Math.abs(field.declinationPerYear);
  const moving = rate < 0.05 ? 'barely moving' : `moving ${formatAngle(field.declinationPerYear, 'east', 'west')} a year`;
  const caution =
    field.horizontal < COMPASS_CAUTION_NT ? ' The field is weak this near the magnetic pole: use a compass with caution.' : '';
  return `${where}, ${moving}.${caution}`;
}
