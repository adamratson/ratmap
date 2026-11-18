import { describe, expect, it } from 'vitest';
import { fromGeojsonVt } from 'vt-pbf';
import { admitRestricted, decodeAccessLines, MATCH_TOLERANCE_M } from './walkable-access';
import type { PathLine } from './path-tiles';

const EXTENT = 4096;
const WORLD = EXTENT * 2 ** 15;
// The College Valley, so metres-per-unit is the real one (~0.17 m).
const LAT = 55.52;
const UNITS_PER_M = WORLD / (40_075_016.686 * Math.cos((LAT * Math.PI) / 180));
const m = (metres: number): number => Math.round(metres * UNITS_PER_M);

function restricted(coords: number[]): PathLine {
  return { coords, kind: 'path', kindDetail: 'track', name: null, restricted: true };
}

// A private track running east for 300 m, in three 100 m segments.
const TRACK = [0, 0, m(100), 0, m(200), 0, m(300), 0];

describe('admitRestricted', () => {
  it('admits a restricted way that an open-on-foot way runs along, unmarked', () => {
    const pieces = admitRestricted(restricted(TRACK), [TRACK], WORLD, LAT);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].coords).toEqual(TRACK);
    expect(pieces[0].restricted).toBeUndefined();
    expect(pieces[0].kindDetail).toBe('track');
  });

  it('admits only the stretch the open way covers', () => {
    // A bridleway along the first 200 m; the last 100 m is someone's drive.
    const bridleway = [0, 0, m(200), 0];
    const pieces = admitRestricted(restricted(TRACK), [bridleway], WORLD, LAT);
    expect(pieces.map((piece) => piece.coords)).toEqual([[0, 0, m(100), 0, m(200), 0]]);
  });

  it('tolerates the drift of a way edited since the basemap was built', () => {
    const shifted = [0, m(MATCH_TOLERANCE_M - 1), m(300), m(MATCH_TOLERANCE_M - 1)];
    expect(admitRestricted(restricted(TRACK), [shifted], WORLD, LAT)).toHaveLength(1);
  });

  it('does not admit a private way beside a public one', () => {
    const besideIt = [0, m(10), m(300), m(10)];
    expect(admitRestricted(restricted(TRACK), [besideIt], WORLD, LAT)).toEqual([]);
  });

  it('does not admit a private way because a public path crosses it', () => {
    const crossing = [m(150), -m(100), m(150), m(100)];
    expect(admitRestricted(restricted(TRACK), [crossing], WORLD, LAT)).toEqual([]);
  });

  it('does not admit a segment that runs well past the end of the open way', () => {
    // Open for 150 m: the middle segment is half on it, half beyond — dropped whole.
    const pieces = admitRestricted(restricted(TRACK), [[0, 0, m(150), 0]], WORLD, LAT);
    expect(pieces.map((piece) => piece.coords)).toEqual([[0, 0, m(100), 0]]);
  });

  it('admits nothing when there is nothing open nearby', () => {
    expect(admitRestricted(restricted(TRACK), [], WORLD, LAT)).toEqual([]);
  });
});

describe('decodeAccessLines', () => {
  it('reads lines in global units, buffer included', () => {
    const tile = { z: 15, x: 16187, y: 10247 };
    const bytes = fromGeojsonVt(
      {
        access: {
          features: [{ type: 2, geometry: [[[100, 200], [4200, 200]]], tags: { foot: 'designated' } }],
        },
      },
      { version: 2, extent: EXTENT },
    );
    const lines = decodeAccessLines(bytes, tile);
    expect(lines).toEqual([[tile.x * EXTENT + 100, tile.y * EXTENT + 200, tile.x * EXTENT + 4200, tile.y * EXTENT + 200]]);
  });

  it('returns nothing for a tile without the layer', () => {
    const bytes = fromGeojsonVt({ other: { features: [] } }, { version: 2, extent: EXTENT });
    expect(decodeAccessLines(bytes, { z: 15, x: 0, y: 0 })).toEqual([]);
  });
});
