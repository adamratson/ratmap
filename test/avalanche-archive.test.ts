import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PMTiles } from 'pmtiles';
import { NodeFileSource } from './node-file-source';
import { AVALANCHE_ENCODING, SLOPE_FLOOR_DEG, slopeClassFor } from '../src/avalanche';

// Checks the **published bytes**, not the code that wrote them.
//
// This project keeps finding that the code and the artifact disagree — index contours
// tagged `idx` while the style read `index`, a basemap with no paths under the grade bands
// it was drawing. Both were found by decoding real tiles rather than by reading source.
// The avalanche layer has the same shape of risk and a worse consequence, so its channel
// semantics are asserted against a real archive here.
//
// Skipped without the build output (gitignored) or without GDAL. Rebuild with:
//   cd infra && ./scripts/build-avalanche.sh <region>
//
// Whichever region happens to be built, rather than a fixed one: these are gitignored
// artifacts and which of the 41 flagged regions a given machine holds is incidental. The
// assertions are all about channel semantics, which every region shares.
function findArchive(): string | null {
  const root = 'infra/dist/regions';
  if (!existsSync(root)) return null;
  for (const region of readdirSync(root).sort()) {
    const path = join(root, region, `${region}-avalanche-1.pmtiles`);
    if (existsSync(path)) return path;
  }
  return null;
}

const ARCHIVE = findArchive();

function haveGdal(): boolean {
  try {
    execFileSync('gdal_translate', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Decode one tile to band-sequential bytes: all of R, then all of G, then all of B. */
function decodeBands(blob: Uint8Array): { width: number; bands: Uint8Array[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ratmap-av-'));
  try {
    // The extension has to match the payload or GDAL picks the wrong driver. The build
    // writes lossless WebP by default and PNG under AVALANCHE_NO_WEBP, so sniff the magic
    // rather than assuming either.
    const isWebp =
      blob[0] === 0x52 && blob[1] === 0x49 && blob[2] === 0x46 && blob[3] === 0x46;
    const src = join(dir, isWebp ? 't.webp' : 't.png');
    const out = join(dir, 'd.img');
    writeFileSync(src, blob);
    // INTERLEAVE=BSQ pins the layout: left alone GDAL emits BIP for PNG and BSQ for WebP,
    // which would silently reinterpret every channel here depending on the tile format.
    execFileSync('gdal_translate', [
      '-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BSQ', src, out,
    ]);
    const raw = new Uint8Array(readFileSync(out));
    const header = readFileSync(join(dir, 'd.hdr'), 'utf8');
    const width = Number(/samples\s*=\s*(\d+)/.exec(header)?.[1]);
    const lines = Number(/lines\s*=\s*(\d+)/.exec(header)?.[1]);
    const plane = width * lines;
    return {
      width,
      bands: [
        raw.subarray(0, plane),
        raw.subarray(plane, 2 * plane),
        raw.subarray(2 * plane, 3 * plane),
      ],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ARCHIVE || !haveGdal())(
  'the built avalanche terrain archive',
  () => {
    const archive = new PMTiles(new NodeFileSource(ARCHIVE!) as never);

    /** The tile covering the archive's own centre, decoded once and reused. */
    async function centreTile(): Promise<{ slope: Uint8Array; aspect: Uint8Array; runout: Uint8Array }> {
      const header = await archive.getHeader();
      const n = 2 ** header.maxZoom;
      const latRad = (header.centerLat * Math.PI) / 180;
      const x = Math.floor(((header.centerLon + 180) / 360) * n);
      const y = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
      );
      const tile = await archive.getZxy(header.maxZoom, x, y);
      if (!tile) throw new Error(`no tile at the archive centre (${header.maxZoom}/${x}/${y})`);
      const [slope, aspect, runout] = decodeBands(new Uint8Array(tile.data)).bands;
      return { slope, aspect, runout };
    }

    it('declares a zoom range capped at the DEM resolution', async () => {
      const header = await archive.getHeader();
      // Copernicus GLO-30 is ~30 m, and z12 at 512 px is ~10 m even at the equator.
      // Publishing deeper than this would present interpolation as measurement (A5).
      expect(header.maxZoom).toBeLessThanOrEqual(12);
      expect(header.minZoom).toBeGreaterThanOrEqual(8);
      expect(header.maxZoom).toBeGreaterThanOrEqual(header.minZoom);
    });

    it('stores slope, aspect and runout with the semantics the app decodes', async () => {
      const { slope, aspect, runout } = await centreTile();

      // Scanned in a plain loop with the failures collected, rather than an expect() per
      // pixel: a 512x512 tile is 262 144 cells and per-cell matchers time the suite out
      // long before they find anything. This also reports the first real offender instead
      // of just the first index.
      const bad: string[] = [];
      let steep = 0;
      let maxSlope = 0;
      for (let i = 0; i < slope.length && bad.length < 5; i++) {
        const s = slope[i];
        // R is either 0 ("below the drawn threshold" — A7, not "flat") or a real angle in
        // the published band. Anything between 1 and 24 would mean the floor was lost.
        if (s !== 0 && (s < SLOPE_FLOOR_DEG || s > 60 || slopeClassFor(s) === null)) {
          bad.push(`slope ${s} at ${i} is outside the published band`);
        }
        // Aspect is masked to exactly the cells the slope layer draws — that masking is
        // what makes the channel affordable (+18% rather than +102%), so a regression
        // here shows up as artifact size before it shows up as anything else.
        if (s === 0 && aspect[i] !== 0) bad.push(`aspect ${aspect[i]} at ${i} with no slope`);
        if (s !== 0 && (aspect[i] < 1 || aspect[i] > 8)) {
          bad.push(`aspect ${aspect[i]} at ${i} is not an octant`);
        }
        // Stage A ships the runout channel empty. When Stage B fills it the artifact
        // becomes -2, so this staying 0 also checks the two are not being confused.
        if (runout[i] !== 0) bad.push(`runout ${runout[i]} at ${i}`);
        if (s !== 0) {
          steep++;
          if (s > maxSlope) maxSlope = s;
        }
      }
      expect(bad).toEqual([]);

      // Liechtenstein is alpine; a centre tile with no steep ground at all would mean the
      // projection correction had collapsed (A1) or the wrong tile was read.
      expect(steep, 'no cells above the slope floor in an alpine region').toBeGreaterThan(0);
      expect(maxSlope).toBeGreaterThanOrEqual(35);
    });

    it('decodes through the app encoding to the slope angle itself', async () => {
      const { slope, aspect, runout } = await centreTile();
      const { redFactor, greenFactor, blueFactor, baseShift } = AVALANCHE_ENCODING;

      // What MapLibre's shader computes, on real published bytes: the value the colour
      // ramp sees must floor back to the stored slope for every cell, or the aspect and
      // runout channels riding underneath have pushed a cell into the wrong class.
      const wrong: string[] = [];
      for (let i = 0; i < slope.length && wrong.length < 5; i++) {
        const value =
          slope[i] * redFactor + aspect[i] * greenFactor + runout[i] * blueFactor - baseShift;
        if (Math.floor(value) !== slope[i]) {
          wrong.push(`cell ${i}: ${value} does not floor to ${slope[i]}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  },
);
