import type { Map as MLMap } from 'maplibre-gl';
import type { MapInk } from '../map/flavor';

// Ground surface detail Protomaps does not carry: scree, shingle and rock outcrops. Checked
// directly against Protomaps' own `Landuse.java` (2026-09-18) — its OSM ingestion path maps
// `natural=bare_rock` into the `landuse` layer but drops `scree`/`shingle`/`rock`/`stone`
// outright; they're only reachable there via Overture data, which is not in this project's
// region extracts. So this rides on its own artifact, `<region>-terrain-features.pmtiles`,
// built by infra/scripts/build-terrain-features.sh from OSM and cut per region the same way
// sac and paths are (C16). `bare_rock` is deliberately excluded here — see
// src/map/landuse.ts, which paints it from data the basemap already carries.
//
// **Drawn the way an OS Explorer sheet draws it:** scree as a scatter of small dots,
// outcrops outlined — texture, not a flat tint. A tint says "something is here"; the
// stipple says "loose stone underfoot", and stays legible over contours and hillshade
// where a translucent fill just muddies both.
//
// **No individual boulders.** The artifact still carries `natural=stone`/`rock` *nodes*,
// but they are not drawn: the Lake District has thousands per screen at z15 (on-device,
// Kirk Fell, 2026-09-24) and they buried every path and label. Only areas render here.
//
// **Coverage is partial and non-uniform, the same shape as SAC's.** Most of the world's
// `natural=` surface tagging is incomplete, and density varies by well over an order of
// magnitude between ranges. A hillside with nothing drawn here is not "there is no scree".

export const TERRAIN_FEATURES_SOURCE_LAYER = 'terrain_features';

export type TerrainFeatureKind = 'scree' | 'shingle' | 'rock' | 'stone';

export interface TerrainFeatureKindInfo {
  kind: TerrainFeatureKind;
  label: string;
  note: string;
}

/** `stone` areas (boulder fields) share the rock treatment — OSM cannot tell them apart. */
export const TERRAIN_FEATURE_KINDS: readonly TerrainFeatureKindInfo[] = [
  {
    kind: 'scree',
    label: 'Scree',
    note: 'Loose rock fragments — underfoot changes the walk. Coverage is partial.',
  },
  {
    kind: 'shingle',
    label: 'Shingle',
    note: 'Loose rounded stones. Coverage is partial.',
  },
  {
    kind: 'rock',
    label: 'Rock outcrop / boulder field',
    note: 'Bare rock, outlined. OSM cannot tell an outcrop from a boulder field. Coverage is partial.',
  },
];

// --- Stipple ------------------------------------------------------------------------------

export interface StippleSpec {
  /** Tile edge in CSS px. The image is rendered at PIXEL_RATIO times this. */
  size: number;
  /** Dots per edge: the tile is a `cells` x `cells` grid with one jittered dot in each. */
  cells: number;
  minRadius: number;
  maxRadius: number;
  alpha: number;
  seed: number;
}

const PIXEL_RATIO = 2;

/** Scree: coarse and fairly dense, the OS "scatter of dots". */
export const SCREE_STIPPLE: StippleSpec = {
  size: 32,
  cells: 6,
  minRadius: 0.7,
  maxRadius: 1.3,
  alpha: 0.9,
  seed: 7,
};

/** Shingle: the same idea, finer and lighter, so it reads as smaller stones. */
export const SHINGLE_STIPPLE: StippleSpec = {
  size: 24,
  cells: 6,
  minRadius: 0.45,
  maxRadius: 0.75,
  alpha: 0.75,
  seed: 19,
};

/** Small deterministic PRNG, so the pattern is identical on every launch and every test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHex(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new Error(`stipple colour must be #rrggbb, got ${color}`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * RGBA pixels for a seamlessly tiling dot pattern. Built by hand rather than on a canvas so
 * it needs no DOM and is the same bytes everywhere.
 *
 * One dot per grid cell, jittered inside it: an even spread that still looks scattered — a
 * plain random scatter clumps and leaves holes, and a regular grid reads as a screen door.
 * Dots wrap at the tile edge, so neighbouring tiles join without a seam.
 */
export function stippleImage(spec: StippleSpec, color: string): ImageData | {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const [r, g, b] = parseHex(color);
  const px = spec.size * PIXEL_RATIO;
  const data = new Uint8ClampedArray(px * px * 4);
  const rand = mulberry32(spec.seed);
  const cell = px / spec.cells;

  for (let cy = 0; cy < spec.cells; cy++) {
    for (let cx = 0; cx < spec.cells; cx++) {
      const x = (cx + 0.2 + rand() * 0.6) * cell;
      const y = (cy + 0.2 + rand() * 0.6) * cell;
      const radius = (spec.minRadius + rand() * (spec.maxRadius - spec.minRadius)) * PIXEL_RATIO;
      const reach = Math.ceil(radius + 1);

      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const ix = Math.floor(x) + dx;
          const iy = Math.floor(y) + dy;
          const distance = Math.hypot(ix + 0.5 - x, iy + 0.5 - y);
          const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
          if (coverage === 0) continue;

          const wx = ((ix % px) + px) % px;
          const wy = ((iy % px) + px) % px;
          const at = (wy * px + wx) * 4;
          const alpha = Math.round(coverage * spec.alpha * 255);
          if (alpha > data[at + 3]) {
            data[at] = r;
            data[at + 1] = g;
            data[at + 2] = b;
            data[at + 3] = alpha;
          }
        }
      }
    }
  }
  return { width: px, height: px, data };
}

/**
 * Register a stipple with the map under a name that carries its colour, so a day and a
 * night pattern never collide. A theme change replaces the whole style — and with it every
 * image — and installAppLayers re-adds the regions, so this simply runs again.
 */
function ensureStipple(map: MLMap, name: string, spec: StippleSpec, color: string): string {
  const id = `${name}-${color.slice(1)}`;
  if (!map.hasImage(id)) {
    map.addImage(id, stippleImage(spec, color) as never, { pixelRatio: PIXEL_RATIO });
  }
  return id;
}

// --- Layers -------------------------------------------------------------------------------

function kindFilter(...kinds: TerrainFeatureKind[]): never {
  return ['in', ['get', 'kind'], ['literal', kinds]] as never;
}

/**
 * Draw the artifact: stippled scree and shingle, outlined rock. Areas only — the
 * `circle`/point cases are deliberately not drawn (see the header). A `fill` or `line`
 * layer does not render Point geometry, so the artifact's boulder nodes are ignored
 * without a filter.
 */
export function addTerrainFeatureLayers(
  map: MLMap,
  sourceId: string,
  { minzoom, before, ink }: { minzoom: number; before?: string; ink: MapInk },
): void {
  // Same fade-in shape as landuse_park (src/map/landuse.ts): the layer sits in the same
  // visual family as the basemap's own landuse fills, not a separate overlay.
  const fadeIn = ['interpolate', ['linear'], ['zoom'], minzoom, 0, minzoom + 2, 1] as never;
  const base = { source: sourceId, 'source-layer': TERRAIN_FEATURES_SOURCE_LAYER, minzoom };

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-scree`,
      type: 'fill',
      filter: kindFilter('scree'),
      paint: {
        'fill-pattern': ensureStipple(map, 'ratmap-scree', SCREE_STIPPLE, ink.terrainDot),
        'fill-opacity': fadeIn,
      },
    },
    before,
  );

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-shingle`,
      type: 'fill',
      filter: kindFilter('shingle'),
      paint: {
        'fill-pattern': ensureStipple(map, 'ratmap-shingle', SHINGLE_STIPPLE, ink.terrainDot),
        'fill-opacity': fadeIn,
      },
    },
    before,
  );

  // Outcrops: a faint wash so the shape reads at a glance, and an outline that carries it.
  map.addLayer(
    {
      ...base,
      id: `${sourceId}-rock`,
      type: 'fill',
      filter: kindFilter('rock', 'stone'),
      paint: {
        'fill-color': ink.terrainRock,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], minzoom, 0, minzoom + 2, 0.18] as never,
      },
    },
    before,
  );

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-rock-outline`,
      type: 'line',
      filter: kindFilter('rock', 'stone'),
      paint: {
        'line-color': ink.terrainRock,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 17, 1.2] as never,
        'line-opacity': fadeIn,
      },
    },
    before,
  );
}

// --- Legend swatches ------------------------------------------------------------------------

/** Fixed dot positions for the 40x24 swatch — the legend only needs to look like the map. */
const SWATCH_DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [7, 6, 1.4], [16, 5, 1.1], [26, 7, 1.5], [34, 5, 1.1],
  [11, 12, 1.2], [21, 11, 1.5], [30, 13, 1.2], [5, 17, 1.1],
  [15, 18, 1.4], [25, 18, 1.1], [34, 19, 1.4],
];

export function terrainSwatch(kind: 'scree' | 'shingle' | 'rock', ink: MapInk): string {
  if (kind === 'rock') {
    return (
      `<svg viewBox="0 0 40 24"><path d="M5,17 L9,7 L18,4 L27,6 L35,12 L32,20 L20,21 L9,20 Z" ` +
      `fill="${ink.terrainRock}" fill-opacity="0.18" stroke="${ink.terrainRock}" stroke-width="1.2" stroke-linejoin="round"/></svg>`
    );
  }
  const scale = kind === 'scree' ? 1 : 0.65;
  const dots = SWATCH_DOTS.map(
    ([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${(r * scale).toFixed(2)}"/>`,
  ).join('');
  return `<svg viewBox="0 0 40 24"><g fill="${ink.terrainDot}" fill-opacity="0.85">${dots}</g></svg>`;
}
