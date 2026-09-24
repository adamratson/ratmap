import maplibregl from 'maplibre-gl';
import { FetchSource, FileSource, PMTiles, Protocol, type Header, type RangeResponse } from 'pmtiles';

// §3's central module. Owns which archive backs each style source, and is the ONLY place
// `Protocol.add()` and `maplibregl.addProtocol` are called (C17). Basemap, terrain,
// contours and peaks all route through here. Phase 4's region downloader re-registers
// archives here on completion rather than touching MapLibre or pmtiles directly.
//
// Two archive flavours, one lookup key space:
//   remote — FetchSource over HTTPS range requests; keyed by full URL, so a style source
//            written as `pmtiles://https://…` resolves to the same instance.
//   local  — FileSource over an OPFS file handle; keyed by filename, because that is what
//            FileSource.getKey() returns. Hence C3: every artifact needs a globally unique
//            filename or two regions silently serve each other's tiles.

export type ArchiveKey = string;

/** [west, south, east, north], degrees. */
type Bbox = readonly [number, number, number, number];

/** Does tile z/x/y overlap `bbox`? The same test `pmtiles extract --bbox` cuts by. */
function tileOverlaps(z: number, x: number, y: number, [west, south, east, north]: Bbox): boolean {
  const n = 2 ** z;
  const lat = (row: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  const tileWest = (x / n) * 360 - 180;
  const tileEast = ((x + 1) / n) * 360 - 180;
  return tileWest <= east && tileEast >= west && lat(y + 1) <= north && lat(y) >= south;
}

/**
 * A remote archive with downloaded regions' copies of it standing in, inside their regions.
 *
 * For the summits (peaks-global.pmtiles), which used to come only from the network — so a
 * downloaded region lost every summit height and detail card the moment the signal did.
 * Each region now carries a `pmtiles extract` of the same archive; an extract copies tiles
 * byte for byte, so serving a tile from the region's copy is serving the same tile, and
 * nothing is drawn twice, filtered, or duplicated as extra style layers.
 *
 * Registered with the protocol under the remote URL, so the style source is untouched.
 */
class RegionalArchive {
  readonly source: { getKey(): string };
  private readonly remote: PMTiles;
  private readonly copies: Array<{ filename: string; archive: PMTiles; bbox: Bbox }> = [];
  /**
   * Set when a header was asked for with no network and no copy to answer it: MapLibre
   * reads the header once per source and does not retry, so that source has to be told to
   * reload once a copy arrives. See {@link TileSourceRegistry.addRegionalCopy}.
   */
  headerFailed = false;

  constructor(remote: PMTiles) {
    this.remote = remote;
    this.source = { getKey: () => remote.source.getKey() };
  }

  addCopy(filename: string, archive: PMTiles, bbox: Bbox): void {
    this.removeCopy(filename);
    this.copies.push({ filename, archive, bbox });
  }

  removeCopy(filename: string): void {
    const at = this.copies.findIndex((copy) => copy.filename === filename);
    if (at >= 0) this.copies.splice(at, 1);
  }

  async getHeader(): Promise<Header> {
    try {
      return await this.remote.getHeader();
    } catch (err) {
      const copy = this.copies[0];
      if (!copy) {
        this.headerFailed = true;
        throw err;
      }
      // Offline: a copy's header, with the remote's worldwide bounds rather than the
      // region's — outside the regions the remote is still asked for, and fails, rather
      // than the source concluding the world ends at a region's edge.
      const header = await copy.archive.getHeader();
      return { ...header, minLon: -180, minLat: -85.051129, maxLon: 180, maxLat: 85.051129 };
    }
  }

  async getZxy(z: number, x: number, y: number, signal?: AbortSignal): Promise<RangeResponse | undefined> {
    for (const copy of this.copies) {
      if (!tileOverlaps(z, x, y, copy.bbox)) continue;
      const tile = await copy.archive.getZxy(z, x, y, signal);
      // No tile is not proof of nothing: an extract's edge can stop short of a tile the
      // test above says it overlaps. Ask the network then — offline, that fails and the
      // tile is simply empty, which it most likely is.
      if (tile) return tile;
    }
    return this.remote.getZxy(z, x, y, signal);
  }
}

export class TileSourceRegistry {
  readonly protocol: Protocol;
  private readonly archives = new Map<ArchiveKey, PMTiles>();
  /** Remote archives that downloaded regions carry copies of, by URL. */
  private readonly regional = new Map<ArchiveKey, RegionalArchive>();

  constructor(protocol: Protocol = new Protocol()) {
    this.protocol = protocol;
  }

  /**
   * Register the pmtiles:// protocol with MapLibre. Call exactly once per app lifecycle
   * (C17) — repeated registration causes subtle cache and handler issues.
   */
  static install(registry: TileSourceRegistry = new TileSourceRegistry()): TileSourceRegistry {
    maplibregl.addProtocol('pmtiles', registry.protocol.tile);
    return registry;
  }

  /**
   * Register a remote archive. Idempotent: registering the same URL twice returns the
   * existing instance rather than creating a second one.
   */
  addRemote(url: string, { regionalCopies = false }: { regionalCopies?: boolean } = {}): PMTiles {
    const existing = this.archives.get(url);
    if (existing) return existing;

    const archive = new PMTiles(new FetchSource(url));
    if (regionalCopies) {
      // Registered in the archive's place, so tiles inside a downloaded region come from
      // that region's copy — see RegionalArchive.
      const regional = new RegionalArchive(archive);
      this.regional.set(url, regional);
      this.protocol.tiles.set(url, regional as unknown as PMTiles);
    } else {
      this.protocol.add(archive);
    }
    this.archives.set(url, archive);
    return archive;
  }

  /**
   * Serve a downloaded region's copy of the remote archive `remoteUrl` inside `bbox`. The
   * copy must already be registered with {@link addLocal} under `filename`.
   *
   * @returns true when a source over `remoteUrl` failed to load its header before this
   *   copy existed — an offline start, where the style asks before the regions are
   *   restored — and so has to be reloaded to pick it up.
   */
  addRegionalCopy(remoteUrl: string, filename: string, bbox: Bbox): boolean {
    const regional = this.regional.get(remoteUrl);
    const archive = this.archives.get(filename);
    if (!regional || !archive) return false;
    regional.addCopy(filename, archive, bbox);
    const reload = regional.headerFailed;
    regional.headerFailed = false;
    return reload;
  }

  /**
   * Register a local (OPFS) archive from an already-resolved File. The registration key is
   * `file.name` — see the C3 note above; callers are responsible for unique filenames.
   */
  addLocal(file: File): PMTiles {
    const key = file.name;
    const existing = this.archives.get(key);
    if (existing) return existing;

    const archive = new PMTiles(new FileSource(file));
    this.protocol.add(archive);
    this.archives.set(key, archive);
    return archive;
  }

  /**
   * Forget a local archive, so the next `addLocal` for that filename registers the new file.
   *
   * Required whenever the file behind it is deleted. An OPFS `File` is a snapshot: after
   * the file is removed it reads as NotFoundError, and once a new file exists under the
   * same name, NotReadableError (both verified in Chromium, 2026-09-23). Without this, a
   * region deleted and downloaded again in one session got its *old* archive back from
   * `addLocal`, and drew blank until a reload.
   *
   * `protocol.tiles` is pmtiles' own registration map — public, though undocumented, and
   * with no remove method of its own.
   */
  removeLocal(filename: string): void {
    this.archives.delete(filename);
    this.protocol.tiles.delete(filename);
    for (const regional of this.regional.values()) regional.removeCopy(filename);
  }

  /**
   * The value to put in a style source's `url`. Remote archives keep their full URL inside
   * the pmtiles:// scheme; local ones are referenced by bare filename.
   */
  sourceUrl(key: ArchiveKey): string {
    return `pmtiles://${key}`;
  }

  get(key: ArchiveKey): PMTiles | undefined {
    return this.archives.get(key);
  }

  has(key: ArchiveKey): boolean {
    return this.archives.has(key);
  }

  keys(): ArchiveKey[] {
    return [...this.archives.keys()];
  }
}
