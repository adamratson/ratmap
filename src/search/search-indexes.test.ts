import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real SQLite runtime cannot load outside a browser (3.41.2 has no Node build), so this
// fake stands in for it: a "database" is the JSON of its rows, and a query filters and
// orders them the way search.ts's SQL does. What is under test is everything above the
// SQL — which indexes are open, how their answers are merged, and what survives a failure.
// The index format and FTS itself are tested where they are built (build-places-db).

interface Row {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  ele: number | null;
  rank: number;
}

const fake = vi.hoisted(() => {
  const memory = new Map<number, Uint8Array>();
  const live = new Map<number, { rows: Row[]; label: string }>();
  let next = 1;
  const closed: string[] = [];
  class DB {
    pointer = next++;
    rows: Row[] = [];
    label = '';
    constructor() {
      live.set(this.pointer, this);
    }
    exec(opts: { bind: Record<string, number | string> }): unknown[] {
      const { $match, $lat, $lon, $lonScale, $limit } = opts.bind as Record<string, number & string>;
      // The last token is the prefix, as toMatchQuery builds it: `"ben" "nev"*`.
      const tokens = String($match)
        .split(' ')
        .map((token) => token.replace(/["*]/g, '').toLowerCase());
      return this.rows
        .filter((row) => {
          const words = row.name.toLowerCase().split(/\s+/);
          return tokens.every((token) => words.some((word) => word.startsWith(token)));
        })
        .map((row) => ({
          ...row,
          distance: (row.lat - $lat) ** 2 + ((row.lon - $lon) * $lonScale) ** 2,
        }))
        .sort((a, b) => a.distance - b.distance || b.rank - a.rank)
        .slice(0, $limit);
    }
    close(): void {
      closed.push(this.label);
    }
  }
  const module = {
    wasm: {
      allocFromTypedArray: (data: Uint8Array) => {
        const pointer = next++;
        memory.set(pointer, data);
        return pointer;
      },
    },
    oo1: { DB },
    capi: {
      SQLITE_DESERIALIZE_FREEONCLOSE: 1,
      sqlite3_deserialize: (dbPointer: number, _schema: string, pointer: number) => {
        const db = live.get(dbPointer);
        if (!db) return 1;
        const doc = JSON.parse(new TextDecoder().decode(memory.get(pointer))) as { label: string; rows: Row[] };
        db.rows = doc.rows;
        db.label = doc.label;
        return 0;
      },
    },
  };
  return { closed, module };
});

vi.mock('@sqlite.org/sqlite-wasm', () => ({ default: async () => fake.module }));

const { PlacesSearch } = await import('./search');

function index(label: string, rows: Partial<Row>[]): ArrayBuffer {
  const full = rows.map((row) => ({ kind: 'village', ele: null, rank: 40, lat: 0, lon: 0, name: '', ...row }));
  return new TextEncoder().encode(JSON.stringify({ label, rows: full })).buffer as ArrayBuffer;
}

const fallbackBytes = index('fallback', [
  { name: 'Marrakesh', kind: 'city', lat: 31.63, lon: -8.0, rank: 100 },
  { name: 'Fort William', kind: 'town', lat: 56.82, lon: -5.1, rank: 60 },
]);
const morocco = index('morocco', [
  { name: 'Imlil', lat: 31.14, lon: -7.92 },
  { name: 'Marrakesh', kind: 'city', lat: 31.63, lon: -8.0, rank: 100 },
]);
const lochaber = index('lochaber', [{ name: 'Fort William', kind: 'town', lat: 56.82, lon: -5.1, rank: 60 }]);

const origin = { lat: 31.5, lon: -8.0 };

beforeEach(() => {
  fake.closed.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(fallbackBytes)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlacesSearch across indexes', () => {
  it('finds a village only once its region is on the device', async () => {
    const search = new PlacesSearch();
    await search.load();
    expect(search.search('imlil', origin)).toEqual([]);
    expect(search.regionCount()).toBe(0);

    await search.syncRegions([{ filename: 'morocco-places-1.sqlite', read: async () => morocco }]);
    expect(search.regionCount()).toBe(1);
    expect(search.search('imlil', origin).map((r) => r.name)).toEqual(['Imlil']);
  });

  it('merges every index nearest first, and lists a place found in two of them once', async () => {
    const search = new PlacesSearch();
    await search.load();
    await search.syncRegions([
      { filename: 'morocco-places-1.sqlite', read: async () => morocco },
      { filename: 'lochaber-places-1.sqlite', read: async () => lochaber },
    ]);
    // Marrakesh is in the fallback and in Morocco's index; Fort William in the fallback and
    // Lochaber's. Each comes back once, ordered by distance from the viewport.
    const results = search.search('m', origin).concat(search.search('f', origin));
    expect(results.map((r) => r.name)).toEqual(['Marrakesh', 'Fort William']);
    expect(Object.keys(results[0]).sort()).toEqual(['ele', 'kind', 'lat', 'lon', 'name']);
  });

  it('closes the index of a region that has been deleted, and opens each one once', async () => {
    const search = new PlacesSearch();
    await search.load();
    const read = vi.fn(async () => morocco);
    const indexes = [{ filename: 'morocco-places-1.sqlite', read }];
    await search.syncRegions(indexes);
    await search.syncRegions(indexes);
    expect(read).toHaveBeenCalledTimes(1);

    await search.syncRegions([]);
    expect(fake.closed).toEqual(['morocco']);
    expect(search.search('imlil', origin)).toEqual([]);
  });

  it('skips an index that will not open, and keeps searching the rest', async () => {
    const search = new PlacesSearch();
    await search.load();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = vi.fn(async () => {
      throw new Error('NotReadableError');
    });
    await search.syncRegions([
      { filename: 'broken-places-1.sqlite', read: broken },
      { filename: 'morocco-places-1.sqlite', read: async () => morocco },
    ]);
    await search.syncRegions([
      { filename: 'broken-places-1.sqlite', read: broken },
      { filename: 'morocco-places-1.sqlite', read: async () => morocco },
    ]);
    // Not re-read on every keystroke.
    expect(broken).toHaveBeenCalledTimes(1);
    expect(search.search('imlil', origin).map((r) => r.name)).toEqual(['Imlil']);
    error.mockRestore();
  });

  it('searches the downloaded regions when the fallback will not load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const search = new PlacesSearch();
    await search.load();
    expect(() => search.search('imlil', origin)).toThrow('places index HTTP 404');

    await search.syncRegions([{ filename: 'morocco-places-1.sqlite', read: async () => morocco }]);
    expect(search.search('imlil', origin).map((r) => r.name)).toEqual(['Imlil']);
    error.mockRestore();
  });
});
