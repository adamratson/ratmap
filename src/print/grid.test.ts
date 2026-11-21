import { describe, expect, it } from 'vitest';
import {
  gridConvergence,
  gridFor,
  gridLabel,
  gridLines,
  nationalGrid,
  nationalGridSquare,
  osgb36ToNationalGrid,
  utmGrid,
  utmZone,
  type LngLat,
} from './grid';

// Reference values from PROJ 9 (cs2cs). The National Grid ones use the same Helmert
// parameters as grid.ts, so they should agree to the centimetre:
//
//   cs2cs +proj=longlat +datum=WGS84 +to +proj=tmerc +lat_0=49 +lon_0=-2 \
//     +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy \
//     +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489
//
// and EPSG:27700 (PROJ's own pipeline) to within the Helmert's few metres.
const NATIONAL_GRID_CASES: { at: LngLat; helmert: [number, number]; epsg: [number, number] }[] = [
  { at: [-5.00361, 56.79694], helmert: [216671.431, 771291.81], epsg: [216670.696, 771293.717] },
  { at: [-1.5, 51.0], helmert: [435182.161, 122408.731], epsg: [435181.453, 122409.508] },
  { at: [1.7, 52.6], helmert: [650655.969, 306675.475], epsg: [650654.539, 306672.616] },
  { at: [-7.0, 57.5], helmert: [100596.893, 856566.128], epsg: [100596.338, 856569.64] },
  { at: [-3.2, 55.95], helmert: [325160.297, 673646.563], epsg: [325160.381, 673647.073] },
];

describe('the National Grid', () => {
  it('projects the OS guide’s worked example to the millimetre', () => {
    // "A guide to coordinate systems in Great Britain", Annex C: 52°39′27.2531″N,
    // 1°43′4.5177″E (OSGB36) is E 651409.903, N 313177.270.
    const lat = 52 + 39 / 60 + 27.2531 / 3600;
    const lng = 1 + 43 / 60 + 4.5177 / 3600;
    const [e, n] = osgb36ToNationalGrid(lng, lat);
    expect(e).toBeCloseTo(651409.903, 2);
    expect(n).toBeCloseTo(313177.27, 2);
  });

  it.each(NATIONAL_GRID_CASES)('matches PROJ at $at', ({ at, helmert, epsg }) => {
    const [e, n] = nationalGrid().toGrid(at);
    expect(Math.abs(e - helmert[0])).toBeLessThan(0.05);
    expect(Math.abs(n - helmert[1])).toBeLessThan(0.05);
    expect(Math.hypot(e - epsg[0], n - epsg[1])).toBeLessThan(5);
  });

  it('comes back to where it started', () => {
    const grid = nationalGrid();
    for (const { at } of NATIONAL_GRID_CASES) {
      const [lng, lat] = grid.toLngLat(...grid.toGrid(at));
      expect(lng).toBeCloseTo(at[0], 7);
      expect(lat).toBeCloseTo(at[1], 7);
    }
  });

  it('names the 100 km squares', () => {
    expect(nationalGridSquare(216671, 771291)).toBe('NN'); // Ben Nevis
    expect(nationalGridSquare(325160, 673646)).toBe('NT'); // Edinburgh
    expect(nationalGridSquare(530000, 180000)).toBe('TQ'); // London
    expect(nationalGridSquare(80000, 830000)).toBe('NF'); // South Uist
    expect(nationalGridSquare(100596, 856566)).toBe('NG'); // just east of it
    expect(nationalGridSquare(-1, 0)).toBeNull();
  });

  it('labels a line by its kilometre, or by the square that starts on it', () => {
    const grid = nationalGrid();
    expect(gridLabel(grid, 216000, 'easting', 771000)).toBe('16');
    expect(gridLabel(grid, 771000, 'northing', 216000)).toBe('71');
    expect(gridLabel(grid, 205000, 'easting', 771000)).toBe('05');
    // 200 km east is where NN starts, going east from NM.
    expect(gridLabel(grid, 200000, 'easting', 771000)).toBe('NN');
    expect(gridLabel(grid, 700000, 'northing', 216000)).toBe('NN');
  });

  it('turns grid north west of true, west of the central meridian', () => {
    // 2° W is the meridian the grid is true along; Ben Nevis is three degrees west of it.
    const convergence = gridConvergence(nationalGrid(), [-5.00361, 56.79694]);
    expect(convergence).toBeLessThan(-2.3);
    expect(convergence).toBeGreaterThan(-2.7);
    expect(Math.abs(gridConvergence(nationalGrid(), [-2, 55]))).toBeLessThan(0.01);
  });
});

describe('UTM', () => {
  it.each([
    // cs2cs +proj=longlat +datum=WGS84 +to +proj=utm +zone=<z> [+south] +datum=WGS84
    { at: [-79.3871, 43.6426] as LngLat, zone: 17, south: false, expected: [630087.38, 4833442.31] },
    { at: [18.4, 69.65] as LngLat, zone: 34, south: false, expected: [399118.497, 7728989.348] },
    { at: [7.65, 45.97] as LngLat, zone: 32, south: false, expected: [395410.209, 5091600.276] },
    { at: [-70, -33.4] as LngLat, zone: 19, south: true, expected: [407006.09, 6303920.836] },
  ])('matches PROJ in zone $zone', ({ at, zone, south, expected }) => {
    const grid = utmGrid(zone, south);
    const [e, n] = grid.toGrid(at);
    expect(Math.abs(e - expected[0])).toBeLessThan(0.01);
    expect(Math.abs(n - expected[1])).toBeLessThan(0.01);
    const [lng, lat] = grid.toLngLat(e, n);
    expect(lng).toBeCloseTo(at[0], 7);
    expect(lat).toBeCloseTo(at[1], 7);
  });

  it('picks the zone, with Norway’s and Svalbard’s exceptions', () => {
    expect(utmZone(-5, 56.8)).toBe(30);
    expect(utmZone(7.65, 45.97)).toBe(32);
    expect(utmZone(19.2, 42.4)).toBe(34); // Montenegro
    expect(utmZone(5.3, 60.4)).toBe(32); // Bergen: 31 by longitude, 32V by rule
    expect(utmZone(15.6, 78.2)).toBe(33); // Longyearbyen
    expect(utmZone(179.9, 0)).toBe(60);
    expect(utmZone(-180, 0)).toBe(1);
  });
});

describe('choosing the grid', () => {
  it('uses the National Grid in Great Britain', () => {
    expect(gridFor([-5.0, 56.8]).name).toBe('OS National Grid'); // Lochaber
    expect(gridFor([-6.2, 55.8]).name).toBe('OS National Grid'); // Islay
    expect(gridFor([-5.7, 50.07]).name).toBe('OS National Grid'); // Land’s End
    expect(gridFor([-3.0, 53.0]).name).toBe('OS National Grid'); // Snowdonia
  });

  it('uses UTM in Ireland and everywhere else', () => {
    expect(gridFor([-5.93, 54.6]).name).toBe('UTM 30N'); // Belfast
    expect(gridFor([-6.26, 53.35]).name).toBe('UTM 29N'); // Dublin
    expect(gridFor([19.2, 42.4]).name).toBe('UTM 34N'); // Montenegro
    expect(gridFor([-2.2, 49.2]).name).toBe('UTM 30N'); // Jersey
  });
});

describe('grid lines over a sheet', () => {
  it('draws every kilometre line across the sheet, and a square past it', () => {
    const grid = nationalGrid();
    // A sheet round Ben Nevis about 4 km across.
    const corners: LngLat[] = [
      [-5.04, 56.78],
      [-4.97, 56.78],
      [-4.97, 56.815],
      [-5.04, 56.815],
    ];
    const { eastings, northings } = gridLines(grid, corners);
    const es = eastings.map((line) => line.value / 1000);
    const ns = northings.map((line) => line.value / 1000);
    // Every line is on a whole kilometre, and the run is unbroken.
    expect(es.every(Number.isInteger)).toBe(true);
    expect(es).toEqual(es.map((_, i) => es[0] + i));
    expect(ns).toEqual(ns.map((_, i) => ns[0] + i));
    // Ben Nevis's own square is on it.
    expect(es).toContain(216);
    expect(ns).toContain(771);
    // Each line is sampled along its length, and runs past both edges of the sheet.
    const line = eastings.find((candidate) => candidate.value === 216000)!;
    const lats = line.points.map(([, lat]) => lat);
    expect(Math.min(...lats)).toBeLessThan(56.78);
    expect(Math.max(...lats)).toBeGreaterThan(56.815);
  });
});
