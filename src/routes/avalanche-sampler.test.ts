import { describe, expect, it, vi } from 'vitest';
import type { PMTiles } from 'pmtiles';
import {
  AVALANCHE_SAMPLE_SPACING_M,
  AvalancheSampler,
  avalancheClassBreakdown,
  avalancheSampleCoords,
  summariseAvalancheTerrain,
  type AvalancheCell,
} from './avalanche-sampler';
import type { DecodedTile } from './terrain-sampler';
import { distanceMetres, type LngLat } from './geo';

const ZOOM = 11;
const TILE_SIZE = 8;
const WORLD = TILE_SIZE * 2 ** ZOOM;

/** A tile whose R/G channels are a known function of pixel position. */
function makeTile(cellAt: (x: number, y: number) => [number, number]): DecodedTile {
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const [slope, aspect] = cellAt(x, y);
      const offset = (y * TILE_SIZE + x) * 4;
      data[offset] = slope;
      data[offset + 1] = aspect;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
  return { width: TILE_SIZE, height: TILE_SIZE, data };
}

function fakeArchive(has: (x: number, y: number) => boolean) {
  const getZxy = vi.fn(async (_z: number, x: number, y: number) =>
    has(x, y) ? { data: new ArrayBuffer(4) } : undefined,
  );
  return { getZxy } as unknown as PMTiles & { getZxy: typeof getZxy };
}

/** The [lng, lat] at a fractional pixel position of tile (tx, ty). */
function pixelAt(tx: number, ty: number, px: number, py: number): LngLat {
  const gx = tx * TILE_SIZE + px;
  const gy = ty * TILE_SIZE + py;
  const lng = (gx / WORLD) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / WORLD))) * 180) / Math.PI;
  return [lng, lat];
}

describe('AvalancheSampler', () => {
  it('reads slope from R and aspect octant from G', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile(() => [38, 3]));
    const sampler = new AvalancheSampler({ archive, maxzoom: ZOOM, decode });

    const [cell] = await sampler.cells([pixelAt(995, 629, 4.5, 4.5)]);
    expect(cell).toEqual({ slope: 38, aspect: 3 });
  });

  it('takes the nearest cell rather than blending across a class boundary', async () => {
    // Left half 32°, right half 41°. Bilinear would report ~36° at the seam — a value in
    // neither cell, and in a different class from both.
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile((x) => (x < 4 ? [32, 1] : [41, 5])));
    const sampler = new AvalancheSampler({ archive, maxzoom: ZOOM, decode });

    const [left, right] = await sampler.cells([
      pixelAt(995, 629, 3.95, 2.5),
      pixelAt(995, 629, 4.05, 2.5),
    ]);
    expect(left?.slope).toBe(32);
    expect(right?.slope).toBe(41);
  });

  it('keeps 0 as "below the floor", with no aspect', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile(() => [0, 0]));
    const sampler = new AvalancheSampler({ archive, maxzoom: ZOOM, decode });

    const [cell] = await sampler.cells([pixelAt(995, 629, 1.5, 1.5)]);
    expect(cell).toEqual({ slope: 0, aspect: null });
  });

  it('returns null where the archive has no tile — not a slope of 0', async () => {
    const archive = fakeArchive(() => false);
    const decode = vi.fn(async () => makeTile(() => [0, 0]));
    const sampler = new AvalancheSampler({ archive, maxzoom: ZOOM, decode });

    const [cell] = await sampler.cells([pixelAt(995, 629, 1.5, 1.5)]);
    expect(cell).toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it('refuses a value no slope can have', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile(() => [200, 2]));
    const sampler = new AvalancheSampler({ archive, maxzoom: ZOOM, decode });

    const [cell] = await sampler.cells([pixelAt(995, 629, 1.5, 1.5)]);
    expect(cell).toBeNull();
  });
});

describe('avalancheSampleCoords', () => {
  it('samples at most the spacing apart', () => {
    const route: LngLat[] = [
      [-5.0, 56.8],
      [-5.0, 56.81],
    ];
    const samples = avalancheSampleCoords(route);
    for (let i = 1; i < samples.length; i++) {
      expect(distanceMetres(samples[i - 1], samples[i])).toBeLessThanOrEqual(
        AVALANCHE_SAMPLE_SPACING_M + 0.01,
      );
    }
    expect(samples[0]).toEqual(route[0]);
    expect(samples.at(-1)).toEqual(route[1]);
  });

  it('caps a very long route instead of sampling it without limit', () => {
    const route: LngLat[] = [
      [-5.0, 56.0],
      [-5.0, 57.0],
    ];
    expect(avalancheSampleCoords(route).length).toBeLessThanOrEqual(8000);
  });
});

describe('summariseAvalancheTerrain', () => {
  const along = (n: number): LngLat[] =>
    Array.from({ length: n }, (_, i) => [-5.0, 56.8 + i * 0.0001] as LngLat);
  const cell = (slope: number): AvalancheCell => ({ slope, aspect: slope ? 1 : null });

  it('totals metres per class and the steepest slope crossed', () => {
    const coords = along(5);
    const summary = summariseAvalancheTerrain(coords, [cell(0), cell(0), cell(33), cell(33), cell(0)]);

    const step = distanceMetres(coords[0], coords[1]);
    expect(summary.steepest).toBe(33);
    // Stretches 1-2, 2-3 and 3-4 each touch the 33° cells; steeper end wins.
    expect(summary.metresByClass.get(30)).toBeCloseTo(step * 3, 3);
    expect(summary.coverage).toBeCloseTo(1, 6);
  });

  it('reports nothing steep — not "flat" — when the route stays under the floor', () => {
    const coords = along(3);
    const summary = summariseAvalancheTerrain(coords, [cell(0), cell(0), cell(0)]);
    expect(summary.steepest).toBeNull();
    expect(summary.metresByClass.size).toBe(0);
    expect(summary.coverage).toBeCloseTo(1, 6);
  });

  it('counts a stretch only where both ends have data', () => {
    const coords = along(4);
    const summary = summariseAvalancheTerrain(coords, [cell(40), null, cell(40), cell(40)]);
    const step = distanceMetres(coords[0], coords[1]);
    expect(summary.coveredM).toBeCloseTo(step, 3);
    expect(summary.coverage).toBeCloseTo(1 / 3, 3);
    expect(summary.metresByClass.get(40)).toBeCloseTo(step, 3);
  });

  it('lists the classes in display order, skipping empty ones', () => {
    const coords = along(4);
    const summary = summariseAvalancheTerrain(coords, [cell(46), cell(46), cell(27), cell(27)]);
    expect(avalancheClassBreakdown(summary).map((entry) => entry.slopeClass.from)).toEqual([25, 45]);
  });
});
