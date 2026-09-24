import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bestAvailableZoom,
  cacheManifest,
  fetchManifest,
  formatBytes,
  formatDuration,
  loadCachedManifest,
  MANIFEST_TIMEOUT_MS,
  SUPPORTED_SCHEMA_VERSION,
  type RegionManifest,
} from './manifest';
import { installFakeOpfs, type FakeDirectory } from '../test-support/fake-opfs';

const manifest: RegionManifest = {
  schemaVersion: 1,
  builtAt: '2026-08-21T19:41:08Z',
  regions: [
    {
      id: 'lochaber',
      name: 'Lochaber & Ben Nevis',
      bbox: [-5.6, 56.5, -4.6, 57.1],
      totalBytes: 22_922_036,
      artifacts: [
        {
          kind: 'basemap',
          filename: 'lochaber-basemap.pmtiles',
          path: 'regions/lochaber/lochaber-basemap.pmtiles',
          bytes: 4_946_628,
        },
      ],
    },
  ],
};

// Node 25 exposes its own experimental `localStorage` global which shadows jsdom's and
// throws "localStorage.clear is not a function" here. Real browsers are unaffected — this
// is purely a test-environment artifact — so stub a minimal in-memory Storage instead.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

let opfs: FakeDirectory;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  opfs = installFakeOpfs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, ...response }));
}

describe('fetchManifest', () => {
  it('returns the parsed catalogue and caches it for offline restore', async () => {
    stubFetch({ json: async () => manifest });

    const result = await fetchManifest();

    expect(result.regions[0].id).toBe('lochaber');
    // The archives live in OPFS but the catalogue describing them is on the network —
    // without a local copy, a cold offline start can't know what it has.
    expect((await loadCachedManifest())?.regions[0].id).toBe('lochaber');
  });

  it('throws on a non-OK response rather than returning an empty catalogue', async () => {
    stubFetch({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchManifest()).rejects.toThrow(/404/);
  });

  it('refuses a newer schema instead of half-understanding it', async () => {
    // A newer manifest could describe artifacts in ways this build mishandles; a wrong
    // offline map is worse than none.
    stubFetch({
      json: async () => ({ ...manifest, schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 }),
    });

    await expect(fetchManifest()).rejects.toThrow(/newer than this app/i);
  });

  it('does not cache a rejected manifest', async () => {
    stubFetch({
      json: async () => ({ ...manifest, schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 }),
    });

    await expect(fetchManifest()).rejects.toThrow();
    expect(await loadCachedManifest()).toBeNull();
  });

  it('gives up after a few seconds on a connection that neither works nor fails', async () => {
    // What a hillside with one bar looks like: the request is accepted and nothing comes.
    // The timer is the platform's (AbortSignal.timeout, which fake timers cannot drive), so
    // stand one in whose firing the test controls.
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
          ),
      ),
    );

    const pending = fetchManifest();
    controller.abort(new DOMException('signal timed out', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeout).toHaveBeenCalledWith(MANIFEST_TIMEOUT_MS);
  });
});

describe('manifest cache', () => {
  it('round-trips through OPFS', async () => {
    await cacheManifest(manifest);
    expect(await loadCachedManifest()).toEqual(manifest);
    expect(opfs.dirs.get('app-data')?.files.has('region-manifest.json')).toBe(true);
  });

  it('stays out of the artifact listing — a subdirectory, not a file at the root', async () => {
    await cacheManifest(manifest);
    expect([...opfs.files.keys()]).toEqual([]);
  });

  it('returns null for an absent or corrupt copy rather than throwing', async () => {
    expect(await loadCachedManifest()).toBeNull();

    const dir = await opfs.getDirectoryHandle('app-data', { create: true });
    dir.files.set('region-manifest.json', '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadCachedManifest()).toBeNull();

    dir.files.set('region-manifest.json', '{"schemaVersion":1}');
    expect(await loadCachedManifest()).toBeNull();
  });

  it('still reads a copy saved the old way, in localStorage, then moves it', async () => {
    // An update must not cost anyone their offline start.
    localStorage.setItem('ratmap:region-manifest', JSON.stringify(manifest));
    expect(await loadCachedManifest()).toEqual(manifest);

    await cacheManifest(manifest);
    expect(localStorage.getItem('ratmap:region-manifest')).toBeNull();
    expect(await loadCachedManifest()).toEqual(manifest);
  });

  it('says so when the copy cannot be saved, instead of failing silently', async () => {
    // It used to swallow this, and the next offline start drew no regions.
    opfs.failWrites = new DOMException('quota exceeded', 'QuotaExceededError');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(cacheManifest(manifest)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith('Could not save the region catalogue for offline use', expect.anything());
  });
});

describe('bestAvailableZoom', () => {
  const withZooms = (maxzooms: Array<number | null | undefined>) => [
    {
      ...manifest.regions[0],
      artifacts: maxzooms.map((maxzoom, i) => ({
        kind: `k${i}`,
        filename: `f${i}.pmtiles`,
        path: `p${i}`,
        bytes: 1,
        maxzoom,
      })),
    },
  ];

  it('reports the deepest zoom any downloaded artifact provides', () => {
    // Lochaber ships basemap z13, terrain z11, contours z14 — the contours are what the
    // user can actually zoom into, so the ceiling is 14.
    expect(bestAvailableZoom(withZooms([13, 11, 14]), 5)).toBe(14);
  });

  it('never reports less than the global catalogue already provides', () => {
    expect(bestAvailableZoom(withZooms([3]), 5)).toBe(5);
  });

  it('falls back when nothing is downloaded', () => {
    expect(bestAvailableZoom([], 5)).toBe(5);
  });

  it('ignores artifacts from an older manifest that has no zoom recorded', () => {
    // Rather than treating a missing zoom as 0 and dragging the ceiling down.
    expect(bestAvailableZoom(withZooms([undefined, null, 13]), 5)).toBe(13);
    expect(bestAvailableZoom(withZooms([undefined, null]), 5)).toBe(5);
  });
});

describe('formatBytes', () => {
  it('scales units so a region size is readable at a glance', () => {
    expect(formatBytes(4_946_628)).toBe('4.9 MB');
    expect(formatBytes(340_000_000)).toBe('340 MB');
    expect(formatBytes(1_100_000_000)).toBe('1.1 GB');
    expect(formatBytes(12_000)).toBe('12 kB');
  });

  it('does not render nonsense for invalid input', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('rounds to the precision the estimate deserves', () => {
    expect(formatDuration(30)).toBe('less than a minute');
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3600)).toBe('1 hr');
    expect(formatDuration(4800)).toBe('1 hr 20 min');
  });

  it('never quotes seconds', () => {
    // The rate this is derived from swings ~2x, so second-level precision would be a
    // number visibly counting wrong rather than a useful estimate.
    expect(formatDuration(63)).not.toMatch(/\bs\b|second/);
    expect(formatDuration(44)).toBe('less than a minute');
  });

  it('does not render nonsense for invalid input', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});
