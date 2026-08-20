import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';

// PMTiles/FileSource are mocked because getHeader() parses a real PMTiles binary
// header — our test files are arbitrary bytes, not valid archives. Protocol is kept
// real (via importOriginal): it's cheap, side-effect-free, and using the real class
// for deps.protocol lets vi.spyOn(protocol, 'add') verify the actual registration API.
const { PMTilesMock, getHeaderMock } = vi.hoisted(() => {
  const getHeaderMock = vi.fn().mockResolvedValue({ minZoom: 0, maxZoom: 14 });
  class PMTilesMock {
    source: unknown;
    constructor(source: unknown) {
      this.source = source;
    }
    getHeader = getHeaderMock;
  }
  return { PMTilesMock, getHeaderMock };
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
    const map = { addSource, getSource } as unknown as MLMap;
    const result = document.createElement('div');
    return { protocol, map, addSource, getSource, result };
  }

  it('registers the archive and adds a vector source keyed by filename (C3)', async () => {
    const { protocol, map, addSource, result } = setup();
    const addSpy = vi.spyOn(protocol, 'add');
    const file = new File([new Uint8Array(1024)], 'region-a-basemap.pmtiles');

    await runSpike(file, { protocol, map }, result);

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSource).toHaveBeenCalledWith('opfs-region-a-basemap.pmtiles', {
      type: 'vector',
      url: 'pmtiles://region-a-basemap.pmtiles',
    });
    expect(result.textContent).toContain('OK — registered as pmtiles://region-a-basemap.pmtiles');
    expect(result.textContent).toContain('zoom 0-14');
  });

  it('does not re-add a source that is already registered under that key', async () => {
    const { protocol, map, addSource, getSource, result } = setup();
    getSource.mockReturnValue({});
    const file = new File([new Uint8Array(1024)], 'region-a-basemap.pmtiles');

    await runSpike(file, { protocol, map }, result);

    expect(addSource).not.toHaveBeenCalled();
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
