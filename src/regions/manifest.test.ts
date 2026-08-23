import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bestAvailableZoom,
  cacheManifest,
  fetchManifest,
  formatBytes,
  loadCachedManifest,
  SUPPORTED_SCHEMA_VERSION,
  type RegionManifest,
} from './manifest';

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

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
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
    expect(loadCachedManifest()?.regions[0].id).toBe('lochaber');
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
    expect(loadCachedManifest()).toBeNull();
  });
});

describe('manifest cache', () => {
  it('round-trips', () => {
    cacheManifest(manifest);
    expect(loadCachedManifest()).toEqual(manifest);
  });

  it('returns null for absent or corrupt cache rather than throwing', () => {
    expect(loadCachedManifest()).toBeNull();

    localStorage.setItem('ratmap:region-manifest', '{not json');
    expect(loadCachedManifest()).toBeNull();

    localStorage.setItem('ratmap:region-manifest', '{"schemaVersion":1}');
    expect(loadCachedManifest()).toBeNull();
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
