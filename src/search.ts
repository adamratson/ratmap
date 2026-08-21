import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { PLACES_DB_URL } from './config';

// C9: search is a local SQLite FTS5 index. No geocoding API — works offline, needs no key
// or quota, and queries never leave the device.
//
// Why the official @sqlite.org/sqlite-wasm rather than sql.js (which the plan names
// first): sql.js ships FTS3 only — `CREATE VIRTUAL TABLE ... USING fts5` fails at runtime
// with "no such module: fts5". Verified directly against its compile options
// (ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, no FTS5). The official build has ENABLE_FTS5.
//
// The DB is deserialized into memory rather than opened through the OPFS VFS: that VFS
// wants SharedArrayBuffer, which needs COOP/COEP response headers, and GitHub Pages
// cannot set headers. In-memory needs none, and the index is small enough (~1.5 MB for
// the current catalog) that this is the simpler correct choice.

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

export class PlacesSearch {
  private db: Database | null = null;
  private loading: Promise<void> | null = null;

  /** True once the index is in memory and queries can run offline. */
  isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Fetch + open the index. Deliberately not called at startup: it pulls ~2 MB of wasm
   * plus the index, and the map should render first.
   */
  async load(): Promise<void> {
    if (this.db) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const [sqlite3, bytes] = await Promise.all([
        sqlite3InitModule({ print: () => {}, printErr: () => {} }) as Promise<Sqlite3Static>,
        fetch(PLACES_DB_URL).then((response) => {
          if (!response.ok) {
            throw new Error(`places index HTTP ${response.status}`);
          }
          return response.arrayBuffer();
        }),
      ]);

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
      this.db = db;
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Prefix search ranked by distance from `origin` (the viewport centre), with the
   * settlement/summit rank as a tie-break.
   */
  search(input: string, origin: SearchOrigin, limit = 20): SearchResult[] {
    if (!this.db) throw new Error('Search index not loaded');

    const match = toMatchQuery(input);
    if (!match) return [];

    // Squared planar distance is enough for ordering — no need for haversine, and it
    // avoids trig per row. Longitude is scaled by cos(lat) so it stays comparable to
    // latitude away from the equator; without it, results skew east/west at high
    // latitudes (very visible in Scotland).
    const lonScale = Math.cos((origin.lat * Math.PI) / 180);

    return this.db.exec({
      sql: `
        SELECT p.name AS name, p.kind AS kind, p.lat AS lat, p.lon AS lon, p.ele AS ele
        FROM places_fts f
        JOIN places p ON p.id = f.rowid
        WHERE places_fts MATCH $match
        ORDER BY
          ((p.lat - $lat) * (p.lat - $lat))
            + (((p.lon - $lon) * $lonScale) * ((p.lon - $lon) * $lonScale)) ASC,
          p.rank DESC
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
    }) as unknown as SearchResult[];
  }
}
