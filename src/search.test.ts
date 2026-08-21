import { describe, expect, it, vi } from 'vitest';

// The wasm module can't load under jsdom, and this file only exercises the pure query
// builder — stub the import so the module is loadable.
vi.mock('@sqlite.org/sqlite-wasm', () => ({ default: vi.fn() }));

const { toMatchQuery } = await import('./search');

describe('toMatchQuery', () => {
  it('prefix-matches the final token so results narrow while typing', () => {
    expect(toMatchQuery('ben')).toBe('"ben"*');
    expect(toMatchQuery('ben nev')).toBe('"ben" "nev"*');
  });

  it('returns null for input with nothing searchable in it', () => {
    for (const input of ['', '   ', '***', '-', '()']) {
      expect(toMatchQuery(input)).toBeNull();
    }
  });

  it('strips FTS5 syntax characters instead of passing them through', () => {
    // Unescaped, these are FTS5 operators: a stray quote or paren makes the query a
    // syntax error rather than a no-match, so the search box would throw on input a
    // user could plausibly type.
    const query = toMatchQuery('ben" OR (nevis*');

    expect(query).not.toBeNull();
    expect(query).not.toContain('(');
    expect(query).not.toContain(')');
    // Every token is quoted, and the only `*` is the trailing one we add ourselves.
    expect(query).toBe('"ben" "OR" "nevis"*');
  });

  it('treats punctuation-separated words as separate tokens', () => {
    expect(toMatchQuery('sgurr-na')).toBe('"sgurr" "na"*');
  });

  it('collapses extra whitespace', () => {
    expect(toMatchQuery('  ben   nevis  ')).toBe('"ben" "nevis"*');
  });
});
