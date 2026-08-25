import { R2_BASE_URL } from '../config';

// C16: the manifest schema is versioned and open-ended — a region is "a set of named
// artifacts", not a fixed basemap+terrain pair. Nothing here may hardcode artifact names;
// contours (and later routing tiles) must be additive, not a migration.

export const SUPPORTED_SCHEMA_VERSION = 1;

export type ArtifactKind = 'basemap' | 'terrain' | 'contours' | (string & {});

export interface RegionArtifact {
  kind: ArtifactKind;
  /** Globally unique (C3) — also the OPFS filename and TileSourceRegistry key. */
  filename: string;
  /** Path relative to the bucket root. */
  path: string;
  bytes: number;
  /** Real zoom range from the archive's PMTiles header. Absent on older manifests. */
  minzoom?: number | null;
  maxzoom?: number | null;
  sha256?: string;
}

/**
 * The best zoom a set of downloaded regions actually provides.
 *
 * Read from the artifacts rather than assumed, so the "limited detail" notice can't claim
 * a fully-downloaded region is low-detail — a warning that fires when it shouldn't is
 * worse than none, because it trains people to ignore it.
 */
export function bestAvailableZoom(regions: Region[], fallback: number): number {
  const zooms = regions
    .flatMap((region) => region.artifacts)
    .map((artifact) => artifact.maxzoom)
    .filter((zoom): zoom is number => typeof zoom === 'number' && Number.isFinite(zoom));

  return zooms.length > 0 ? Math.max(...zooms, fallback) : fallback;
}

export interface Region {
  id: string;
  name: string;
  /**
   * Continent the region is listed under — for grouping and disambiguation in the
   * catalogue, which once it spans the globe contains Georgia twice.
   *
   * Optional: manifests published before the catalogue went global do not carry it.
   */
  group?: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  totalBytes: number;
  artifacts: RegionArtifact[];
}

export interface RegionManifest {
  schemaVersion: number;
  builtAt: string;
  regions: Region[];
}

export function artifactUrl(artifact: RegionArtifact): string {
  return `${R2_BASE_URL}/${artifact.path}`;
}

// The manifest lives on the network but the archives it describes live in OPFS. On a cold
// offline start we still need to know which artifacts belong to which region in order to
// restore them — so the last-seen manifest is cached locally. It's a few kB of JSON, so
// localStorage is appropriate; the archives themselves never go near it (C5).
const MANIFEST_CACHE_KEY = 'ratmap:region-manifest';

export function cacheManifest(manifest: RegionManifest): void {
  try {
    localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify(manifest));
  } catch {
    // Private mode or a full quota: restore-from-cache degrades, downloads still work.
  }
}

export function loadCachedManifest(): RegionManifest | null {
  try {
    const raw = localStorage.getItem(MANIFEST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RegionManifest;
    return Array.isArray(parsed?.regions) ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchManifest(signal?: AbortSignal): Promise<RegionManifest> {
  // `no-cache` = revalidate every time, don't skip the cache. The catalogue is the one
  // piece of app data at a stable URL with no content hash in it, so a cached copy is how
  // a newly published region stays invisible for however long the bucket's max-age is.
  // Revalidation costs a conditional GET that answers 304 for a few hundred bytes; the
  // stronger `no-store` would only throw away the copy that makes that 304 possible.
  // (Offline, this fetch fails either way and the caller falls back to loadCachedManifest.)
  const response = await fetch(`${R2_BASE_URL}/regions/manifest.json`, {
    signal,
    cache: 'no-cache',
  });
  if (!response.ok) {
    throw new Error(`Region manifest HTTP ${response.status}`);
  }

  const manifest = (await response.json()) as RegionManifest;

  // Refuse a schema we don't understand rather than half-reading it: a newer manifest
  // could describe artifacts in ways this build would silently mis-handle, and a wrong
  // offline map is worse than none (C1's principle).
  if (manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Region catalogue is newer than this app (schema ${manifest.schemaVersion} > ` +
        `${SUPPORTED_SCHEMA_VERSION}). Update the app to download regions.`,
    );
  }

  cacheManifest(manifest);
  return manifest;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
