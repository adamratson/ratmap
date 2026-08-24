import { describe, expect, it, vi } from 'vitest';
import type { PMTiles } from 'pmtiles';
import { TerrainSampler, type DecodedTile } from './terrain-sampler';
import { lngLatToGlobal } from './path-tiles';
import type { LngLat } from './geo';

const ZOOM = 11;
const TILE_SIZE = 8;
const WORLD = TILE_SIZE * 2 ** ZOOM;

/** Encode metres the way Mapterhorn's terrarium tiles do. */
function encode(metres: number): [number, number, number] {
  const raw = metres + 32768;
  const r = Math.floor(raw / 256);
  const g = Math.floor(raw - r * 256);
  const b = Math.round((raw - r * 256 - g) * 256);
  return [r, g, b];
}

/** A tile whose elevation is a known function of pixel position. */
function makeTile(heightAt: (x: number, y: number) => number): DecodedTile {
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const [r, g, b] = encode(heightAt(x, y));
      const offset = (y * TILE_SIZE + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width: TILE_SIZE, height: TILE_SIZE, data };
}

/** Minimal stand-in for a PMTiles archive. */
function fakeArchive(has: (x: number, y: number) => boolean) {
  const getZxy = vi.fn(async (_z: number, x: number, y: number) =>
    has(x, y) ? { data: new ArrayBuffer(4) } : undefined,
  );
  return { getZxy } as unknown as PMTiles & { getZxy: typeof getZxy };
}

/** The [lng, lat] at the centre of pixel (px, py) of tile (tx, ty). */
function pixelCentre(tx: number, ty: number, px: number, py: number): LngLat {
  const gx = tx * TILE_SIZE + px + 0.5;
  const gy = ty * TILE_SIZE + py + 0.5;
  const lng = (gx / WORLD) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / WORLD))) * 180) / Math.PI;
  return [lng, lat];
}

describe('TerrainSampler', () => {
  it('decodes terrarium elevation at a known pixel', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile(() => 1345));
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode });

    const [ele] = await sampler.sample([pixelCentre(995, 629, 4, 4)]);
    expect(ele).toBeCloseTo(1345, 1);
  });

  it('handles a height below sea level', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile(() => -412));
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode });

    const [ele] = await sampler.sample([pixelCentre(995, 629, 2, 2)]);
    expect(ele).toBeCloseTo(-412, 1);
  });

  it('interpolates between pixels rather than stepping', async () => {
    const archive = fakeArchive(() => true);
    // A west-to-east ramp: 100 m per pixel column.
    const decode = vi.fn(async () => makeTile((x) => x * 100));
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode });

    const left = pixelCentre(995, 629, 2, 4);
    const right = pixelCentre(995, 629, 3, 4);
    const middle: LngLat = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];

    const [a, b, mid] = await sampler.sample([left, right, middle]);
    expect(a).toBeCloseTo(200, 0);
    expect(b).toBeCloseTo(300, 0);
    // Nearest-neighbour sampling would return 200 or 300 here, never 250.
    expect(mid).toBeCloseTo(250, 0);
  });

  it('returns null where the archive has no tile', async () => {
    const archive = fakeArchive(() => false);
    const decode = vi.fn(async () => makeTile(() => 100));
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode });

    // Null, never 0 — a gap in coverage must not read as sea level.
    expect(await sampler.sample([pixelCentre(995, 629, 1, 1)])).toEqual([null]);
    expect(decode).not.toHaveBeenCalled();
  });

  it('decodes each tile once however many samples fall in it', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => makeTile(() => 500));
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode });

    const points = Array.from({ length: 40 }, (_, i) => pixelCentre(995, 629, i % 8, 3));
    const results = await sampler.sample(points);

    expect(results.every((ele) => ele !== null)).toBe(true);
    // A profile is thousands of points over a handful of tiles; decoding per point would
    // be thousands of WebP decodes.
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('remembers that a tile is missing instead of re-fetching it', async () => {
    const archive = fakeArchive(() => false);
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode: async () => makeTile(() => 0) });

    await sampler.sample([pixelCentre(995, 629, 1, 1)]);
    await sampler.sample([pixelCentre(995, 629, 2, 2)]);

    expect(archive.getZxy).toHaveBeenCalledTimes(1);
  });

  it('treats an undecodable tile as missing rather than failing the route', async () => {
    const archive = fakeArchive(() => true);
    const decode = vi.fn(async () => {
      throw new Error('corrupt WebP');
    });
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode });

    expect(await sampler.sample([pixelCentre(995, 629, 1, 1)])).toEqual([null]);
  });

  it('stops when cancelled', async () => {
    const archive = fakeArchive(() => true);
    const sampler = new TerrainSampler({
      archive,
      maxzoom: ZOOM,
      decode: async () => makeTile(() => 100),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      sampler.sample([pixelCentre(995, 629, 1, 1)], controller.signal),
    ).rejects.toThrow(/cancelled/i);
  });

  it('returns an empty result for no points', async () => {
    const archive = fakeArchive(() => true);
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode: async () => makeTile(() => 0) });
    expect(await sampler.sample([])).toEqual([]);
  });

  it('places a coordinate in the tile the tile maths says it is in', async () => {
    // Guards the sampler's own tile-key maths against path-tiles', which the router uses.
    const seen: Array<[number, number]> = [];
    const archive = {
      getZxy: async (_z: number, x: number, y: number) => {
        seen.push([x, y]);
        return { data: new ArrayBuffer(4) };
      },
    } as unknown as PMTiles;
    const sampler = new TerrainSampler({ archive, maxzoom: ZOOM, decode: async () => makeTile(() => 0) });

    const point = pixelCentre(995, 629, 4, 4);
    await sampler.sample([point]);

    const [gx, gy] = lngLatToGlobal(point[0], point[1], WORLD);
    expect(seen[0]).toEqual([Math.floor(gx / TILE_SIZE), Math.floor(gy / TILE_SIZE)]);
  });
});
