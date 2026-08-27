import { describe, expect, it } from 'vitest';
import { renderProfileChart } from './profile-chart';
import { buildProfile } from './profile';
import type { LngLat } from './geo';

/** Four points, 1 km apart, for readable distances. */
const line: LngLat[] = [
  [0, 0],
  [0.009, 0],
  [0.018, 0],
  [0.027, 0],
];

describe('renderProfileChart current-position marker', () => {
  it('draws nothing without a currentDistanceM', () => {
    const profile = buildProfile(line, [100, 110, 120, 130]);
    const svg = renderProfileChart(profile)!;
    expect(svg.querySelector('.profile-position')).toBeNull();
  });

  it('places the marker at the interpolated elevation for a mid-leg distance', () => {
    const profile = buildProfile(line, [100, 110, 120, 130]);
    const halfway = profile.points[2].distanceM / 2; // between points[1] and points[2]
    const svg = renderProfileChart(profile, { currentDistanceM: halfway })!;
    const marker = svg.querySelector('.profile-position')!;
    expect(marker).not.toBeNull();

    // x should land between the x of points[1] and points[2].
    const width = 320;
    const totalM = profile.points[profile.points.length - 1].distanceM;
    const expectedX = (halfway / totalM) * width;
    expect(Number(marker.getAttribute('cx'))).toBeCloseTo(expectedX, 1);
  });

  it('omits the marker when the distance falls outside the route', () => {
    const profile = buildProfile(line, [100, 110, 120, 130]);
    const totalM = profile.points[profile.points.length - 1].distanceM;
    const svg = renderProfileChart(profile, { currentDistanceM: totalM + 500 })!;
    expect(svg.querySelector('.profile-position')).toBeNull();
  });

  it('omits the marker when it lands inside a DEM coverage gap', () => {
    const profile = buildProfile(line, [100, null, 120, 130]);
    const gapDistance = (profile.points[0].distanceM + profile.points[2].distanceM) / 2;
    const svg = renderProfileChart(profile, { currentDistanceM: gapDistance })!;
    expect(svg.querySelector('.profile-position')).toBeNull();
  });
});
