import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PMTiles } from 'pmtiles';
import { PathGraph } from '../src/routes/path-graph';
import { decodePathLines, tilesForBbox } from '../src/routes/path-tiles';
import { boundsOf, distanceMetres, type LngLat } from '../src/routes/geo';

// End-to-end check of the offline router against a **real built region archive**, not a
// fixture: PMTiles → vector tile → clip → graph → Dijkstra, over the same file the app
// downloads into OPFS.
//
// Skipped when `infra/dist` is absent, which is the normal state of a fresh clone (it is
// build output and gitignored). Everything the router does that can be tested from
// fixtures already is — see path-tiles.test.ts and path-graph.test.ts. What only real
// tiles can prove is that Protomaps' actual geometry stitches across tile seams and that
// the network is connected over a route long enough to span several tiles, which is
// exactly the property that fails silently.
//
// Rebuild the archive with: infra/scripts/build-regions.sh
const ARCHIVE = 'infra/dist/regions/lochaber/lochaber-basemap.pmtiles';

// Ben Nevis summit, and the Achintee end of the Mountain Path — both read out of the
// archive itself (2026-08-23) rather than from memory, so the test starts where the data
// actually puts the path rather than where the trailhead roughly is. ACHINTEE is offset
// ~40 m off the path on purpose: snapping is part of what is under test.
const SUMMIT: LngLat = [-5.0037, 56.7969];
const ACHINTEE: LngLat = [-5.0765, 56.8094];

class NodeFileSource {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return {
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    } finally {
      await handle.close();
    }
  }
}

async function buildGraph(bbox: [number, number, number, number], zoom: number): Promise<PathGraph> {
  const archive = new PMTiles(new NodeFileSource(ARCHIVE) as never);
  const tiles = tilesForBbox(bbox, zoom);
  let graph: PathGraph | null = null;

  for (const tile of tiles) {
    const response = await archive.getZxy(tile.z, tile.x, tile.y);
    if (!response) continue;
    const { lines, extent } = decodePathLines(response.data, tile);
    graph ??= new PathGraph(extent * 2 ** zoom);
    for (const line of lines) graph.addLine(line);
  }

  return graph ?? new PathGraph(4096 * 2 ** zoom);
}

describe.skipIf(!existsSync(ARCHIVE))('routing over a real region archive', () => {
  it('routes Achintee to the Ben Nevis summit over the mountain path', async () => {
    const bbox = boundsOf([ACHINTEE, SUMMIT], 1500)!;
    const graph = await buildGraph(bbox, 15);

    expect(graph.nodeCount).toBeGreaterThan(100);

    const leg = graph.routeBetween(ACHINTEE, SUMMIT, { costing: 'walking' })!;
    expect(leg).not.toBeNull();

    // The pony track is about 7.5 km each way. A route materially shorter than the
    // straight-line distance would mean the graph is lying; one far longer would mean it
    // found some absurd detour.
    const asTheCrowFlies = distanceMetres(ACHINTEE, SUMMIT);
    expect(leg.distanceM).toBeGreaterThan(asTheCrowFlies);
    expect(leg.distanceM).toBeGreaterThan(6_000);
    expect(leg.distanceM).toBeLessThan(12_000);

    // The route has to actually reach the summit, not stop at the last node it could get
    // to — Dijkstra returning a short path to a nearby dead end would still "succeed".
    expect(distanceMetres(leg.coords[leg.coords.length - 1], SUMMIT)).toBeLessThan(200);

    // Named in OSM, so a correct route says so.
    expect(leg.wayNames.join(' ')).toContain('Ben Nevis');
  });

  it('crosses tile seams — the route spans more than one tile', async () => {
    const bbox = boundsOf([ACHINTEE, SUMMIT], 1500)!;
    const graph = await buildGraph(bbox, 15);
    const leg = graph.routeBetween(ACHINTEE, SUMMIT)!;

    const tilesTouched = new Set(
      leg.coords.map(([lng, lat]) => {
        const n = 2 ** 15;
        const x = Math.floor(((lng + 180) / 360) * n);
        const latRad = (lat * Math.PI) / 180;
        const y = Math.floor(
          ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
        );
        return `${x}/${y}`;
      }),
    );

    // Seam stitching is the whole reason for clipping to exact tile bounds; a route this
    // long touching only one tile would mean it never left it.
    expect(tilesTouched.size).toBeGreaterThan(3);
  });
});
