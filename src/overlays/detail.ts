import type { ExpressionSpecification, FilterSpecification, Map as MLMap } from 'maplibre-gl';
import type { MapInk } from '../map/flavor';
import { ensureShapeImage, shapeSwatch, type Shape } from './icon-shapes';

// Field detail: walls and fences, power lines and pylons, gates, stiles, cattle grids and
// fords. Walls, fences and power lines are the handrails a walker follows across open
// ground, and gates, stiles and fords are where a path gets through them. None of it is in
// the basemap — Protomaps' tiles carry no power, barrier or ford data at all (checked by
// decoding scotland-basemap z15 tiles over the Cairngorms, 2026-10-27) — so it rides on its
// own artifact, `<region>-detail-1.pmtiles`, built by infra/scripts/build-detail.sh and cut
// per region like landmarks (C16).
//
// Each kind arrives in the tiles from the zoom it is drawn at (normalize-detail's minZoom):
// power lines from z12, walls, fences, minor lines and fords from z14, pylons and the
// furniture on a path from z15. The layers below start at the same zooms.
//
// **Coverage is partial and very uneven.** Field boundaries are mapped field by field in
// some places and not at all in others; a moor with no wall drawn may well have one.

export const DETAIL_SOURCE_LAYER = 'detail';

export type DetailKind =
  | 'wall'
  | 'fence'
  | 'power_line'
  | 'minor_power_line'
  | 'pylon'
  | 'gate'
  | 'stile'
  | 'cattle_grid'
  | 'ford';

/** The symbols, at 12 CSS px: small, because they sit on a path rather than beside it. */
export type DetailIcon = 'gate' | 'stile' | 'cattle_grid' | 'ford';

const ICON_SIZE = 12;
const FORD_ICON_SIZE = 14;

// Laid out on a 32-unit grid (src/overlays/icon-shapes.ts), in strokes heavy enough to
// survive being drawn at 12 px.
export const DETAIL_SHAPES: Record<DetailIcon, Shape> = {
  // A field gate: two posts, two rails and the diagonal brace.
  gate: {
    strokes: [
      [6, 7, 6, 26, 3.4],
      [26, 7, 26, 26, 3.4],
      [6, 11, 26, 11, 3.4],
      [6, 22, 26, 22, 3.4],
      [6, 22, 26, 11, 3],
    ],
  },
  // A ladder stile: two uprights and the steps between them.
  stile: {
    strokes: [
      [10, 4, 10, 28, 3.4],
      [22, 4, 22, 28, 3.4],
      [10, 12, 22, 12, 3.4],
      [10, 20, 22, 20, 3.4],
    ],
  },
  // The grid itself: a frame with the bars across it.
  cattle_grid: {
    strokes: [
      [5, 9, 27, 9, 3],
      [5, 23, 27, 23, 3],
      [9, 9, 9, 23, 3],
      [16, 9, 16, 23, 3],
      [23, 9, 23, 23, 3],
    ],
  },
  // Water across the path: two wavy lines.
  ford: {
    strokes: [
      [4, 12, 10, 8, 3.2],
      [10, 8, 16, 12, 3.2],
      [16, 12, 22, 8, 3.2],
      [22, 8, 28, 12, 3.2],
      [4, 22, 10, 18, 3.2],
      [10, 18, 16, 22, 3.2],
      [16, 22, 22, 18, 3.2],
      [22, 18, 28, 22, 3.2],
    ],
  },
};

function iconColors(icon: DetailIcon, ink: MapInk) {
  return { glyph: icon === 'ford' ? ink.ford : ink.landmark, rim: ink.landmarkRim };
}

function ensureDetailIcon(map: MLMap, icon: DetailIcon, ink: MapInk): string {
  return ensureShapeImage(
    map,
    `ratmap-detail-${icon}`,
    DETAIL_SHAPES[icon],
    iconColors(icon, ink),
    icon === 'ford' ? FORD_ICON_SIZE : ICON_SIZE,
  );
}

// --- Layers -------------------------------------------------------------------------------

function kindFilter(...kinds: DetailKind[]): FilterSpecification {
  return ['in', ['get', 'kind'], ['literal', kinds]] as FilterSpecification;
}

function byZoom(stops: Array<[number, number | ExpressionSpecification]>): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flat()] as ExpressionSpecification;
}

/**
 * Draw the artifact: the field boundaries and power lines (with their pylons) as lines,
 * before `beforeLines` — under the paths, like the rest of the region's ground detail —
 * and the gates, stiles, cattle grids and fords as symbols, before `beforeSymbols` — over
 * the paths they sit on.
 *
 * Walls solid, fences dashed, both in a quiet grey a step off the contours' brown: on a
 * sheet already carrying contours, paths and grade bands, the boundaries have to be there
 * when looked for and recede otherwise. Power lines take a darker, cooler ink and a
 * heavier line, with a dot at each pylon from z15, the way a paper map draws them.
 */
export function addDetailLayers(
  map: MLMap,
  sourceId: string,
  {
    minzoom,
    beforeLines,
    beforeSymbols,
    ink,
  }: { minzoom: number; beforeLines?: string; beforeSymbols?: string; ink: MapInk },
): void {
  const base = { source: sourceId, 'source-layer': DETAIL_SOURCE_LAYER };
  const from = (zoom: number) => Math.max(zoom, minzoom);

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-fences`,
      type: 'line',
      minzoom: from(14),
      filter: kindFilter('fence'),
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ink.boundary,
        'line-width': byZoom([
          [14, 0.6],
          [17, 1.2],
        ]),
        'line-dasharray': [3, 2],
      },
    },
    beforeLines,
  );

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-walls`,
      type: 'line',
      minzoom: from(14),
      filter: kindFilter('wall'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ink.boundary,
        'line-width': byZoom([
          [14, 0.8],
          [17, 1.6],
        ]),
      },
    },
    beforeLines,
  );

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-power-lines`,
      type: 'line',
      minzoom: from(12),
      filter: kindFilter('power_line', 'minor_power_line'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ink.power,
        'line-width': byZoom([
          [12, ['case', ['==', ['get', 'kind'], 'power_line'], 0.8, 0.5]],
          [16, ['case', ['==', ['get', 'kind'], 'power_line'], 1.6, 0.9]],
        ]),
        // Minor lines on wooden poles are everywhere in farmland: drawn, but lighter.
        'line-opacity': ['case', ['==', ['get', 'kind'], 'power_line'], 0.9, 0.6],
      },
    },
    beforeLines,
  );

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-pylons`,
      type: 'circle',
      minzoom: from(15),
      filter: kindFilter('pylon'),
      paint: {
        'circle-color': ink.power,
        'circle-radius': byZoom([
          [15, 1.8],
          [17, 3],
        ]),
        'circle-stroke-color': ink.landmarkRim,
        'circle-stroke-width': 0.8,
      },
    },
    beforeLines,
  );

  const icons = {
    gate: ensureDetailIcon(map, 'gate', ink),
    stile: ensureDetailIcon(map, 'stile', ink),
    cattle_grid: ensureDetailIcon(map, 'cattle_grid', ink),
    ford: ensureDetailIcon(map, 'ford', ink),
  };

  // Gates, stiles and cattle grids always show, and never push a label aside: they are
  // small, they sit on the path, and one hidden by a neighbouring name is a gate the walker
  // goes looking for and does not find on the map.
  map.addLayer(
    {
      ...base,
      id: `${sourceId}-gates`,
      type: 'symbol',
      minzoom: from(15),
      filter: kindFilter('gate', 'stile', 'cattle_grid'),
      layout: {
        'icon-image': ['match', ['get', 'kind'], 'stile', icons.stile, 'cattle_grid', icons.cattle_grid, icons.gate],
        'icon-size': byZoom([
          [15, 0.85],
          [17, 1.1],
        ]),
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    beforeSymbols,
  );

  map.addLayer(
    {
      ...base,
      id: `${sourceId}-fords`,
      type: 'symbol',
      minzoom: from(14),
      filter: kindFilter('ford'),
      layout: {
        'icon-image': icons.ford,
        'icon-size': byZoom([
          [14, 0.8],
          [16, 1],
        ]),
        'icon-allow-overlap': true,
      },
    },
    beforeSymbols,
  );
}

// --- Legend --------------------------------------------------------------------------------

export interface DetailLegendEntry {
  swatch: (ink: MapInk) => string;
  label: string;
  note: string;
}

function lineSwatch(color: string, width: number, extra = ''): string {
  return `<svg viewBox="0 0 40 24"><line x1="3" y1="12" x2="37" y2="12" stroke="${color}" stroke-width="${width}"${extra}/></svg>`;
}

export function detailSwatch(icon: DetailIcon, ink: MapInk): string {
  return shapeSwatch(DETAIL_SHAPES[icon], iconColors(icon, ink));
}

export function wallSwatch(ink: MapInk): string {
  return lineSwatch(ink.boundary, 1.6, ' stroke-linecap="round"');
}

export function powerSwatch(ink: MapInk): string {
  return (
    `<svg viewBox="0 0 40 24"><line x1="3" y1="12" x2="37" y2="12" stroke="${ink.power}" stroke-width="1.6"/>` +
    [8, 20, 32]
      .map((x) => `<circle cx="${x}" cy="12" r="2.4" fill="${ink.power}" stroke="${ink.landmarkRim}" stroke-width="0.8"/>`)
      .join('') +
    '</svg>'
  );
}

export const DETAIL_LEGEND: readonly DetailLegendEntry[] = [
  { swatch: wallSwatch, label: 'Wall', note: 'Drystone and other walls, from zoom 14.' },
  {
    swatch: (ink) => lineSwatch(ink.boundary, 1.2, ' stroke-dasharray="3 2"'),
    label: 'Fence',
    note: 'From zoom 14.',
  },
  { swatch: (ink) => detailSwatch('gate', ink), label: 'Gate', note: 'Field and kissing gates, from zoom 15.' },
  { swatch: (ink) => detailSwatch('stile', ink), label: 'Stile', note: 'From zoom 15.' },
  { swatch: (ink) => detailSwatch('cattle_grid', ink), label: 'Cattle grid', note: 'From zoom 15.' },
  { swatch: powerSwatch, label: 'Power line', note: 'Pylon lines from zoom 12, each pylon from 15.' },
  {
    swatch: (ink) => lineSwatch(ink.power, 1, ' stroke-opacity="0.6"'),
    label: 'Minor power line',
    note: 'Lines on wooden poles, from zoom 14.',
  },
  {
    swatch: (ink) => detailSwatch('ford', ink),
    label: 'Ford',
    note: 'Path or track through water, stepping stones included — impassable in spate. From zoom 14.',
  },
];
