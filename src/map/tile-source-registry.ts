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

/** Tile z/x/y's own extent, as a bbox. */
function tileBbox(z: number, x: number, y: number): Bbox {
  const n = 2 ** z;
  const lat = (row: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

/** Does tile z/x/y overlap `bbox`? The same test `pmtiles extract --bbox` cuts by. */
function tileOverlaps(z: number, x: number, y: number, [west, south, east, north]: Bbox): boolean {
  const [tileWest, tileSouth, tileEast, tileNorth] = tileBbox(z, x, y);
  return tileWest <= east && tileEast >= west && tileSouth <= north && tileNorth >= south;
}

/** Does `bbox` hold all of tile z/x/y? */
function tileWithin(z: number, x: number, y: number, [west, south, east, north]: Bbox): boolean {
  const [tileWest, tileSouth, tileEast, tileNorth] = tileBbox(z, x, y);
  return tileWest >= west && tileEast <= east && tileSouth >= south && tileNorth <= north;
}

interface RegionalCopy {
  filename: string;
  archive: PMTiles;
  bbox: Bbox;
  /** The lowest zoom this copy answers for. See TileSourceRegistry.addSharedCopy. */
  floor: number;
}

/**
 * One archive as the map sees it, made of downloaded regions' copies — each answering
 * inside its own region — and, for some, a remote archive answering everywhere else.
 *
 * With a remote: the summits (peaks-global.pmtiles), which used to come only from the
 * network — so a downloaded region lost every summit height and detail card the moment the
 * signal did. Each region now carries a `pmtiles extract` of the same archive; an extract
 * copies tiles byte for byte, so serving a tile from the region's copy is serving the same
 * tile, and nothing is drawn twice, filtered, or duplicated as extra style layers.
 * Registered with the protocol under the remote URL, so the style source is untouched.
 *
 * Without one: every other kind of region artifact, shared by all the regions that carry
 * it (see TileSourceRegistry.addSharedCopy). One style source per kind, and so one set of
 * layers, wherever the regions overlap.
 */
class RegionalArchive {
  readonly source: { getKey(): string };
  readonly remote: PMTiles | null;
  private readonly copies: RegionalCopy[] = [];
  /**
   * Set when a header was asked for with no network and no copy to answer it: MapLibre
   * reads the header once per source and does not retry, so that source has to be told to
   * reload once a copy arrives. See {@link TileSourceRegistry.addRegionalCopy}.
   */
  headerFailed = false;

  constructor(key: string, remote: PMTiles | null) {
    this.remote = remote;
    this.source = { getKey: () => key };
  }

  /** @returns false when this exact copy was already there. */
  addCopy(copy: RegionalCopy): boolean {
    const existing = this.copies.find((other) => other.filename === copy.filename);
    if (
      existing &&
      existing.archive === copy.archive &&
      existing.floor === copy.floor &&
      existing.bbox.every((edge, i) => edge === copy.bbox[i])
    ) {
      return false;
    }
    this.removeCopy(copy.filename);
    this.copies.push(copy);
    return true;
  }

  /** @returns whether there was such a copy. */
  removeCopy(filename: string): boolean {
    const at = this.copies.findIndex((copy) => copy.filename === filename);
    if (at < 0) return false;
    this.copies.splice(at, 1);
    return true;
  }

  get size(): number {
    return this.copies.length;
  }

  async getHeader(): Promise<Header> {
    if (!this.remote) return this.copiesHeader();
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

  /**
   * The copies' own header, stretched to cover all of them: their zoom range and their
   * bounds together. Every copy in one archive has the same zoom range and tile type —
   * the caller keys shared archives on them — so this differs from any one copy's header
   * only in its bounds.
   */
  private async copiesHeader(): Promise<Header> {
    const headers = await Promise.all(this.copies.map((copy) => copy.archive.getHeader()));
    const [first] = headers;
    if (!first) throw new Error(`No downloaded region carries ${this.source.getKey()}`);
    return {
      ...first,
      minZoom: Math.min(...headers.map((h) => h.minZoom)),
      maxZoom: Math.max(...headers.map((h) => h.maxZoom)),
      minLon: Math.min(...headers.map((h) => h.minLon)),
      minLat: Math.min(...headers.map((h) => h.minLat)),
      maxLon: Math.max(...headers.map((h) => h.maxLon)),
      maxLat: Math.max(...headers.map((h) => h.maxLat)),
    };
  }

  /**
   * Which copies may answer for tile z/x/y, best first: those whose region holds the whole
   * tile, then those it only overlaps. Contours and slope shading are traced per region
   * from a DEM clipped to its bbox, so a region's edge tiles are only partly drawn, and a
   * neighbour that holds the whole tile has all of it. Extracted kinds have whole tiles
   * either way, so for them the order changes nothing.
   */
  private candidates(z: number, x: number, y: number): RegionalCopy[] {
    const overlapping = this.copies.filter((copy) => z >= copy.floor && tileOverlaps(z, x, y, copy.bbox));
    return [
      ...overlapping.filter((copy) => tileWithin(z, x, y, copy.bbox)),
      ...overlapping.filter((copy) => !tileWithin(z, x, y, copy.bbox)),
    ];
  }

  async getZxy(z: number, x: number, y: number, signal?: AbortSignal): Promise<RangeResponse | undefined> {
    for (const copy of this.candidates(z, x, y)) {
      const tile = await copy.archive.getZxy(z, x, y, signal);
      // No tile is not proof of nothing: an extract's edge can stop short of a tile the
      // test above says it overlaps. Try the next copy, then the network — offline, that
      // fails and the tile is simply empty, which it most likely is.
      if (tile) return tile;
    }
    return this.remote?.getZxy(z, x, y, signal);
  }
}

export class TileSourceRegistry {
  readonly protocol: Protocol;
  private readonly archives = new Map<ArchiveKey, PMTiles>();
  /**
   * Archives made of downloaded regions' copies: remote ones by URL, shared ones by the
   * key their style source names (see addSharedCopy).
   */
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
      const regional = new RegionalArchive(url, archive);
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
    regional.addCopy({ filename, archive, bbox, floor: 0 });
    const reload = regional.headerFailed;
    regional.headerFailed = false;
    return reload;
  }

  /**
   * Add a downloaded region's archive, already registered with {@link addLocal} under
   * `filename`, to the archive shared under `key` by every region carrying the same kind.
   * A style source over `sourceUrl(key)` then draws all of them as one.
   *
   * Why shared: with a source per region, wherever two regions overlapped, whichever was
   * added later painted its basemap's opaque ground over everything the other drew. A
   * region that lacked an artifact — Scotland before its landmarks, over the masts on
   * Great Dun Fell inside its bbox — hid the other region's copy of it (2026-10-28).
   *
   * `floor` is the lowest zoom the copy answers for; below it the region would draw a box
   * of its own tiles over the world map (regionMinZoom in region-layers.ts).
   *
   * @returns whether the archive changed, so a source already over it must be reloaded.
   */
  addSharedCopy(key: ArchiveKey, filename: string, bbox: Bbox, floor: number): boolean {
    const archive = this.archives.get(filename);
    if (!archive) return false;
    let shared = this.regional.get(key);
    if (!shared) {
      shared = new RegionalArchive(key, null);
      this.regional.set(key, shared);
      this.protocol.tiles.set(key, shared as unknown as PMTiles);
    }
    return shared.addCopy({ filename, archive, bbox, floor });
  }

  /** How many regions' copies the shared archive `key` is made of. */
  sharedCopyCount(key: ArchiveKey): number {
    const shared = this.regional.get(key);
    return shared && !shared.remote ? shared.size : 0;
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
   *
   * @returns the regional and shared archives the file was taken out of, whose sources
   *   now hold tiles of a region that is gone.
   */
  removeLocal(filename: string): ArchiveKey[] {
    this.archives.delete(filename);
    this.protocol.tiles.delete(filename);
    const changed: ArchiveKey[] = [];
    for (const [key, regional] of this.regional) {
      if (!regional.removeCopy(filename)) continue;
      changed.push(key);
      // A shared archive with no copies left has nothing to answer with; a remote one
      // still has the network.
      if (!regional.remote && regional.size === 0) {
        this.regional.delete(key);
        this.protocol.tiles.delete(key);
      }
    }
    return changed;
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
