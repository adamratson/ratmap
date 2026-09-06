import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PMTiles } from 'pmtiles';
import { decodePathLines, globalToLngLat, lngLatToTile } from '../src/routes/path-tiles';
import { densify, pathLengthMetres, type LngLat } from '../src/routes/geo';
import { SacSampler, summariseSacGrades } from '../src/routes/sac-sampler';
import { NodeFileSource } from './node-file-source';

// The one thing the unit tests cannot stand in for: matching a route built from
// **Protomaps' tiling** of the OSM ways against **our own tippecanoe tiling** of the same
// ways. Everything else about the sampler is exercised with synthetic tiles, but the
// question this feature rests on — do two independent generalisations of the same path
// land within the snap tolerance of each other — can only be answered by real archives.
//
// Skipped when the archives are absent, which is the normal state of a fresh clone (build
// output, gitignored). Rebuild with:
//   ./scripts/build-sac.sh && ./scripts/build-region.sh scotland
const BASEMAP = 'infra/dist/regions/scotland/scotland-basemap.pmtiles';
const SAC = 'infra/dist/regions/scotland/scotland-sac.pmtiles';
const ARCHIVES_PRESENT = existsSync(BASEMAP) && existsSync(SAC);

/** The longest single run of a named path in the basemap, as the router would follow it. */
async function longestNamedPath(archive: PMTiles, name: string, near: LngLat): Promise<LngLat[]> {
  const centre = lngLatToTile(near[0], near[1], 15);
  const world = 4096 * 2 ** 15;
  let best: LngLat[] = [];

  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const tile = { z: 15, x: centre.x + dx, y: centre.y + dy };
      const response = await archive.getZxy(tile.z, tile.x, tile.y);
      if (!response) continue;

      for (const line of decodePathLines(response.data, tile).lines) {
        if (line.name !== name) continue;
        const coords: LngLat[] = [];
        for (let i = 0; i < line.coords.length; i += 2) {
          coords.push(globalToLngLat(line.coords[i], line.coords[i + 1], world));
        }
        // One tile's clipped run, not every run joined end to end: joining them would
        // insert straight jumps between disjoint pieces and count those as ungraded.
        if (pathLengthMetres(coords) > pathLengthMetres(best)) best = coords;
      }
    }
  }

  return best;
}

describe.skipIf(!ARCHIVES_PRESENT)('SAC grades against the real archives', () => {
  it('grades a route drawn from the basemap, across the two tilings', async () => {
    const basemap = new PMTiles(new NodeFileSource(BASEMAP) as never);
    const sac = new PMTiles(new NodeFileSource(SAC) as never);

    const route = await longestNamedPath(basemap, 'Ben Nevis Mountain Path', [-5.0036, 56.7969]);
    expect(pathLengthMetres(route)).toBeGreaterThan(500);

    const samples = densify(route, 25);
    const grades = await new SacSampler({ archive: sac, maxzoom: 15 }).grades(samples);
    const summary = summariseSacGrades(samples, grades);

    // The Pony Track is tagged mountain_hiking (T2) over most of its length, T1 lower
    // down. If the two tilings had drifted apart by more than the snap tolerance this
    // would be near zero — the failure this test exists to catch.
    expect(summary.coverage).toBeGreaterThan(0.9);
    expect(summary.hardest).toBeGreaterThanOrEqual(2);
    expect(summary.metresByGrade.get(2)).toBeGreaterThan(500);
  }, 60_000);

  it('leaves ground with no graded path near it ungraded', async () => {
    const sac = new PMTiles(new NodeFileSource(SAC) as never);

    // Open water in Loch Linnhe: inside the archive's bounds, nowhere near a path. A
    // sampler that answered here would be answering by proximity to anything at all.
    const samples: LngLat[] = [
      [-5.24, 56.68],
      [-5.2395, 56.6805],
      [-5.239, 56.681],
    ];

    expect(await new SacSampler({ archive: sac, maxzoom: 15 }).grades(samples)).toEqual([
      null,
      null,
      null,
    ]);
  }, 30_000);
});
