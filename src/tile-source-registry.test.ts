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
});
