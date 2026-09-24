import { TILES_BASE_URL } from '../app/config';
import { isAbsent } from './opfs-store';

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
  return `${TILES_BASE_URL}/${artifact.path}`;
}

// The manifest lives on the network but the archives it describes live in OPFS. On a cold
// offline start we still need to know which artifacts belong to which region in order to
// restore them — so the last-seen manifest is kept on the phone.
//
// In OPFS, beside the archives it describes, not localStorage where it used to live. It
// was "a few kB" when it went there; at global scale it is ~390 kB and growing, against a
// localStorage budget of a few MB shared with everything else — and a write that failed
// for want of room was swallowed, so the next offline start simply drew no regions. OPFS
// has the archives' own quota and the same persistence (C1). In a subdirectory, so the
// artifact listing, which reads files at the root only, never sees it.
const CACHE_DIR = 'app-data';
const CACHE_FILE = 'region-manifest.json';
/** Where it used to be. Read once as a fallback, so an update loses nothing, then removed. */
const LEGACY_CACHE_KEY = 'ratmap:region-manifest';

/**
 * Keep a copy of the catalogue for offline starts. Never throws — a failed save must not
 * fail the fetch that produced it — but never hides the failure either.
 */
export async function cacheManifest(manifest: RegionManifest): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    const handle = await dir.getFileHandle(CACHE_FILE, { create: true });
    // A writable commits on close, all at once: a save interrupted part-way leaves the
    // previous copy, never half of a new one.
    const writable = await handle.createWritable();
    try {
      await writable.write(JSON.stringify(manifest));
      await writable.close();
    } catch (err) {
      await writable.abort?.().catch(() => {});
      throw err;
    }
  } catch (err) {
    console.error('Could not save the region catalogue for offline use', err);
    return;
  }
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch {
    // Private mode: nothing was stored there either.
  }
}

export async function loadCachedManifest(): Promise<RegionManifest | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR);
    const file = await (await dir.getFileHandle(CACHE_FILE)).getFile();
    const cached = asManifest(JSON.parse(await file.text()));
    if (cached) return cached;
  } catch (err) {
    // Absent is ordinary — a first start, or a phone that saved it the old way. Anything
    // else is worth knowing about, and the old copy is still worth trying.
    if (!isAbsent(err)) console.error('Could not read the saved region catalogue', err);
  }
  try {
    return asManifest(JSON.parse(localStorage.getItem(LEGACY_CACHE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function asManifest(value: unknown): RegionManifest | null {
  return Array.isArray((value as RegionManifest | null)?.regions) ? (value as RegionManifest) : null;
}

/**
 * How long to wait for the catalogue before working from the saved copy.
 *
 * Not the browser's own timeout, which on a connection that is up but passing nothing —
 * a hillside with one bar, a captive portal — runs to minutes. Measured before this
 * existed: with the catalogue request hanging, no downloaded region was drawn at all
 * after 15 s, against all of them within 5 s when the same request failed outright.
 */
export const MANIFEST_TIMEOUT_MS = 5_000;

/**
 * The catalogue uses a schema this build does not understand.
 *
 * Its own type because it calls for a different answer from a network failure: the fix is
 * updating the app, not finding signal, and the regions sheet has to say which.
 */
export class CatalogueTooNew extends Error {
  constructor(schemaVersion: number) {
    super(
      `Region catalogue is newer than this app (schema ${schemaVersion} > ` +
        `${SUPPORTED_SCHEMA_VERSION}). Update the app to download regions.`,
    );
    this.name = 'CatalogueTooNew';
  }
}

export async function fetchManifest(
  signal: AbortSignal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
): Promise<RegionManifest> {
  // `no-cache` = revalidate every time, don't skip the cache. The catalogue is the one
  // piece of app data at a stable URL with no content hash in it, so a cached copy is how
  // a newly published region stays invisible for however long the bucket's max-age is.
  // Revalidation costs a conditional GET that answers 304 for a few hundred bytes; the
  // stronger `no-store` would only throw away the copy that makes that 304 possible.
  // (Offline, this fetch fails either way and the caller falls back to loadCachedManifest.
  // On a connection that neither works nor fails, the default signal gives up for it.)
  const response = await fetch(`${TILES_BASE_URL}/regions/manifest.json`, {
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
    throw new CatalogueTooNew(manifest.schemaVersion);
  }

  await cacheManifest(manifest);
  return manifest;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * A remaining-time estimate, rounded to the precision the estimate actually deserves.
 *
 * Never shows seconds. The underlying rate swings by roughly 2x on these buckets, so
 * "1 min" is honest where "1 min 3 s" is false precision that visibly counts wrong.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 45) return 'less than a minute';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
