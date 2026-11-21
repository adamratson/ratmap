// The kilometre grid printed over a sheet: the OS National Grid in Great Britain, UTM
// everywhere else. A paper map without one gives nothing to read a grid reference off, or
// to take a bearing from with a compass laid on the sheet — which is most of what a
// printed hill map is for.
//
// Pure arithmetic, so it can be checked to the metre against PROJ (grid.test.ts gives the
// reference values and the commands that produced them). A grid that is quietly a hundred
// metres off is worse than none: it reads exactly like a right one.

export type LngLat = [number, number];

export interface Grid {
  /** "OS National Grid", "UTM 30N" — how the sheet names it. */
  name: string;
  /** WGS84 longitude/latitude → easting, northing in metres. */
  toGrid(point: LngLat): [number, number];
  /** Easting, northing in metres → WGS84 longitude/latitude. */
  toLngLat(easting: number, northing: number): LngLat;
  /**
   * The 100 km square a point is in, where the grid names them (OS: "NN"). Null for UTM,
   * whose references carry the zone instead.
   */
  square(easting: number, northing: number): string | null;
}

interface Ellipsoid {
  a: number;
  b: number;
}

interface TransverseMercator {
  ellipsoid: Ellipsoid;
  /** Scale factor on the central meridian. */
  f0: number;
  /** True origin, degrees. */
  lat0: number;
  lon0: number;
  /** False origin, metres. */
  e0: number;
  n0: number;
}

const AIRY_1830: Ellipsoid = { a: 6_377_563.396, b: 6_356_256.909 };
const WGS84: Ellipsoid = { a: 6_378_137, b: 6_356_752.314_245 };

const RAD = Math.PI / 180;
const ARCSEC = RAD / 3600;

const NATIONAL_GRID: TransverseMercator = {
  ellipsoid: AIRY_1830,
  f0: 0.999_601_271_7,
  lat0: 49,
  lon0: -2,
  e0: 400_000,
  n0: -100_000,
};

/**
 * WGS84 → OSGB36, the seven-parameter Helmert transformation the OS publishes (its
 * "A guide to coordinate systems in Great Britain", §6.6). Good to about 3–5 m across
 * Britain, which is a fifth of a millimetre at 1:25 000 — finer than a printed grid line.
 * OSTN15 would be centimetres, but it is a 15 MB grid file to get there.
 */
const WGS84_TO_OSGB36 = {
  tx: -446.448,
  ty: 125.157,
  tz: -542.06,
  /** ppm */
  s: 20.4894,
  /** arcseconds */
  rx: -0.1502,
  ry: -0.247,
  rz: -0.8421,
};

const OSGB36_TO_WGS84 = {
  tx: -WGS84_TO_OSGB36.tx,
  ty: -WGS84_TO_OSGB36.ty,
  tz: -WGS84_TO_OSGB36.tz,
  s: -WGS84_TO_OSGB36.s,
  rx: -WGS84_TO_OSGB36.rx,
  ry: -WGS84_TO_OSGB36.ry,
  rz: -WGS84_TO_OSGB36.rz,
};

/**
 * The grid to print for a sheet centred at `centre`.
 *
 * The National Grid covers Great Britain, the Isle of Man included. Not Ireland, north or
 * south, whose maps use the Irish grids: there, and everywhere else, the UTM zone of the
 * centre, which is what continental maps print and what a GPS will show.
 */
export function gridFor([lng, lat]: LngLat): Grid {
  if (inGreatBritain(lng, lat)) return nationalGrid();
  return utmGrid(utmZone(lng, lat), lat < 0);
}

/**
 * Roughly Great Britain: the National Grid's own extent, less a box round Ireland.
 *
 * The box stops at 55.45° N so Islay and Kintyre, west of Belfast, stay British, and at
 * 51.3° N so Cornwall and the Scillies do. Channel Islands, south of 49.8°, are UTM.
 */
function inGreatBritain(lng: number, lat: number): boolean {
  if (lat < 49.8 || lat > 61.0 || lng < -9 || lng > 2.1) return false;
  const ireland = lat > 51.3 && lat < 55.45 && lng < -5.4;
  return !ireland;
}

export function nationalGrid(): Grid {
  return {
    name: 'OS National Grid',
    toGrid: ([lng, lat]) => {
      const [osLng, osLat] = helmert([lng, lat], WGS84, AIRY_1830, WGS84_TO_OSGB36);
      return toTransverseMercator(NATIONAL_GRID, osLng, osLat);
    },
    toLngLat: (easting, northing) => {
      const [osLng, osLat] = fromTransverseMercator(NATIONAL_GRID, easting, northing);
      return helmert([osLng, osLat], AIRY_1830, WGS84, OSGB36_TO_WGS84);
    },
    square: nationalGridSquare,
  };
}

/** The UTM zone number for a point, with Norway's and Svalbard's exceptions. */
export function utmZone(lng: number, lat: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  let zone = Math.floor((wrapped + 180) / 6) + 1;
  // South-west Norway is all one zone, 32V, widened over the sea to the west of it.
  if (lat >= 56 && lat < 64 && wrapped >= 3 && wrapped < 12) zone = 32;
  // Svalbard: 31X, 33X, 35X and 37X, each widened to cover the even zones between.
  if (lat >= 72 && lat < 84) {
    if (wrapped >= 0 && wrapped < 9) zone = 31;
    else if (wrapped >= 9 && wrapped < 21) zone = 33;
    else if (wrapped >= 21 && wrapped < 33) zone = 35;
    else if (wrapped >= 33 && wrapped < 42) zone = 37;
  }
  return zone;
}

export function utmGrid(zone: number, south: boolean): Grid {
  const projection: TransverseMercator = {
    ellipsoid: WGS84,
    f0: 0.9996,
    lat0: 0,
    lon0: zone * 6 - 183,
    e0: 500_000,
    n0: south ? 10_000_000 : 0,
  };
  return {
    name: `UTM ${zone}${south ? 'S' : 'N'}`,
    toGrid: ([lng, lat]) => toTransverseMercator(projection, lng, lat),
    toLngLat: (easting, northing) => fromTransverseMercator(projection, easting, northing),
    square: () => null,
  };
}

/**
 * The National Grid's two-letter 100 km square: "NN" for Ben Nevis. The first letter is the
 * 500 km square, the second the 100 km square inside it, each a 5 × 5 of the alphabet
 * without I, counted from the top left.
 */
export function nationalGridSquare(easting: number, northing: number): string | null {
  const e100 = Math.floor(easting / 100_000);
  const n100 = Math.floor(northing / 100_000);
  if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return null;

  let first = 19 - n100 - ((19 - n100) % 5) + Math.floor((e100 + 10) / 5);
  let second = (((19 - n100) * 5) % 25) + (e100 % 5);
  if (first > 7) first++;
  if (second > 7) second++;
  return String.fromCharCode(65 + first, 65 + second);
}

/**
 * How far grid north is turned from true north at a point, in degrees: positive east.
 * What a compass user needs, beside the magnetic declination, to turn a bearing read off
 * the grid lines into one to walk.
 */
export function gridConvergence(grid: Grid, point: LngLat): number {
  const [e, n] = grid.toGrid(point);
  const [lng1, lat1] = grid.toLngLat(e, n);
  const [lng2, lat2] = grid.toLngLat(e, n + 1000);
  // Initial bearing, true, from the point to 1 km up the grid.
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const dLambda = (lng2 - lng1) * RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const bearing = Math.atan2(y, x) / RAD;
  return bearing > 180 ? bearing - 360 : bearing;
}

/**
 * OSGB36 longitude/latitude straight onto the National Grid, no datum shift. Only for
 * checking the projection against the OS's own worked example, which starts from OSGB36.
 */
export function osgb36ToNationalGrid(lng: number, lat: number): [number, number] {
  return toTransverseMercator(NATIONAL_GRID, lng, lat);
}

// --- Transverse Mercator -----------------------------------------------------------------
//
// The OS's series (the guide's Annex C), which it gives for the National Grid and which is
// the same Transverse Mercator UTM uses with WGS84's ellipsoid and its own origin. Within
// 3° of the central meridian — all of Britain, all of any UTM zone — it is good to a
// millimetre.

function meridionalArc({ ellipsoid: { b }, f0, lat0 }: TransverseMercator, n: number, phi: number): number {
  const phi0 = lat0 * RAD;
  const n2 = n * n;
  const n3 = n2 * n;
  const d = phi - phi0;
  const s = phi + phi0;
  return (
    b *
    f0 *
    ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * d -
      (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(d) * Math.cos(s) +
      ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * d) * Math.cos(2 * s) -
      (35 / 24) * n3 * Math.sin(3 * d) * Math.cos(3 * s))
  );
}

function toTransverseMercator(tm: TransverseMercator, lng: number, lat: number): [number, number] {
  const { a, b } = tm.ellipsoid;
  const { f0, e0, n0 } = tm;
  const phi = lat * RAD;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);

  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const tan2 = tan * tan;
  const tan4 = tan2 * tan2;
  const nu = (a * f0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * f0 * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const eta2 = nu / rho - 1;

  const m = meridionalArc(tm, n, phi);
  const i = m + n0;
  const ii = (nu / 2) * sin * cos;
  const iii = (nu / 24) * sin * cos ** 3 * (5 - tan2 + 9 * eta2);
  const iiia = (nu / 720) * sin * cos ** 5 * (61 - 58 * tan2 + tan4);
  const iv = nu * cos;
  const v = (nu / 6) * cos ** 3 * (nu / rho - tan2);
  const vi = (nu / 120) * cos ** 5 * (5 - 18 * tan2 + tan4 + 14 * eta2 - 58 * tan2 * eta2);

  const dl = (lng - tm.lon0) * RAD;
  const northing = i + ii * dl ** 2 + iii * dl ** 4 + iiia * dl ** 6;
  const easting = e0 + iv * dl + v * dl ** 3 + vi * dl ** 5;
  return [easting, northing];
}

function fromTransverseMercator(tm: TransverseMercator, easting: number, northing: number): LngLat {
  const { a, b } = tm.ellipsoid;
  const { f0, e0, n0 } = tm;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);

  let phi = (northing - n0) / (a * f0) + tm.lat0 * RAD;
  let m = meridionalArc(tm, n, phi);
  // To a hundredth of a millimetre; converges in three or four steps.
  for (let i = 0; i < 20 && Math.abs(northing - n0 - m) >= 0.000_01; i++) {
    phi += (northing - n0 - m) / (a * f0);
    m = meridionalArc(tm, n, phi);
  }

  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const tan2 = tan * tan;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;
  const sec = 1 / cos;
  const nu = (a * f0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * f0 * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const eta2 = nu / rho - 1;

  const vii = tan / (2 * rho * nu);
  const viii = (tan / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const ix = (tan / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const x = sec / nu;
  const xi = (sec / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const xii = (sec / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const xiia = (sec / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const de = easting - e0;
  const lat = phi - vii * de ** 2 + viii * de ** 4 - ix * de ** 6;
  const lng = tm.lon0 * RAD + x * de - xi * de ** 3 + xii * de ** 5 - xiia * de ** 7;
  return [lng / RAD, lat / RAD];
}

// --- Datum shift ---------------------------------------------------------------------------

interface HelmertParams {
  tx: number;
  ty: number;
  tz: number;
  s: number;
  rx: number;
  ry: number;
  rz: number;
}

/** Longitude/latitude on one ellipsoid → the same place on another, at height 0. */
function helmert([lng, lat]: LngLat, from: Ellipsoid, to: Ellipsoid, t: HelmertParams): LngLat {
  const [x, y, z] = toCartesian(from, lng, lat);
  const s = 1 + t.s * 1e-6;
  const rx = t.rx * ARCSEC;
  const ry = t.ry * ARCSEC;
  const rz = t.rz * ARCSEC;
  return fromCartesian(
    to,
    t.tx + s * x - rz * y + ry * z,
    t.ty + rz * x + s * y - rx * z,
    t.tz - ry * x + rx * y + s * z,
  );
}

function toCartesian({ a, b }: Ellipsoid, lng: number, lat: number): [number, number, number] {
  const phi = lat * RAD;
  const lambda = lng * RAD;
  const e2 = 1 - (b * b) / (a * a);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [
    nu * Math.cos(phi) * Math.cos(lambda),
    nu * Math.cos(phi) * Math.sin(lambda),
    (1 - e2) * nu * Math.sin(phi),
  ];
}

function fromCartesian({ a, b }: Ellipsoid, x: number, y: number, z: number): LngLat {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const next = Math.atan2(z + e2 * nu * Math.sin(phi), p);
    if (Math.abs(next - phi) < 1e-12) {
      phi = next;
      break;
    }
    phi = next;
  }
  return [Math.atan2(y, x) / RAD, phi / RAD];
}

// --- Lines on the sheet ----------------------------------------------------------------------

export interface GridLine {
  /** Easting for a vertical line, northing for a horizontal one, metres. */
  value: number;
  /** Along the line, enough points that drawing straight between them is exact on paper. */
  points: LngLat[];
}

export interface GridLines {
  grid: Grid;
  spacing: number;
  eastings: GridLine[];
  northings: GridLine[];
}

/**
 * Every grid line, `spacing` metres apart, that crosses the area inside `corners` (the
 * sheet's four corners, any order).
 *
 * Each line is sampled rather than drawn corner to corner: on a north-up Mercator sheet a
 * grid line is very nearly straight, but not quite, and the points cost nothing.
 */
export function gridLines(grid: Grid, corners: readonly LngLat[], spacing = 1000): GridLines {
  const projected = corners.map((corner) => grid.toGrid(corner));
  const es = projected.map(([e]) => e);
  const ns = projected.map(([, n]) => n);
  // A line's ends run a square past the corners: the sheet's edges are not grid-aligned,
  // so a line that starts at the lowest corner's northing would stop short of the others.
  const minE = Math.min(...es) - spacing;
  const maxE = Math.max(...es) + spacing;
  const minN = Math.min(...ns) - spacing;
  const maxN = Math.max(...ns) + spacing;

  const SAMPLES = 16;
  const along = (from: number, to: number): number[] =>
    Array.from({ length: SAMPLES + 1 }, (_, i) => from + ((to - from) * i) / SAMPLES);

  const eastings: GridLine[] = [];
  for (let e = Math.ceil(minE / spacing) * spacing; e <= maxE; e += spacing) {
    eastings.push({ value: e, points: along(minN, maxN).map((n) => grid.toLngLat(e, n)) });
  }
  const northings: GridLine[] = [];
  for (let n = Math.ceil(minN / spacing) * spacing; n <= maxN; n += spacing) {
    northings.push({ value: n, points: along(minE, maxE).map((e) => grid.toLngLat(e, n)) });
  }
  return { grid, spacing, eastings, northings };
}

/**
 * How a grid line is labelled at the sheet's edge: its kilometre within the 100 km square,
 * two digits, the way OS and continental maps both print it. A line on a 100 km boundary
 * says which square starts there instead, so the letters are on the sheet wherever they
 * change.
 */
export function gridLabel(grid: Grid, value: number, axis: 'easting' | 'northing', other: number): string {
  const km = Math.round(value / 1000);
  const inSquare = ((km % 100) + 100) % 100;
  if (inSquare === 0) {
    const square =
      axis === 'easting' ? grid.square(value + 1, other) : grid.square(other, value + 1);
    if (square) return square;
  }
  return String(inSquare).padStart(2, '0');
}
