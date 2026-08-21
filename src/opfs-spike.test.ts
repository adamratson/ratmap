import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';

// PMTiles/FileSource are mocked because getHeader() parses a real PMTiles binary
// header — our test files are arbitrary bytes, not valid archives. Protocol is kept
// real (via importOriginal): it's cheap, side-effect-free, and using the real class
// for deps.protocol lets vi.spyOn(protocol, 'add') verify the actual registration API.
const { PMTilesMock, getHeaderMock, getMetadataMock, TileType } = vi.hoisted(() => {
  // Literal values, not the real enum import, since vi.hoisted factories run before
  // this file's own imports are evaluated — mirrors pmtiles' TileType.Mvt = 1, .Webp = 4.
  const TileType = { Mvt: 1, Webp: 4 } as const;
  const getHeaderMock = vi.fn().mockResolvedValue({
    minZoom: 0,
    maxZoom: 14,
    tileType: TileType.Mvt,
    minLon: 11.2,
    minLat: 43.7,
    maxLon: 11.3,
    maxLat: 43.8,
  });
  const getMetadataMock = vi.fn().mockResolvedValue({ vector_layers: [{ id: 'testlayer' }] });
  class PMTilesMock {
    source: unknown;
    constructor(source: unknown) {
      this.source = source;
    }
    getHeader = getHeaderMock;
    getMetadata = getMetadataMock;
  }
  return { PMTilesMock, getHeaderMock, getMetadataMock, TileType };
});

vi.mock('pmtiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pmtiles')>();
  return {
    ...actual,
    PMTiles: PMTilesMock,
    FileSource: class {
      file: File;
      constructor(file: File) {
        this.file = file;
      }
      getKey(): string {
        return this.file.name;
      }
    },
  };
});

const { runSpike, writeToOpfs } = await import('./opfs-spike');
const { Protocol } = await import('pmtiles');

function makeFakeOpfs() {
  const files = new Map<string, Uint8Array<ArrayBuffer>[]>();
  const writes: Record<string, number[]> = {};

  const root = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, []);
      }
      return {
        async createWritable() {
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          return {
            async write(data: Blob) {
              const buf = new Uint8Array(await data.arrayBuffer());
              chunks.push(buf);
              (writes[name] ??= []).push(buf.byteLength);
            },
            async close() {
              files.set(name, chunks.slice());
            },
          };
        },
        async getFile() {
          return new File(files.get(name) ?? [], name);
        },
      };
    },
  };

  return { root, writes };
}

function stubNavigatorStorage(value: unknown): void {
  Object.defineProperty(navigator, 'storage', { value, configurable: true });
}

afterEach(() => {
  // @ts-expect-error test cleanup
  delete navigator.storage;
  getHeaderMock.mockClear();
  getMetadataMock.mockClear();
});

describe('writeToOpfs (§2 spikes 2 & 4)', () => {
  it('throws when OPFS is unsupported instead of failing silently', async () => {
    stubNavigatorStorage(undefined);
    const file = new File(['x'], 'a.pmtiles');

    await expect(writeToOpfs(file)).rejects.toThrow(/OPFS/);
  });

  it('writes the file in 8 MB chunks and keys the result by filename (C3)', async () => {
    const { root, writes } = makeFakeOpfs();
    stubNavigatorStorage({ getDirectory: async () => root });

    const size = 10 * 1024 * 1024; // -> chunks of 8 MB, 2 MB
    const file = new File([new Uint8Array(size)], 'region-a-basemap.pmtiles');

    const result = await writeToOpfs(file);

    expect(result.key).toBe('region-a-basemap.pmtiles');
    expect(writes['region-a-basemap.pmtiles']).toEqual([8 * 1024 * 1024, 2 * 1024 * 1024]);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.bytesPerSecond).toBeGreaterThanOrEqual(0);
  });
});

describe('runSpike (OPFS -> FileSource -> Protocol.add(), §2 spike 2)', () => {
  function setup() {
    const { root } = makeFakeOpfs();
    stubNavigatorStorage({ getDirectory: async () => root });
    const protocol = new Protocol();
    const addSource = vi.fn();
    const getSource = vi.fn().mockReturnValue(undefined);
    const addLayer = vi.fn();
    const fitBounds = vi.fn();
    const map = { addSource, getSource, addLayer, fitBounds } as unknown as MLMap;
    const result = document.createElement('div');
    return { protocol, map, addSource, getSource, addLayer, fitBounds, result };
  }

  it('registers the archive, adds a vector source keyed by filename (C3), and flies to its bounds', async () => {
    const { protocol, map, addSource, addLayer, fitBounds, result } = setup();
    const addSpy = vi.spyOn(protocol, 'add');
    const file = new File([new Uint8Array(1024)], 'region-a-basemap.pmtiles');

    await runSpike(file, { protocol, map }, result);

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSource).toHaveBeenCalledWith('opfs-region-a-basemap.pmtiles', {
      type: 'vector',
      url: 'pmtiles://region-a-basemap.pmtiles',
    });
    // One vector_layers entry ("testlayer") -> line + circle generic layers (no fill).
    expect(addLayer).toHaveBeenCalledTimes(2);
    expect(fitBounds).toHaveBeenCalledWith(
      [
        [11.2, 43.7],
        [11.3, 43.8],
      ],
      expect.objectContaining({ padding: 40 }),
    );
    expect(result.textContent).toContain('OK — registered as pmtiles://region-a-basemap.pmtiles');
    expect(result.textContent).toContain('zoom 0-14');
  });

  it('registers a raster archive as raster-dem and renders real hillshade, not a flat preview', async () => {
    getHeaderMock.mockResolvedValueOnce({
      minZoom: 8,
      maxZoom: 15,
      tileType: TileType.Webp,
      minLon: -118.3,
      minLat: 36.5,
      maxLon: -118.2,
      maxLat: 36.6,
    });
    const { protocol, map, addSource, addLayer, result } = setup();
    const file = new File([new Uint8Array(1024)], 'usgs-mt-whitney-8-15-webp-512.pmtiles');

    await runSpike(file, { protocol, map }, result);

    expect(addSource).toHaveBeenCalledWith('opfs-usgs-mt-whitney-8-15-webp-512.pmtiles', {
      type: 'raster-dem',
      url: 'pmtiles://usgs-mt-whitney-8-15-webp-512.pmtiles',
      encoding: 'terrarium',
    });
    expect(addLayer).toHaveBeenCalledTimes(1);
    expect(addLayer.mock.calls[0]?.[0]).toMatchObject({ type: 'hillshade' });
  });

  it('does not re-add layers for a source that is already registered, but still flies there', async () => {
    const { protocol, map, addSource, addLayer, fitBounds, getSource, result } = setup();
    getSource.mockReturnValue({});
    const file = new File([new Uint8Array(1024)], 'region-a-basemap.pmtiles');

    await runSpike(file, { protocol, map }, result);

    expect(addSource).not.toHaveBeenCalled();
    expect(addLayer).not.toHaveBeenCalled();
    expect(fitBounds).toHaveBeenCalledTimes(1);
  });

  it('shows a failure message instead of throwing when the write fails', async () => {
    // @ts-expect-error deliberately leave OPFS unsupported for this case
    delete navigator.storage;
    const protocol = new Protocol();
    const map = { addSource: vi.fn(), getSource: vi.fn() } as unknown as MLMap;
    const result = document.createElement('div');
    const file = new File([new Uint8Array(1024)], 'region-a-basemap.pmtiles');

    await expect(runSpike(file, { protocol, map }, result)).resolves.toBeUndefined();
    expect(result.textContent).toMatch(/^Failed: /);
  });
});
