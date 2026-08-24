import { describe, expect, it } from 'vitest';
import { buildProfile, profileSampleCoords, SAMPLE_SPACING_M } from './profile';
import { distanceMetres, pathLengthMetres, type LngLat } from './geo';

const START: LngLat = [-5.076, 56.809];
const SUMMIT: LngLat = [-5.0037, 56.7969];

describe('profileSampleCoords', () => {
  it('densifies to roughly the DEM resolution', () => {
    const coords = profileSampleCoords([START, SUMMIT]);
    for (let i = 1; i < coords.length; i++) {
      expect(distanceMetres(coords[i - 1], coords[i])).toBeLessThanOrEqual(SAMPLE_SPACING_M + 1);
    }
  });

  it('widens the spacing rather than truncating a very long route', () => {
    // ~700 km. At 25 m that would be 28,000 samples.
    const long: LngLat[] = [
      [-5, 56],
      [-5, 62.3],
    ];
    const coords = profileSampleCoords(long);
    expect(coords.length).toBeLessThanOrEqual(2500);
    // The whole route is still covered — a truncated profile would describe part of the
    // route as if it were all of it.
    expect(coords[coords.length - 1]).toEqual(long[1]);
    expect(pathLengthMetres(coords)).toBeCloseTo(pathLengthMetres(long), -1);
  });

  it('handles a single point and an empty route', () => {
    expect(profileSampleCoords([START])).toEqual([START]);
    expect(profileSampleCoords([])).toEqual([]);
  });
});

describe('buildProfile', () => {
  /** Three points a kilometre apart along a line, for readable distances. */
  const line: LngLat[] = [
    [0, 0],
    [0.009, 0],
    [0.018, 0],
  ];

  it('measures distance along the route', () => {
    const profile = buildProfile(line, [0, 100, 200]);
    expect(profile.points[0].distanceM).toBe(0);
    expect(profile.points[2].distanceM).toBeCloseTo(pathLengthMetres(line), 6);
  });

  it('totals a steady climb', () => {
    const profile = buildProfile(line, [0, 100, 200]);
    expect(profile.ascentM).toBeCloseTo(200, 0);
    expect(profile.descentM).toBe(0);
  });

  it('totals an out-and-back as equal climb and drop', () => {
    const profile = buildProfile(line, [0, 300, 0]);
    expect(profile.ascentM).toBeCloseTo(300, 0);
    expect(profile.descentM).toBeCloseTo(300, 0);
  });

  it('does not turn DEM noise into phantom climb', () => {
    // A flat kilometre sampled 400 times with metre-level noise. Summing consecutive
    // differences would report a couple of hundred metres of ascent on a level path —
    // the specific failure ASCENT_THRESHOLD_M exists to stop.
    const flat: LngLat[] = [];
    const noisy: number[] = [];
    for (let i = 0; i < 400; i++) {
      flat.push([i * 0.00002, 0]);
      noisy.push(100 + Math.sin(i * 1.7) * 1.5 + Math.cos(i * 0.9) * 1.2);
    }
    const profile = buildProfile(flat, noisy);
    expect(profile.ascentM).toBe(0);
    expect(profile.descentM).toBe(0);
  });

  it('still counts a real climb buried in noise', () => {
    const coords: LngLat[] = [];
    const elevations: number[] = [];
    for (let i = 0; i < 400; i++) {
      coords.push([i * 0.00002, 0]);
      elevations.push(i * 2 + Math.sin(i * 1.7) * 1.5);
    }
    const profile = buildProfile(coords, elevations);
    // 798 m of real climb; the threshold may shave a few metres off, never hundreds.
    expect(profile.ascentM).toBeGreaterThan(780);
    expect(profile.ascentM).toBeLessThan(805);
  });

  it('reports min and max', () => {
    const profile = buildProfile(line, [340, 1345, 900]);
    expect(profile.minEle).toBe(340);
    expect(profile.maxEle).toBe(1345);
  });

  it('reports partial DEM coverage instead of guessing', () => {
    const profile = buildProfile(line, [100, null, 200]);
    expect(profile.coverage).toBeCloseTo(2 / 3, 6);
    expect(profile.points[1].ele).toBeNull();
  });

  it('reports no coverage rather than zero elevation', () => {
    // The failure mode queryTerrainElevation has: an unloaded DEM tile reads as 0 m,
    // which is indistinguishable from sea level. A gap must stay a gap.
    const profile = buildProfile(line, [null, null, null]);
    expect(profile.coverage).toBe(0);
    expect(profile.minEle).toBeNull();
    expect(profile.maxEle).toBeNull();
    expect(profile.ascentM).toBe(0);
  });

  it('treats a non-finite height as missing', () => {
    const profile = buildProfile(line, [100, NaN, 200]);
    expect(profile.points[1].ele).toBeNull();
  });

  it('handles an empty route', () => {
    const profile = buildProfile([], []);
    expect(profile.points).toEqual([]);
    expect(profile.coverage).toBe(0);
  });
});
