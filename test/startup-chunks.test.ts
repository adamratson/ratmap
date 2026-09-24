import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// What a visitor downloads and parses before the map can draw. SQLite (search) is ~187 kB
// of JS that most sessions never use; it is imported only when the search box is first
// used. One static `import` anywhere would silently put it back on the startup path, and
// nothing else would notice — so this reads the build output and checks.
//
// Needs a build (`npm run build`), like service-worker.test.ts; skips without one.

const ASSETS = 'dist/assets';
const INDEX = 'dist/index.html';

describe.skipIf(!existsSync(INDEX))('what loads at startup', () => {
  const files = readdirSync(ASSETS);
  const entry = readFileSync(`${ASSETS}/${files.find((f) => f.startsWith('index-') && f.endsWith('.js'))}`, 'utf8');
  const html = readFileSync(INDEX, 'utf8');
  const sqliteChunk = files.find((f) => f.startsWith('sqlite-') && f.endsWith('.js'));

  it('keeps SQLite in a chunk of its own', () => {
    expect(sqliteChunk).toBeDefined();
    const vendor = files.find((f) => f.startsWith('vendor-') && f.endsWith('.js'));
    expect(readFileSync(`${ASSETS}/${vendor}`, 'utf8')).not.toMatch(/sqlite3_deserialize/);
  });

  it('neither preloads nor statically imports it', () => {
    expect(html).not.toContain(sqliteChunk);
    // A static import is `from"./sqlite-….js"`; the lazy one is `import(`./sqlite-….js`)`.
    expect(entry).not.toMatch(new RegExp(`from\\s*["'\`]\\./${sqliteChunk}`));
    expect(entry).toMatch(new RegExp(`import\\(\\s*["'\`]\\./${sqliteChunk}`));
  });
});
