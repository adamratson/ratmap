import { describe, expect, it, vi } from 'vitest';
import { fromGeojsonVt } from 'vt-pbf';
import type { PMTiles } from 'pmtiles';
import { globalToLngLat } from './path-tiles';
import type { LngLat } from './geo';
import { OfflineRouter, ROUTING_ZOOM } from './router';
import type { Region } from '../regions/manifest';
import type { TileSourceRegistry } from '../map/tile-source-registry';

const EXTENT = 4096;
const WORLD = EXTENT * 2 ** ROUTING_ZOOM;
// A z15 tile over Ben Nevis, so distances are real metres at a real latitude.
const TILE = { x: 15928, y: 10072 };
const TILE_KEY = `${TILE.x}/${TILE.y}`;
const FILENAME = 'test-basemap.pmtiles';

/** Tile-local coordinates → [lng, lat]. */
function local(x: number, y: number): LngLat {
  return globalToLngLat(TILE.x * EXTENT + x, TILE.y * EXTENT + y, WORLD);
}

/** One east-west footpath across the middle of the tile. */
const PATH_TILE = fromGeojsonVt(
  {
    roads: {
      features: [
        {
          type: 2,
          geometry: [[[200, 2048], [3900, 2048]]],
          tags: { kind: 'path', kind_detail: 'path', name: 'Test path' },
        },
      ],
    },
  },
  { version: 2, extent: EXTENT },
);

const FROM = local(400, 2060);
const TO = local(3700, 2060);

const REGION: Region = {
  id: 'test',
  name: 'Test',
  bbox: [FROM[0] - 0.1, FROM[1] - 0.1, TO[0] + 0.1, TO[1] + 0.1],
  totalBytes: 1,
  artifacts: [{ kind: 'basemap', filename: FILENAME, path: FILENAME, bytes: 1 }],
};

type GetZxy = (z: number, x: number, y: number, signal?: AbortSignal) => Promise<{ data: ArrayBuffer } | undefined>;

function routerWith(getZxy: GetZxy): OfflineRouter {
  const archive = { getZxy: vi.fn(getZxy) } as unknown as PMTiles;
  const registry = {
    get: (key: string) => (key === FILENAME ? archive : undefined),
  } as unknown as TileSourceRegistry;
  return new OfflineRouter({ registry, downloadedRegions: () => [REGION] });
}

const serveTile: GetZxy = async (_z, x, y) =>
  `${x}/${y}` === TILE_KEY ? { data: PATH_TILE.buffer as ArrayBuffer } : undefined;

describe('OfflineRouter', () => {
  it('routes along a path in the tile', async () => {
    const leg = await routerWith(serveTile).computeLeg(FROM, TO);
    expect(leg.kind).toBe('snapped');
    expect(leg.wayNames).toEqual(['Test path']);
  });

  it('draws a freehand leg straight, without reading the network', async () => {
    const getZxy = vi.fn(serveTile);
    const archive = { getZxy } as unknown as PMTiles;
    const registry = { get: () => archive } as unknown as TileSourceRegistry;
    const router = new OfflineRouter({ registry, downloadedRegions: () => [REGION] });

    const leg = await router.computeLeg(FROM, TO, { snap: false });

    expect(leg).toMatchObject({ kind: 'straight', freehand: true, coords: [FROM, TO] });
    expect(leg.reason).toBeUndefined();
    expect(getZxy).not.toHaveBeenCalled();
  });

  it('does not cache a tile whose read was cancelled', async () => {
    // pmtiles rejects with AbortError when the signal fires between its reads. That tile
    // must not be remembered as empty, or every later leg routes around a hole.
    const controller = new AbortController();
    let cancelled = false;
    const router = routerWith(async (z, x, y, signal) => {
      if (!cancelled && signal && `${x}/${y}` === TILE_KEY) {
        cancelled = true;
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
      return serveTile(z, x, y, signal);
    });

    await expect(router.computeLeg(FROM, TO, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const leg = await router.computeLeg(FROM, TO);
    expect(leg.kind).toBe('snapped');
  });

  it('does not cache a tile whose read failed', async () => {
    let failed = false;
    const router = routerWith(async (z, x, y, signal) => {
      if (!failed && `${x}/${y}` === TILE_KEY) {
        failed = true;
        throw new Error('NotReadableError');
      }
      return serveTile(z, x, y, signal);
    });

    // An unreadable tile routes as empty for this leg — honestly straight...
    expect((await router.computeLeg(FROM, TO)).kind).toBe('straight');
    // ...and is read again next time rather than being remembered as empty.
    expect((await router.computeLeg(FROM, TO)).kind).toBe('snapped');
  });

  it('caches an absent tile rather than asking again', async () => {
    const getZxy = vi.fn(serveTile);
    const archive = { getZxy } as unknown as PMTiles;
    const registry = { get: () => archive } as unknown as TileSourceRegistry;
    const router = new OfflineRouter({ registry, downloadedRegions: () => [REGION] });

    await router.computeLeg(FROM, TO);
    const firstPass = getZxy.mock.calls.length;
    await router.computeLeg(FROM, TO);

    expect(getZxy.mock.calls.length).toBe(firstPass);
  });
});

describe('OfflineRouter and ways tagged private', () => {
  // The College Valley road: a track the basemap tags `access=private`, which is a public
  // bridleway on foot. The only way between the two ends.
  const PRIVATE_TILE = fromGeojsonVt(
    {
      roads: {
        features: [
          {
            type: 2,
            geometry: [[[200, 2048], [3900, 2048]]],
            tags: { kind: 'path', kind_detail: 'track', access: 'private' },
          },
        ],
      },
    },
    { version: 2, extent: EXTENT },
  );
  const ACCESS_FILENAME = 'test-access-1.pmtiles';

  function accessTile(geometry: number[][]): Uint8Array {
    return fromGeojsonVt(
      { access: { features: [{ type: 2, geometry: [geometry], tags: { foot: 'designated' } }] } },
      { version: 2, extent: EXTENT },
    );
  }

  function routerFor(access: Uint8Array | null): OfflineRouter {
    const basemap = {
      getZxy: async (_z: number, x: number, y: number) =>
        `${x}/${y}` === TILE_KEY ? { data: PRIVATE_TILE.buffer as ArrayBuffer } : undefined,
    } as unknown as PMTiles;
    const accessArchive = {
      getZxy: async (_z: number, x: number, y: number) =>
        access && `${x}/${y}` === TILE_KEY ? { data: access.buffer as ArrayBuffer } : undefined,
    } as unknown as PMTiles;
    const region: Region = {
      ...REGION,
      artifacts: access
        ? [
            ...REGION.artifacts,
            { kind: 'access', filename: ACCESS_FILENAME, path: ACCESS_FILENAME, bytes: 1, maxzoom: 15 },
          ]
        : REGION.artifacts,
    };
    const registry = {
      get: (key: string) => (key === FILENAME ? basemap : key === ACCESS_FILENAME ? accessArchive : undefined),
    } as unknown as TileSourceRegistry;
    return new OfflineRouter({ registry, downloadedRegions: () => [region] });
  }

  it('does not route over a private way on a region without the access artifact', async () => {
    expect((await routerFor(null).computeLeg(FROM, TO)).kind).toBe('straight');
  });

  it('routes over a private way the access artifact opens on foot', async () => {
    const leg = await routerFor(accessTile([[200, 2048], [3900, 2048]])).computeLeg(FROM, TO);
    expect(leg.kind).toBe('snapped');
  });

  it('still refuses a private way when the open one beside it is a different way', async () => {
    // 100 units is ~16 m here: a public path beside the private track, not the track.
    const leg = await routerFor(accessTile([[200, 2148], [3900, 2148]])).computeLeg(FROM, TO);
    expect(leg.kind).toBe('straight');
  });
});
