import maplibregl from 'maplibre-gl';
import { FetchSource, FileSource, PMTiles, Protocol } from 'pmtiles';

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

export class TileSourceRegistry {
  readonly protocol: Protocol;
  private readonly archives = new Map<ArchiveKey, PMTiles>();

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
  addRemote(url: string): PMTiles {
    const existing = this.archives.get(url);
    if (existing) return existing;

    const archive = new PMTiles(new FetchSource(url));
    this.protocol.add(archive);
    this.archives.set(url, archive);
    return archive;
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
