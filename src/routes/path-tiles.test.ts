import { describe, expect, it } from 'vitest';
import { fromGeojsonVt } from 'vt-pbf';
import {
  clipToBounds,
  decodePathLines,
  globalToLngLat,
  lngLatToTile,
  tilesForBbox,
} from './path-tiles';

const EXTENT = 4096;

/** Encode real MVT bytes so the decoder is exercised against the wire format. */
function encodeTile(features: Array<{ points: number[][]; tags: Record<string, string> }>): Uint8Array {
  return fromGeojsonVt(
    {
      roads: {
        features: features.map((f) => ({ type: 2, geometry: [f.points], tags: f.tags })),
      },
    },
    { version: 2, extent: EXTENT },
  );
}

describe('clipToBounds', () => {
  it('leaves a wholly-inside line untouched', () => {
    const coords = [10, 10, 20, 20, 30, 10];
    expect(clipToBounds(coords, 0, 0, 100, 100)).toEqual([coords]);
  });

  it('cuts a line at the boundary it crosses', () => {
    // Runs left to right, out through x = 100.
    const pieces = clipToBounds([50, 50, 150, 50], 0, 0, 100, 100);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toEqual([50, 50, 100, 50]);
  });

  it('cuts both tiles copies of a crossing to the same point', () => {
    // The stitching guarantee: two tiles hold the same source segment, each buffered a
    // different distance past the shared edge at x = 100. Clipped to that edge, both must
    // end at exactly the same coordinate or the graph has a hole at every seam.
    const left = clipToBounds([50, 50, 130, 50], 0, 0, 100, 100)[0];
    const right = clipToBounds([70, 50, 200, 50], 100, 0, 200, 100)[0];
    expect(left.slice(-2)).toEqual(right.slice(0, 2));
  });

  it('splits a line that leaves and re-enters', () => {
    const pieces = clipToBounds([50, 50, 150, 50, 150, 20, 50, 20], 0, 0, 100, 100);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toEqual([50, 50, 100, 50]);
    expect(pieces[1]).toEqual([100, 20, 50, 20]);
  });

  it('drops a line that misses the box entirely', () => {
    expect(clipToBounds([200, 200, 300, 300], 0, 0, 100, 100)).toEqual([]);
  });

  it('drops a crossing that only clips a corner to a single point', () => {
    // Nothing to route along; a one-vertex "line" would otherwise create a stray node.
    expect(clipToBounds([100, 200, 200, 100], 0, 0, 100, 100)).toEqual([]);
  });
});

describe('decodePathLines', () => {
  const tile = { z: 15, x: 15928, y: 10072 };

  it('offsets tile-local coordinates into the global grid', () => {
    const bytes = encodeTile([
      { points: [[100, 200], [300, 400]], tags: { kind: 'path', kind_detail: 'path' } },
    ]);
    const { lines, extent } = decodePathLines(bytes, tile);

    expect(extent).toBe(EXTENT);
    expect(lines).toHaveLength(1);
    expect(lines[0].coords).toEqual([
      tile.x * EXTENT + 100,
      tile.y * EXTENT + 200,
      tile.x * EXTENT + 300,
      tile.y * EXTENT + 400,
    ]);
  });

  it('keeps roads a walker can use and drops the ones they cannot', () => {
    const bytes = encodeTile([
      { points: [[10, 10], [20, 20]], tags: { kind: 'path', kind_detail: 'path' } },
      { points: [[10, 30], [20, 40]], tags: { kind: 'minor_road' } },
      { points: [[10, 50], [20, 60]], tags: { kind: 'highway', kind_detail: 'motorway' } },
      { points: [[10, 70], [20, 80]], tags: { kind: 'rail' } },
    ]);
    const { lines } = decodePathLines(bytes, tile);
    expect(lines.map((l) => l.kind)).toEqual(['path', 'minor_road']);
  });

  it('drops ways tagged as barred', () => {
    const bytes = encodeTile([
      { points: [[10, 10], [20, 20]], tags: { kind: 'path', access: 'private' } },
      // `destination` bars through traffic, not people — a legitimate approach on foot.
      { points: [[10, 30], [20, 40]], tags: { kind: 'minor_road', access: 'destination' } },
    ]);
    const { lines } = decodePathLines(bytes, tile);
    expect(lines.map((l) => l.kind)).toEqual(['minor_road']);
  });

  it('carries the way name through for the route description', () => {
    const bytes = encodeTile([
      {
        points: [[10, 10], [20, 20]],
        tags: { kind: 'path', kind_detail: 'path', name: 'Ben Nevis Mountain Path' },
      },
    ]);
    const { lines } = decodePathLines(bytes, tile);
    expect(lines[0].name).toBe('Ben Nevis Mountain Path');
  });

  it('clips the rendering buffer away', () => {
    // A vertex well past the tile's own edge — present for label and stroke rendering,
    // and duplicated in the neighbouring tile.
    const bytes = encodeTile([
      { points: [[4000, 100], [4300, 100]], tags: { kind: 'path' } },
    ]);
    const { lines } = decodePathLines(bytes, tile);
    const maxX = Math.max(lines[0].coords[0], lines[0].coords[2]);
    expect(maxX).toBeLessThanOrEqual((tile.x + 1) * EXTENT);
  });

  it('returns nothing for a tile with no roads layer', () => {
    const bytes = fromGeojsonVt({ water: { features: [] } }, { extent: EXTENT });
    expect(decodePathLines(bytes, tile).lines).toEqual([]);
  });
});

describe('tile maths', () => {
  it('places Ben Nevis in the tile the archive actually stores it in', () => {
    // Verified against lochaber-basemap.pmtiles on 2026-08-23: this tile holds the
    // Ben Nevis Mountain Path.
    expect(lngLatToTile(-5.0037, 56.7969, 15)).toEqual({ x: 15928, y: 10072 });
  });

  it('covers a bbox with a rectangle of tiles', () => {
    const tiles = tilesForBbox([-5.02, 56.79, -5.0, 56.8], 15);
    expect(tiles.length).toBeGreaterThan(1);
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    expect(tiles).toHaveLength(xs.size * ys.size);
  });

  it('round-trips a tile origin back to a coordinate inside that tile', () => {
    const world = EXTENT * 2 ** 15;
    const [lng, lat] = globalToLngLat(15928 * EXTENT + 2048, 10072 * EXTENT + 2048, world);
    expect(lngLatToTile(lng, lat, 15)).toEqual({ x: 15928, y: 10072 });
  });
});
