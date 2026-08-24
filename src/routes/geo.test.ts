import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  bboxContains,
  densify,
  distanceMetres,
  formatDistance,
  nearestPointOnPath,
  pathLengthMetres,
  pointAlongPath,
  type LngLat,
} from './geo';

// Ben Nevis summit and the Glen Nevis visitor centre — a real pair with a known
// separation, so the distance figures below are checkable against something outside this
// file rather than against themselves.
const BEN_NEVIS: LngLat = [-5.0037, 56.7969];
const GLEN_NEVIS: LngLat = [-5.0611, 56.7963];

describe('distanceMetres', () => {
  it('measures a known separation', () => {
    // ~3.5 km west along the glen.
    expect(distanceMetres(BEN_NEVIS, GLEN_NEVIS)).toBeGreaterThan(3400);
    expect(distanceMetres(BEN_NEVIS, GLEN_NEVIS)).toBeLessThan(3600);
  });

  it('is zero for a point against itself', () => {
    expect(distanceMetres(BEN_NEVIS, BEN_NEVIS)).toBe(0);
  });

  it('is symmetric', () => {
    expect(distanceMetres(BEN_NEVIS, GLEN_NEVIS)).toBeCloseTo(
      distanceMetres(GLEN_NEVIS, BEN_NEVIS),
      6,
    );
  });

  it('measures one degree of latitude as ~111 km', () => {
    expect(distanceMetres([0, 0], [0, 1])).toBeCloseTo(111_195, -2);
  });
});

describe('pathLengthMetres', () => {
  it('sums the segments', () => {
    const mid: LngLat = [-5.03, 56.796];
    expect(pathLengthMetres([BEN_NEVIS, mid, GLEN_NEVIS])).toBeCloseTo(
      distanceMetres(BEN_NEVIS, mid) + distanceMetres(mid, GLEN_NEVIS),
      6,
    );
  });

  it('is zero for a single point', () => {
    expect(pathLengthMetres([BEN_NEVIS])).toBe(0);
  });
});

describe('nearestPointOnPath', () => {
  const line: LngLat[] = [
    [0, 0],
    [0.01, 0],
  ];

  it('projects onto the segment interior, not the nearest vertex', () => {
    // Directly north of the segment's midpoint. Vertex snapping would report ~550 m
    // (half the segment) instead of the true perpendicular offset.
    const result = nearestPointOnPath(line, [0.005, 0.0009]);
    expect(result).not.toBeNull();
    expect(result!.point[0]).toBeCloseTo(0.005, 6);
    expect(result!.point[1]).toBeCloseTo(0, 6);
    expect(result!.distanceM).toBeCloseTo(100, 0);
    expect(result!.t).toBeCloseTo(0.5, 3);
  });

  it('clamps beyond the ends rather than extrapolating', () => {
    const result = nearestPointOnPath(line, [-0.01, 0]);
    expect(result!.t).toBe(0);
    expect(result!.point[0]).toBeCloseTo(0, 6);
    expect(result!.alongM).toBeCloseTo(0, 3);
  });

  it('reports distance travelled along the path', () => {
    const zigzag: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
    ];
    // Midway along the *second* of two equal legs, so three quarters of the whole.
    const result = nearestPointOnPath(zigzag, [0.01, 0.005]);
    expect(result!.alongM).toBeCloseTo((pathLengthMetres(zigzag) * 3) / 4, -1);
  });

  it('survives duplicate vertices', () => {
    // Tile geometry quantised to a grid routinely produces these; a naive projection
    // divides by a zero-length segment and returns NaN.
    const dupes: LngLat[] = [
      [0, 0],
      [0, 0],
      [0.01, 0],
    ];
    const result = nearestPointOnPath(dupes, [0.005, 0]);
    expect(Number.isFinite(result!.distanceM)).toBe(true);
  });

  it('returns null for an empty path', () => {
    expect(nearestPointOnPath([], BEN_NEVIS)).toBeNull();
  });
});

describe('pointAlongPath', () => {
  const line: LngLat[] = [
    [0, 0],
    [0.01, 0],
  ];

  it('interpolates within a segment', () => {
    const half = pathLengthMetres(line) / 2;
    expect(pointAlongPath(line, half)![0]).toBeCloseTo(0.005, 6);
  });

  it('clamps past the end instead of extrapolating', () => {
    expect(pointAlongPath(line, 1e9)).toEqual([0.01, 0]);
  });

  it('clamps before the start', () => {
    expect(pointAlongPath(line, -5)).toEqual([0, 0]);
  });
});

describe('densify', () => {
  it('splits long segments to the requested spacing', () => {
    const long: LngLat[] = [
      [0, 0],
      [0.01, 0],
    ];
    const dense = densify(long, 100);
    expect(dense.length).toBeGreaterThan(10);
    for (let i = 1; i < dense.length; i++) {
      expect(distanceMetres(dense[i - 1], dense[i])).toBeLessThanOrEqual(101);
    }
  });

  it('keeps the original endpoints exactly', () => {
    const line: LngLat[] = [
      [0, 0],
      [0.01, 0.01],
    ];
    const dense = densify(line, 100);
    expect(dense[0]).toEqual(line[0]);
    expect(dense[dense.length - 1]).toEqual(line[1]);
  });

  it('leaves short segments alone', () => {
    const short: LngLat[] = [
      [0, 0],
      [0.0001, 0],
    ];
    expect(densify(short, 1000)).toEqual(short);
  });
});

describe('boundsOf', () => {
  it('covers every point', () => {
    const bbox = boundsOf([BEN_NEVIS, GLEN_NEVIS])!;
    expect(bboxContains(bbox, BEN_NEVIS)).toBe(true);
    expect(bboxContains(bbox, GLEN_NEVIS)).toBe(true);
  });

  it('pads by a metre distance in both axes', () => {
    const tight = boundsOf([BEN_NEVIS])!;
    const padded = boundsOf([BEN_NEVIS], 1000)!;
    expect(padded[0]).toBeLessThan(tight[0]);
    expect(padded[3]).toBeGreaterThan(tight[3]);
    // At 57°N a kilometre of longitude is ~1.8x a kilometre of latitude in degrees.
    const lngPad = tight[0] - padded[0];
    const latPad = padded[3] - tight[3];
    expect(lngPad / latPad).toBeCloseTo(1 / Math.cos((56.7969 * Math.PI) / 180), 1);
  });

  it('returns null for no points', () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe('formatDistance', () => {
  it('uses metres below a kilometre', () => {
    expect(formatDistance(450)).toBe('450 m');
  });

  it('uses kilometres above', () => {
    expect(formatDistance(12_400)).toBe('12.4 km');
    expect(formatDistance(1_234)).toBe('1.23 km');
  });

  it('does not invent a figure for a non-number', () => {
    expect(formatDistance(NaN)).toBe('—');
  });
});
