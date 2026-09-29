import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { StatusCentre } from '../ui/status';

// The FTS index needs the SQLite wasm runtime, which jsdom cannot load; the search itself
// is covered by search.test.ts. Here only what the box does with a result matters.
const searchImpl = vi.hoisted(() => ({
  fail: null as Error | null,
  empty: false,
  regions: 0,
  synced: [] as unknown[],
}));

vi.mock('./search', () => ({
  PlacesSearch: class {
    load = vi.fn(async () => {});
    syncRegions = vi.fn(async (indexes: unknown[]) => void searchImpl.synced.push(indexes));
    regionCount = () => searchImpl.regions;
    search = vi.fn(() => {
      if (searchImpl.fail) throw searchImpl.fail;
      if (searchImpl.empty) return [];
      return [{ name: 'Ben Nevis', kind: 'peak', ele: 1345, lat: 56.797, lon: -5.004 }];
    });
  },
}));

const { SearchBox } = await import('./search-view');

describe('SearchBox focus after choosing a result', () => {
  let input: HTMLInputElement;
  let results: HTMLUListElement;
  let toast: ReturnType<typeof vi.fn<StatusCentre['toast']>>;
  let onCoordinates: ReturnType<typeof vi.fn<(coords: { lat: number; lng: number }) => void>>;

  beforeEach(() => {
    // jsdom does no layout, so it has no scrollIntoView; every browser does. Without this
    // the arrow keys threw inside the listener — the tests still passed, but as uncaught
    // errors, which fail the whole run.
    Element.prototype.scrollIntoView ??= () => {};

    const container = document.createElement('div');
    input = document.createElement('input');
    results = document.createElement('ul');
    results.hidden = true;
    container.append(input, results);
    document.body.append(container);
    onCoordinates = vi.fn();

    const map = {
      easeTo: vi.fn(),
      getZoom: () => 8,
      getCenter: () => ({ lat: 56.8, lng: -5 }),
    } as unknown as MLMap;
    toast = vi.fn();
    searchImpl.fail = null;
    searchImpl.empty = false;
    searchImpl.regions = 0;
    searchImpl.synced = [];
    new SearchBox({
      container,
      input,
      results,
      map,
      status: { toast },
      onCoordinates,
      regionIndexes: () => [{ filename: 'lochaber-places-1.sqlite', read: async () => null }],
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function typeAndWaitForResults(query: string): Promise<void> {
    input.focus();
    input.value = query;
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => {
      if (results.hidden) throw new Error('no results yet');
    });
  }

  const press = (key: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key }));

  it('keeps focus in the search box when a result is chosen with Enter', async () => {
    // It used to blur unconditionally, which sent a keyboard user back to <body>.
    await typeAndWaitForResults('ben');
    press('ArrowDown');
    press('Enter');

    expect(results.hidden).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('still puts the phone keyboard away when a result is tapped', async () => {
    await typeAndWaitForResults('ben');
    results.querySelector('button')!.dispatchEvent(new MouseEvent('click', { detail: 1 }));

    expect(document.activeElement).not.toBe(input);
  });

  it('hands a chosen coordinate pair on, however it was chosen', async () => {
    await typeAndWaitForResults('56.79685, -5.00360');
    press('ArrowDown');
    press('Enter');

    expect(onCoordinates).toHaveBeenCalledWith({ lat: 56.79685, lng: -5.0036 });
  });

  it('says so when a search throws, and clears the stale results', async () => {
    await typeAndWaitForResults('ben');
    searchImpl.fail = new Error('SQLITE_ERROR: fts5 syntax error');

    input.value = 'ben nevis';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());

    expect(toast).toHaveBeenCalledWith('Search failed: SQLITE_ERROR: fts5 syntax error', { kind: 'warn' });
    expect(results.hidden).toBe(true);
  });

  it('searches the downloaded regions’ indexes, asked for afresh each time', async () => {
    await typeAndWaitForResults('ben');
    input.value = 'ben n';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(searchImpl.synced).toHaveLength(2));
    expect(searchImpl.synced[1]).toEqual([expect.objectContaining({ filename: 'lochaber-places-1.sqlite' })]);
  });

  it('says where villages come from when nothing matches and no region is downloaded', async () => {
    searchImpl.empty = true;
    await typeAndWaitForResults('imlil');
    expect(results.textContent).toBe('No matches. Villages and smaller summits come with a downloaded region.');
  });

  it('says only "No matches" once regions are being searched', async () => {
    searchImpl.empty = true;
    searchImpl.regions = 1;
    await typeAndWaitForResults('zzz');
    expect(results.textContent).toBe('No matches');
  });
});
