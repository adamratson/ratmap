import type { PMTiles } from 'pmtiles';
import type { LngLat } from './geo';
import { lngLatToGlobal } from './path-tiles';

// Elevation sampling straight out of a region's terrain archive.
//
// §4 Phase 4 specifies `map.queryTerrainElevation()` for this, and that call is the reason
// the project chose a PWA over React Native. Read before relying on it (2026-08-23,
// maplibre-gl v5 `src/render/terrain.ts`), it turns out to have two properties that make
// it the wrong tool for a *route* profile:
//
//   1. `getDEMElevation()` returns **0** — not null — for any DEM tile that is not
//      currently loaded, and tiles load only for the current viewport. A profile for a
//      route that does not fit on screen would therefore read as sea level over half its
//      length, with nothing to distinguish that from genuinely being at sea level. That is
//      exactly the silent-wrong-answer failure this document's constraints exist to
//      prevent (C1's principle).
//   2. The value is multiplied by the terrain exaggeration, so it is only in real metres
//      when exaggeration happens to be 1.
//
// Reading the archive ourselves avoids both: it is viewport-independent, exaggeration-
// independent, returns null where there is genuinely no data, and needs no `setTerrain()`
// on the map. It is also the same shape as the router — both read the region archives the
// user already downloaded, through the same registry. The offline claim in §4 stands
// either way; this just makes it true for the whole route rather than the visible part.

/** A decoded DEM tile: RGBA rows, as `getImageData` returns them. */
export interface DecodedTile {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type TileImageDecoder = (bytes: ArrayBuffer) => Promise<DecodedTile>;

export interface TerrainSamplerOptions {
  archive: PMTiles;
  /** The archive's own maxzoom, from the region manifest. */
  maxzoom: number;
  /** Override for tests; defaults to createImageBitmap + OffscreenCanvas. */
  decode?: TileImageDecoder;
  /** Decoded tiles held in memory. Each is a few MB, so this is a real memory bound. */
  cacheSize?: number;
}

/**
 * Terrarium encoding: elevation in metres = (R * 256 + G + B / 256) - 32768.
 *
 * This is the encoding Mapterhorn publishes and the one the map's `raster-dem` sources
 * already declare (`encoding: 'terrarium'` in main.ts and region-layers.ts). Decoding it
 * differently here than the renderer does would produce a profile that disagrees with the
 * hillshade under it.
 */
function terrariumMetres(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export class TerrainSampler {
  private readonly archive: PMTiles;
  private readonly maxzoom: number;
  private readonly decode: TileImageDecoder;
  private readonly cacheSize: number;
  private readonly tiles = new Map<string, DecodedTile | null>();

  constructor(options: TerrainSamplerOptions) {
    this.archive = options.archive;
    this.maxzoom = options.maxzoom;
    this.decode = options.decode ?? decodeWithImageBitmap;
    this.cacheSize = options.cacheSize ?? 12;
  }

  /**
   * Heights for a list of points, index for index. `null` where the archive has no tile.
   *
   * Points are grouped by tile so each one is fetched and decoded once, however many
   * samples fall inside it — a route profile is thousands of points over a handful of
   * tiles, and decoding per point would be thousands of WebP decodes.
   */
  async sample(points: readonly LngLat[], signal?: AbortSignal): Promise<(number | null)[]> {
    const results: (number | null)[] = new Array(points.length).fill(null);
    if (points.length === 0) return results;

    // Tile size is a property of the archive, not something to assume — read it from the
    // first tile that decodes, then reuse.
    let tileSize = 512;
    const byTile = new Map<string, number[]>();

    for (let i = 0; i < points.length; i++) {
      const key = tileKeyFor(points[i], this.maxzoom);
      const bucket = byTile.get(key);
      if (bucket) bucket.push(i);
      else byTile.set(key, [i]);
    }

    for (const [key, indices] of byTile) {
      if (signal?.aborted) throw new DOMException('Profile cancelled', 'AbortError');

      const [x, y] = key.split('/').map(Number);
      const tile = await this.tileAt(x, y, signal);
      if (!tile) continue;

      tileSize = tile.width;
      const world = tileSize * 2 ** this.maxzoom;

      for (const index of indices) {
        const [gx, gy] = lngLatToGlobal(points[index][0], points[index][1], world);
        results[index] = samplePixel(tile, gx - x * tileSize, gy - y * tileSize);
      }
    }

    return results;
  }

  private async tileAt(x: number, y: number, signal?: AbortSignal): Promise<DecodedTile | null> {
    const key = `${x}/${y}`;
    const cached = this.tiles.get(key);
    // `null` is a real cached answer — "this archive has no tile here" — so check
    // membership rather than truthiness, or every empty tile is re-fetched every time.
    if (this.tiles.has(key)) return cached ?? null;

    let decoded: DecodedTile | null = null;
    try {
      const response = await this.archive.getZxy(this.maxzoom, x, y, signal);
      if (response) decoded = await this.decode(response.data);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      // A tile that will not decode is missing data, not a crash: the profile reports it
      // as a gap through `coverage` rather than failing the whole route.
      decoded = null;
    }

    if (this.tiles.size >= this.cacheSize) {
      const oldest = this.tiles.keys().next().value;
      if (oldest !== undefined) this.tiles.delete(oldest);
    }
    this.tiles.set(key, decoded);
    return decoded;
  }
}

function tileKeyFor(point: LngLat, zoom: number): string {
  const n = 2 ** zoom;
  const x = Math.floor(((point[0] + 180) / 360) * n);
  const latRad = (point[1] * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return `${Math.max(0, Math.min(n - 1, x))}/${Math.max(0, Math.min(n - 1, y))}`;
}

/**
 * Bilinear sample of a decoded terrarium tile at tile-local pixel coordinates.
 *
 * Bilinear rather than nearest so a profile reads as a slope rather than a staircase —
 * at ~21 m per pixel, nearest sampling puts a visible 21 m-wide step in every hillside.
 * Neighbouring pixels are clamped to the tile rather than reaching into the adjacent
 * archive tile: the error that introduces is confined to the half-pixel at a tile edge,
 * which is far below the DEM's own 30 m resolution.
 */
function samplePixel(tile: DecodedTile, px: number, py: number): number | null {
  // Shift to pixel-centre space before flooring. A pixel's height is the terrain at its
  // centre, not at its top-left corner, so interpolating straight from the raw coordinate
  // offsets the whole DEM by half a pixel — about 10 m on the ground at z11. Small enough
  // to look right and large enough to put a summit on the wrong side of a ridge.
  const cx = px - 0.5;
  const cy = py - 0.5;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const tx = cx - x0;
  const ty = cy - y0;

  const at = (x: number, y: number): number | null => {
    const cx = Math.max(0, Math.min(tile.width - 1, x));
    const cy = Math.max(0, Math.min(tile.height - 1, y));
    const offset = (cy * tile.width + cx) * 4;
    if (offset < 0 || offset + 2 >= tile.data.length) return null;
    return terrariumMetres(tile.data[offset], tile.data[offset + 1], tile.data[offset + 2]);
  };

  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  if (a === null || b === null || c === null || d === null) return null;

  return (
    a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
  );
}

/**
 * Default decoder: `createImageBitmap` + OffscreenCanvas.
 *
 * `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'` are not optional. A DEM
 * tile's RGB channels are a 24-bit number, not a colour; letting the browser apply a
 * colour profile or premultiply alpha to them corrupts the elevation by an amount that
 * varies per pixel — which would look like plausible terrain and be wrong everywhere.
 */
async function decodeWithImageBitmap(bytes: ArrayBuffer): Promise<DecodedTile> {
  const bitmap = await createImageBitmap(new Blob([bytes]), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas unavailable for DEM decoding');

    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    bitmap.close();
  }
}
