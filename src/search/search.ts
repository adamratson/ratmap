import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { PLACES_DB_URL } from '../app/config';

// C9: search is a local SQLite FTS5 index. No geocoding API — works offline, needs no key
// or quota, and queries never leave the device.
//
// Why the official @sqlite.org/sqlite-wasm rather than sql.js (which the plan names
// first): sql.js ships FTS3 only — `CREATE VIRTUAL TABLE ... USING fts5` fails at runtime
// with "no such module: fts5". Verified directly against its compile options
// (ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, no FTS5). The official build has ENABLE_FTS5.
//
// Two kinds of index, searched together (infra/scripts/tools/cmd/build-places-db/cut.go):
//
//   - the global fallback, shipped with the app and precached, so search works before any
//     region is downloaded: the largest cities and towns, and the highest notable summits;
//   - one per downloaded region, `<id>-places-1.sqlite`, fetched with the region's archives
//     and kept beside them in OPFS: every place and summit in it, villages included.
//
// A planet-wide index would be a few hundred MB, which a phone can neither download on a
// whim nor hold in memory — hence the split, with search scoped to what is on the device.
//
// Each DB is deserialized into memory rather than opened through the OPFS VFS: that VFS
// wants SharedArrayBuffer, which needs COOP/COEP response headers, and GitHub Pages
// cannot set headers. In-memory needs none; a region's index is a few MB.

export interface SearchResult {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  ele: number | null;
}

export interface SearchOrigin {
  lat: number;
  lon: number;
}

/** FTS5 treats punctuation as syntax; a raw user string can be a syntax error. */
export function toMatchQuery(input: string): string | null {
  // Keep letters/digits/whitespace only, then quote each token and prefix-match the last
  // one so results narrow as the user types.
  const tokens = input
    .replace(/["*()\-:^]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return null;

  return tokens
    .map((token, index) => {
      const quoted = `"${token.replace(/"/g, '')}"`;
      return index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' ');
}

/** A downloaded region's search index, as the search box hands it over. */
export interface RegionIndex {
  /** The artifact's filename: unique (C3), and the key an open index is kept under. */
  filename: string;
  /** Its bytes, or null if the file has gone. */
  read(): Promise<ArrayBuffer | null>;
}

type Sqlite = Sqlite3Static;

function openFromBytes(sqlite3: Sqlite, bytes: ArrayBuffer): Database {
  const data = new Uint8Array(bytes);
  const pointer = sqlite3.wasm.allocFromTypedArray(data);
  const db = new sqlite3.oo1.DB();
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer!,
    'main',
    pointer,
    data.length,
    data.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
  );
  if (rc !== 0) {
    db.close();
    throw new Error(`sqlite3_deserialize failed (rc=${rc})`);
  }
  return db;
}

interface Ranked extends SearchResult {
  distance: number;
  rank: number;
}

/**
 * The matches in one index, nearest `origin` first with the settlement/summit rank as a
 * tie-break, with the distance measure attached so results from several indexes can be
 * merged in the same order.
 */
function queryIndex(db: Database, match: string, origin: SearchOrigin, limit: number): Ranked[] {
  // Squared planar distance is enough for ordering — no need for haversine, and it
  // avoids trig per row. Longitude is scaled by cos(lat) so it stays comparable to
  // latitude away from the equator; without it, results skew east/west at high
  // latitudes (very visible in Scotland).
  const lonScale = Math.cos((origin.lat * Math.PI) / 180);

  return db.exec({
    sql: `
      SELECT p.name AS name, p.kind AS kind, p.lat AS lat, p.lon AS lon, p.ele AS ele,
        ((p.lat - $lat) * (p.lat - $lat))
          + (((p.lon - $lon) * $lonScale) * ((p.lon - $lon) * $lonScale)) AS distance,
        p.rank AS rank
      FROM places_fts f
      JOIN places p ON p.id = f.rowid
      WHERE places_fts MATCH $match
      ORDER BY distance ASC, p.rank DESC
      LIMIT $limit
    `,
    bind: {
      $match: match,
      $lat: origin.lat,
      $lon: origin.lon,
      $lonScale: lonScale,
      $limit: limit,
    },
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Ranked[];
}

/**
 * The same place as found in two indexes — a town is in the fallback and in its region's
 * index, and a border village in both neighbours'. The key the pipeline dedupes on.
 */
function placeKey(r: SearchResult): string {
  return `${r.name}\u0000${r.kind}\u0000${r.lat.toFixed(4)}\u0000${r.lon.toFixed(4)}`;
}

export class PlacesSearch {
  private sqlite3: Sqlite | null = null;
  private fallback: Database | null = null;
  private fallbackError: Error | null = null;
  private loading: Promise<void> | null = null;

  /** Open region indexes, by artifact filename. */
  private readonly regional = new Map<string, Database>();
  /** Indexes that would not open, so a bad file is not re-read on every keystroke. */
  private readonly unreadable = new Set<string>();
  private syncing: Promise<void> = Promise.resolve();

  /** True once there is something to search. */
  isReady(): boolean {
    return this.fallback !== null || this.regional.size > 0;
  }

  /** How many downloaded regions' indexes are being searched. */
  regionCount(): number {
    return this.regional.size;
  }

  /**
   * Load the SQLite runtime and the fallback index. Deliberately not called at startup: it
   * pulls ~2 MB of wasm plus the index, and the map should render first.
   *
   * Fails only if the runtime does. A fallback that will not load leaves the downloaded
   * regions' indexes to search, which is exactly the offline case they exist for.
   */
  async load(): Promise<void> {
    if (this.sqlite3) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const [sqlite3, bytes] = await Promise.all([
        // Imported here, not at the top of the file: statically imported, SQLite's JS glue
        // (~187 kB, 72% of the dependency chunk) was parsed on every startup by every
        // visitor, for a search box most sessions never touch. The wasm itself was already
        // deferred; now the code that loads it is too. See the `sqlite` chunk group in
        // vite.config.ts, which keeps it out of the startup chunk.
        import('@sqlite.org/sqlite-wasm').then(({ default: sqlite3InitModule }) =>
          sqlite3InitModule({ print: () => {}, printErr: () => {} }) as Promise<Sqlite>,
        ),
        fetch(PLACES_DB_URL)
          .then((response) => {
            if (!response.ok) throw new Error(`places index HTTP ${response.status}`);
            return response.arrayBuffer();
          })
          .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
      ]);

      this.sqlite3 = sqlite3;
      if (bytes instanceof Error) {
        this.fallbackError = bytes;
        console.error('Could not load the global search index', bytes);
      } else {
        this.fallback = openFromBytes(sqlite3, bytes);
      }
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Search exactly the regions on this device: open the indexes of any newly downloaded,
   * close those of any deleted. Cheap when nothing has changed, so it runs before every
   * search rather than being told about downloads.
   */
  syncRegions(indexes: RegionIndex[]): Promise<void> {
    // One at a time: keystrokes arrive faster than an index opens, and two passes opening
    // the same file at once would each deserialize a copy.
    const next = this.syncing.then(() => this.sync(indexes));
    this.syncing = next.catch(() => {});
    return next;
  }

  private async sync(indexes: RegionIndex[]): Promise<void> {
    const sqlite3 = this.sqlite3;
    if (!sqlite3) throw new Error('Search index not loaded');

    const wanted = new Set(indexes.map((index) => index.filename));
    for (const [filename, db] of this.regional) {
      if (wanted.has(filename)) continue;
      db.close(); // frees its copy (SQLITE_DESERIALIZE_FREEONCLOSE)
      this.regional.delete(filename);
    }
    for (const filename of this.unreadable) {
      if (!wanted.has(filename)) this.unreadable.delete(filename);
    }

    for (const index of indexes) {
      if (this.regional.has(index.filename) || this.unreadable.has(index.filename)) continue;
      try {
        const bytes = await index.read();
        if (bytes) this.regional.set(index.filename, openFromBytes(sqlite3, bytes));
      } catch (err) {
        // One unreadable index must not take search down with it: the others, and the
        // fallback, still answer. Tried again once the set of regions changes.
        this.unreadable.add(index.filename);
        console.error(`Could not open the search index ${index.filename}`, err);
      }
    }
  }

  /**
   * Prefix search across the fallback and every downloaded region's index, ranked by
   * distance from `origin` (the viewport centre), with the settlement/summit rank as a
   * tie-break.
   */
  search(input: string, origin: SearchOrigin, limit = 20): SearchResult[] {
    if (!this.isReady()) throw this.fallbackError ?? new Error('Search index not loaded');

    const match = toMatchQuery(input);
    if (!match) return [];

    const found: Ranked[] = [];
    for (const db of [...(this.fallback ? [this.fallback] : []), ...this.regional.values()]) {
      found.push(...queryIndex(db, match, origin, limit));
    }
    found.sort((a, b) => a.distance - b.distance || b.rank - a.rank);

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const r of found) {
      const key = placeKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name: r.name, kind: r.kind, lat: r.lat, lon: r.lon, ele: r.ele });
      if (results.length === limit) break;
    }
    return results;
  }
}
