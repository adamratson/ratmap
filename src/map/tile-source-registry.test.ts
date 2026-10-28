import { beforeEach, describe, expect, it, vi } from 'vitest';

const addProtocolSpy = vi.hoisted(() => vi.fn());
vi.mock('maplibre-gl', () => ({
  default: { addProtocol: addProtocolSpy },
}));

// FetchSource/FileSource are stubbed: constructing the real ones is harmless but PMTiles
// would do IO. Protocol is kept real so `add()` is the genuine registration API.
vi.mock('pmtiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pmtiles')>();
  return {
    ...actual,
    // Plain field assignment rather than constructor parameter properties: tsconfig sets
    // erasableSyntaxOnly, which bans the `constructor(public x)` shorthand.
    PMTiles: class {
      source: unknown;
      constructor(source: unknown) {
        this.source = source;
      }
    },
    FetchSource: class {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      getKey() {
        return this.url;
      }
    },
    FileSource: class {
      file: File;
      constructor(file: File) {
        this.file = file;
      }
      getKey() {
        return this.file.name;
      }
    },
  };
});

const { TileSourceRegistry } = await import('./tile-source-registry');
const { Protocol } = await import('pmtiles');

beforeEach(() => {
  addProtocolSpy.mockClear();
});

describe('TileSourceRegistry', () => {
  it('registers the pmtiles protocol with MapLibre exactly once per install (C17)', () => {
    TileSourceRegistry.install();

    expect(addProtocolSpy).toHaveBeenCalledTimes(1);
    expect(addProtocolSpy.mock.calls[0]?.[0]).toBe('pmtiles');
  });

  it('adds a remote archive to the protocol and keys it by full URL', () => {
    const protocol = new Protocol();
    const addSpy = vi.spyOn(protocol, 'add');
    const registry = new TileSourceRegistry(protocol);

    const url = 'https://tiles.example.com/world.pmtiles';
    registry.addRemote(url);

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(registry.has(url)).toBe(true);
    // Style sources reference remote archives by their full URL inside the scheme.
    expect(registry.sourceUrl(url)).toBe(`pmtiles://${url}`);
  });

  it('is idempotent: re-adding the same URL reuses the instance rather than double-registering', () => {
    const protocol = new Protocol();
    const addSpy = vi.spyOn(protocol, 'add');
    const registry = new TileSourceRegistry(protocol);
    const url = 'https://tiles.example.com/world.pmtiles';

    const first = registry.addRemote(url);
    const second = registry.addRemote(url);

    expect(second).toBe(first);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(registry.keys()).toEqual([url]);
  });

  it('keys a local OPFS archive by filename — the C3 collision surface', () => {
    const registry = new TileSourceRegistry(new Protocol());
    const file = new File([new Uint8Array(8)], 'cairngorms-basemap.pmtiles');

    registry.addLocal(file);

    // FileSource.getKey() returns file.name, so this key is what Protocol.add registers
    // under. Two regions both shipping "basemap.pmtiles" would silently collide here —
    // hence unique filenames per artifact.
    expect(registry.has('cairngorms-basemap.pmtiles')).toBe(true);
    expect(registry.sourceUrl('cairngorms-basemap.pmtiles')).toBe(
      'pmtiles://cairngorms-basemap.pmtiles',
    );
  });

  it('keeps remote and local archives in one key space without clobbering each other', () => {
    const registry = new TileSourceRegistry(new Protocol());
    const remote = 'https://tiles.example.com/world.pmtiles';

    registry.addRemote(remote);
    registry.addLocal(new File([new Uint8Array(8)], 'region-a-basemap.pmtiles'));

    expect(registry.keys().sort()).toEqual([remote, 'region-a-basemap.pmtiles'].sort());
    expect(registry.get(remote)).toBeDefined();
    expect(registry.get('region-a-basemap.pmtiles')).toBeDefined();
  });

  it('returns undefined for archives that were never registered', () => {
    const registry = new TileSourceRegistry(new Protocol());
    expect(registry.get('nope.pmtiles')).toBeUndefined();
    expect(registry.has('nope.pmtiles')).toBe(false);
  });

  it('registers the new file after a local archive is removed and downloaded again', () => {
    // An OPFS File is a snapshot that stops reading once its file is deleted. Returning the
    // cached archive for a re-downloaded region handed back that dead snapshot.
    const protocol = new Protocol();
    const registry = new TileSourceRegistry(protocol);
    const first = registry.addLocal(new File([new Uint8Array(8)], 'region-a-basemap.pmtiles'));

    registry.removeLocal('region-a-basemap.pmtiles');
    expect(registry.has('region-a-basemap.pmtiles')).toBe(false);
    expect(protocol.get('region-a-basemap.pmtiles')).toBeUndefined();

    const second = registry.addLocal(new File([new Uint8Array(8)], 'region-a-basemap.pmtiles'));
    expect(second).not.toBe(first);
    expect(protocol.get('region-a-basemap.pmtiles')).toBe(second);
  });
});

describe('regional copies of a remote archive (summits offline)', () => {
  const REMOTE = 'https://bucket/peaks-global.pmtiles';
  const COPY = 'andorra-peaks-1.pmtiles';
  // Andorra's bbox, as the catalogue gives it.
  const ANDORRA = [1.4124, 42.4276, 1.7875, 42.6572] as const;
  // z6 tiles: the one Andorra is in, and one over Scotland.
  const INSIDE = [6, 32, 23] as const;
  const OUTSIDE = [6, 31, 19] as const;

  type Fake = { getHeader: ReturnType<typeof vi.fn>; getZxy: ReturnType<typeof vi.fn> };

  function setUp() {
    const protocol = new Protocol();
    const registry = new TileSourceRegistry(protocol);
    const remote = Object.assign(registry.addRemote(REMOTE, { regionalCopies: true }), {
      getHeader: vi.fn(async () => ({ maxZoom: 6, minLon: -180, minLat: -85, maxLon: 180, maxLat: 85, from: 'remote' })),
      getZxy: vi.fn(async () => ({ data: new ArrayBuffer(1), from: 'remote' })),
    }) as unknown as Fake;
    const copy = Object.assign(registry.addLocal(new File([new Uint8Array(8)], COPY)), {
      getHeader: vi.fn(async () => ({ maxZoom: 6, minLon: 1.4, minLat: 42.4, maxLon: 1.8, maxLat: 42.7, from: 'copy' })),
      getZxy: vi.fn(async () => ({ data: new ArrayBuffer(1), from: 'copy' })),
    }) as unknown as Fake;
    const served = protocol.get(REMOTE) as unknown as {
      getHeader(): Promise<{ from: string; minLon: number }>;
      getZxy(z: number, x: number, y: number): Promise<{ from: string } | undefined>;
    };
    return { registry, remote, copy, served };
  }

  it('serves tiles inside a downloaded region from its copy, and the rest from the network', async () => {
    const { registry, served } = setUp();
    registry.addRegionalCopy(REMOTE, COPY, ANDORRA);

    expect((await served.getZxy(...INSIDE))?.from).toBe('copy');
    expect((await served.getZxy(...OUTSIDE))?.from).toBe('remote');
  });

  it('asks the network when the copy has no such tile, rather than drawing nothing', async () => {
    const { registry, copy, served } = setUp();
    copy.getZxy.mockResolvedValue(undefined);
    registry.addRegionalCopy(REMOTE, COPY, ANDORRA);

    expect((await served.getZxy(...INSIDE))?.from).toBe('remote');
  });

  it('answers the header from a copy when offline, keeping the remote’s worldwide bounds', async () => {
    const { registry, remote, served } = setUp();
    remote.getHeader.mockRejectedValue(new TypeError('Failed to fetch'));
    registry.addRegionalCopy(REMOTE, COPY, ANDORRA);

    const header = await served.getHeader();
    expect(header.from).toBe('copy');
    expect(header.minLon).toBe(-180);
  });

  it('says the source needs reloading when it asked offline before any copy existed', async () => {
    // An offline start: the style asks for the header before regions are restored.
    const { registry, remote, served } = setUp();
    remote.getHeader.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(served.getHeader()).rejects.toThrow();

    expect(registry.addRegionalCopy(REMOTE, COPY, ANDORRA)).toBe(true);
    // Once is enough.
    expect(registry.addRegionalCopy(REMOTE, COPY, ANDORRA)).toBe(false);
  });

  it('does not ask for a reload when nothing failed', () => {
    const { registry } = setUp();
    expect(registry.addRegionalCopy(REMOTE, COPY, ANDORRA)).toBe(false);
  });

  it('stops using a copy once its region is deleted', async () => {
    const { registry, served } = setUp();
    registry.addRegionalCopy(REMOTE, COPY, ANDORRA);

    registry.removeLocal(COPY);

    expect((await served.getZxy(...INSIDE))?.from).toBe('remote');
  });
});

describe('archives shared by every downloaded region of a kind', () => {
  const KEY = 'regions-z0-15-basemap';
  // Two overlapping regions, the shape of England North West and Scotland, which reaches
  // south over it. Their z10 tiles: one inside both, one in Scotland only, one that
  // Scotland's southern edge crosses, and one outside both.
  const NORTH_WEST = [-3.9075, 52.9455, -1.908, 55.1886] as const;
  const SCOTLAND = [-14.8615, 54.54, 0.2161, 61.1356] as const;
  const IN_BOTH = [10, 505, 325] as const; // over Great Dun Fell
  const SCOTLAND_ONLY = [10, 498, 313] as const;
  const ACROSS_SCOTLAND_EDGE = [10, 503, 326] as const; // 54.37-54.57 N, all in North West
  const OUTSIDE = [10, 519, 355] as const;

  type FakeCopy = { getHeader: ReturnType<typeof vi.fn>; getZxy: ReturnType<typeof vi.fn> };

  function setUp() {
    const protocol = new Protocol();
    const registry = new TileSourceRegistry(protocol);
    const local = (name: string, header: Record<string, number>): FakeCopy =>
      Object.assign(registry.addLocal(new File([new Uint8Array(8)], name)), {
        getHeader: vi.fn(async () => ({ tileType: 1, minZoom: 0, maxZoom: 15, ...header })),
        getZxy: vi.fn(async () => ({ data: new ArrayBuffer(1), from: name })),
      }) as unknown as FakeCopy;
    const northWest = local('nw-basemap.pmtiles', { minLon: -3.9, minLat: 52.9, maxLon: -1.9, maxLat: 55.2 });
    const scotland = local('sc-basemap.pmtiles', { minLon: -14.9, minLat: 54.5, maxLon: 0.2, maxLat: 61.1 });
    const served = () =>
      protocol.get(KEY) as unknown as {
        getHeader(): Promise<Record<string, number>>;
        getZxy(z: number, x: number, y: number): Promise<{ from: string } | undefined>;
      };
    return { registry, protocol, northWest, scotland, served };
  }

  it('is served under its key, answering for every region in it', async () => {
    const { registry, served } = setUp();
    registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 0);
    registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 0);

    expect(registry.sourceUrl(KEY)).toBe(`pmtiles://${KEY}`);
    expect((await served().getZxy(...SCOTLAND_ONLY))?.from).toBe('sc-basemap.pmtiles');
    // No network behind it: outside every region there is simply no tile.
    expect(await served().getZxy(...OUTSIDE)).toBeUndefined();
  });

  it('describes all its regions in one header', async () => {
    const { registry, served } = setUp();
    registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 0);
    registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 0);

    expect(await served().getHeader()).toMatchObject({
      minZoom: 0,
      maxZoom: 15,
      minLon: -14.9,
      minLat: 52.9,
      maxLon: 0.2,
      maxLat: 61.1,
    });
  });

  it('prefers a region that holds the whole tile over one whose edge crosses it', async () => {
    // Contours are traced per region from a DEM cut to its bbox, so a region's edge tiles
    // are only partly drawn.
    const { registry, served } = setUp();
    registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 0);
    registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 0);
    // Scotland, added first, overlaps the tile too, so it would otherwise answer.
    expect((await served().getZxy(...ACROSS_SCOTLAND_EDGE))?.from).toBe('nw-basemap.pmtiles');
  });

  it('answers from the next region when the first has no such tile', async () => {
    const { registry, northWest, served } = setUp();
    registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 0);
    registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 0);
    northWest.getZxy.mockResolvedValue(undefined);

    expect((await served().getZxy(...IN_BOTH))?.from).toBe('sc-basemap.pmtiles');
  });

  it('leaves a region out below its own floor', async () => {
    const { registry, served } = setUp();
    registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 11);
    registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 6);

    expect((await served().getZxy(...IN_BOTH))?.from).toBe('sc-basemap.pmtiles');
  });

  it('says whether it changed, so a source over it is reloaded only when it did', () => {
    const { registry } = setUp();
    expect(registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 9)).toBe(true);
    expect(registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 9)).toBe(false);
    expect(registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 6)).toBe(true);
    expect(registry.sharedCopyCount(KEY)).toBe(2);
    // An archive that was never registered is not added.
    expect(registry.addSharedCopy(KEY, 'nope.pmtiles', SCOTLAND, 6)).toBe(false);
  });

  it('drops a region when it is deleted, and itself with the last one', async () => {
    const { registry, protocol, served } = setUp();
    registry.addSharedCopy(KEY, 'nw-basemap.pmtiles', NORTH_WEST, 0);
    registry.addSharedCopy(KEY, 'sc-basemap.pmtiles', SCOTLAND, 0);

    expect(registry.removeLocal('nw-basemap.pmtiles')).toEqual([KEY]);
    expect((await served().getZxy(...IN_BOTH))?.from).toBe('sc-basemap.pmtiles');
    expect(registry.sharedCopyCount(KEY)).toBe(1);

    expect(registry.removeLocal('sc-basemap.pmtiles')).toEqual([KEY]);
    expect(registry.sharedCopyCount(KEY)).toBe(0);
    expect(protocol.get(KEY)).toBeUndefined();
  });
});
