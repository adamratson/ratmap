import { describe, expect, it, vi } from 'vitest';
import { fromGeojsonVt } from 'vt-pbf';
import type { PMTiles } from 'pmtiles';
import { globalToLngLat } from './path-tiles';
import type { LngLat } from './geo';
import { SacSampler, decodeSacLines, summariseSacGrades } from './sac-sampler';

const EXTENT = 4096;
const Z = 15;
const WORLD = EXTENT * 2 ** Z;
// A z15 tile over Ben Nevis — real coordinates, so the metres-per-unit scaling is
// exercised at a real latitude rather than at the equator where it is 1.
const TILE = { z: Z, x: 15928, y: 10072 };

interface FakeFeature {
  points: number[][];
  tags: Record<string, string | number>;
}

function encodeTile(features: FakeFeature[], extent = EXTENT): Uint8Array {
  return fromGeojsonVt(
    { sac: { features: features.map((f) => ({ type: 2, geometry: [f.points], tags: f.tags })) } },
    { version: 2, extent },
  );
}

/** Tile-local coordinates → [lng, lat], so tests can speak in tile units. */
function local(x: number, y: number, tile = TILE): LngLat {
  return globalToLngLat(tile.x * EXTENT + x, tile.y * EXTENT + y, WORLD);
}

function archiveOf(tiles: Map<string, Uint8Array>): PMTiles & { getZxy: ReturnType<typeof vi.fn> } {
  const getZxy = vi.fn(async (_z: number, x: number, y: number) => {
    const data = tiles.get(`${x}/${y}`);
    return data ? { data: data.buffer as ArrayBuffer } : undefined;
  });
  return { getZxy } as unknown as PMTiles & { getZxy: typeof getZxy };
}

/** One tile holding a single east-west graded way across the middle of it. */
function samplerWithEastWestPath(grade = 3, tile = TILE): SacSampler {
  const tiles = new Map([
    [
      `${tile.x}/${tile.y}`,
      encodeTile([{ points: [[1000, 2000], [3000, 2000]], tags: { t: grade, name: 'Test path' } }]),
    ],
  ]);
  return new SacSampler({ archive: archiveOf(tiles), maxzoom: Z });
}

describe('decodeSacLines', () => {
  it('reads grade and name into global tile units', () => {
    const bytes = encodeTile([
      { points: [[10, 20], [30, 40]], tags: { t: 4, name: 'Ledge Route' } },
    ]);

    const { lines } = decodeSacLines(bytes, TILE);

    expect(lines).toHaveLength(1);
    expect(lines[0].grade).toBe(4);
    expect(lines[0].name).toBe('Ledge Route');
    expect(lines[0].coords.slice(0, 2)).toEqual([TILE.x * EXTENT + 10, TILE.y * EXTENT + 20]);
  });

  it('drops features whose grade is not T1-T6', () => {
    const bytes = encodeTile([
      { points: [[10, 20], [30, 40]], tags: { t: 0 } },
      { points: [[10, 20], [30, 40]], tags: { t: 7 } },
      { points: [[10, 20], [30, 40]], tags: { name: 'ungraded' } },
      { points: [[10, 20], [30, 40]], tags: { t: 2 } },
    ]);

    const { lines } = decodeSacLines(bytes, TILE);

    expect(lines.map((line) => line.grade)).toEqual([2]);
  });

  it('rescales a tile whose extent is not 4096', () => {
    // Global units are `tile.x * 4096 + local`; a tile at extent 8192 would otherwise
    // land its geometry a whole tile away.
    const bytes = encodeTile([{ points: [[2000, 4000], [4000, 4000]], tags: { t: 1 } }], 8192);

    const { lines } = decodeSacLines(bytes, TILE);

    expect(lines[0].coords.slice(0, 2)).toEqual([TILE.x * EXTENT + 1000, TILE.y * EXTENT + 2000]);
  });

  it('returns nothing for a tile with no sac layer', () => {
    const bytes = fromGeojsonVt({ roads: { features: [] } }, { version: 2, extent: EXTENT });
    expect(decodeSacLines(bytes, TILE).lines).toEqual([]);
  });
});

describe('SacSampler', () => {
  it('grades a route running along a graded way', async () => {
    const sampler = samplerWithEastWestPath(3);

    const grades = await sampler.grades([local(1500, 2000), local(2000, 2000), local(2500, 2000)]);

    expect(grades).toEqual([3, 3, 3]);
  });

  it('leaves a route beyond the tolerance ungraded', async () => {
    const sampler = samplerWithEastWestPath(3);

    // ~33 m north of the graded way at this latitude — a different path, not this one.
    const grades = await sampler.grades([local(1500, 1800), local(2000, 1800), local(2500, 1800)]);

    expect(grades).toEqual([null, null, null]);
  });

  it('does not take the grade of a way it merely crosses', async () => {
    const sampler = samplerWithEastWestPath(5);

    // Running south to north straight over the graded way: the middle sample is right on
    // it, but a crossing is not a shared stretch.
    const grades = await sampler.grades([local(2000, 1900), local(2000, 2000), local(2000, 2100)]);

    expect(grades).toEqual([null, null, null]);
  });

  it('grades a way tagged in the opposite direction to the walk', async () => {
    const sampler = samplerWithEastWestPath(2);

    const grades = await sampler.grades([local(2500, 2000), local(1500, 2000)]);

    expect(grades).toEqual([2, 2]);
  });

  it('reads the neighbouring tile for a sample near the edge', async () => {
    // The graded way lives in the tile to the east, a few metres past the boundary. A
    // sampler that only looked in the sample's own tile would report a gap at every seam.
    const east = { ...TILE, x: TILE.x + 1 };
    const tiles = new Map([
      [
        `${east.x}/${east.y}`,
        encodeTile([{ points: [[10, 2000], [1000, 2000]], tags: { t: 2 } }]),
      ],
    ]);
    const archive = archiveOf(tiles);
    const sampler = new SacSampler({ archive, maxzoom: Z });

    const grades = await sampler.grades([local(4090, 2000), local(4095, 2000)]);

    expect(grades).toEqual([2, 2]);
    expect(archive.getZxy).toHaveBeenCalledWith(Z, east.x, east.y, undefined);
  });

  it('fetches each tile once however many samples fall in it', async () => {
    const tiles = new Map([
      [
        `${TILE.x}/${TILE.y}`,
        encodeTile([{ points: [[1000, 2000], [3000, 2000]], tags: { t: 1 } }]),
      ],
    ]);
    const archive = archiveOf(tiles);
    const sampler = new SacSampler({ archive, maxzoom: Z });

    await sampler.grades([local(1200, 2000), local(1600, 2000), local(2400, 2000)]);

    // One tile, plus whichever neighbours the tolerance box touched — never one per sample.
    const queried = new Set(archive.getZxy.mock.calls.map((call) => `${call[1]}/${call[2]}`));
    expect(queried.size).toBe(1);
  });

  it('reports no grades when the archive has no tile there', async () => {
    const sampler = new SacSampler({ archive: archiveOf(new Map()), maxzoom: Z });

    expect(await sampler.grades([local(1500, 2000), local(2000, 2000)])).toEqual([null, null]);
  });

  it('stops when the signal aborts', async () => {
    const sampler = samplerWithEastWestPath();
    const controller = new AbortController();
    controller.abort();

    await expect(sampler.grades([local(1500, 2000)], controller.signal)).rejects.toThrow(
      /cancelled/i,
    );
  });
});

describe('summariseSacGrades', () => {
  // A 400 m line of samples 100 m apart, near enough due north so the maths is readable.
  const coords: LngLat[] = [
    [-5, 56.8],
    [-5, 56.800899],
    [-5, 56.801798],
    [-5, 56.802697],
    [-5, 56.803596],
  ];

  it('totals metres per grade and reports the hardest', () => {
    const summary = summariseSacGrades(coords, [1, 1, 2, 2, 2]);

    expect(summary.hardest).toBe(2);
    // The 1→2 stretch counts as the harder of its two ends.
    expect(Math.round(summary.metresByGrade.get(1) ?? 0)).toBe(100);
    expect(Math.round(summary.metresByGrade.get(2) ?? 0)).toBe(300);
    expect(summary.coverage).toBeCloseTo(1, 5);
  });

  it('counts a stretch only when both its ends are graded', () => {
    const summary = summariseSacGrades(coords, [null, 3, 3, null, null]);

    // Only the middle stretch has a grade at both ends: 100 m of 400 m.
    expect(Math.round(summary.gradedM)).toBe(100);
    expect(summary.coverage).toBeCloseTo(0.25, 2);
    expect(summary.hardest).toBe(3);
  });

  it('reports nothing graded rather than a grade of zero', () => {
    const summary = summariseSacGrades(coords, [null, null, null, null, null]);

    expect(summary.hardest).toBeNull();
    expect(summary.gradedM).toBe(0);
    expect(summary.coverage).toBe(0);
    expect(Math.round(summary.totalM)).toBe(400);
  });

  it('handles an empty route', () => {
    const summary = summariseSacGrades([], []);
    expect(summary).toMatchObject({ hardest: null, gradedM: 0, totalM: 0, coverage: 0 });
  });
});
