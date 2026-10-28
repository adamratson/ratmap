import type { Map as MLMap, SymbolLayerSpecification } from 'maplibre-gl';
import { MAP_FONTS, type MapInk } from '../map/flavor';
import { ensureShapeImage, shapeSwatch, type Shape } from './icon-shapes';

// Landmarks: transmitter masts and towers, trig pillars, cairns, lighthouses and wind
// turbines — the things a walker takes a bearing on, like the masts and radar on Great Dun
// Fell. Protomaps' POI layer keeps no `man_made` or `power` tag, so none of them are in the
// basemap (checked by decoding the Protomaps v4 z15 tiles over Great Dun Fell,
// 2026-10-22). They ride on their own artifact, `<region>-landmarks-1.pmtiles`, built by
// infra/scripts/build-landmarks.sh and cut per region like terrain-features (C16).
//
// What reaches the tiles is already curated there (tools/cmd/normalize-landmarks):
// floodlight masts and benchmark bolts are dropped, areas are reduced to one point, and a
// survey point that is also the summit node is left to the peaks layer, which already
// draws it with its name and height.
//
// **Coverage is partial, the same shape as SAC's.** A hilltop with no trig drawn may
// simply have one nobody has mapped.

export const LANDMARKS_SOURCE_LAYER = 'landmarks';

export type LandmarkKind = 'mast' | 'tower' | 'survey_point' | 'cairn' | 'lighthouse' | 'wind_turbine';

/** The symbols. Masts and towers share one: on the hill they serve the same purpose. */
export type LandmarkIcon = 'mast' | 'trig' | 'cairn' | 'lighthouse' | 'turbine';

export interface LandmarkKindInfo {
  icon: LandmarkIcon;
  label: string;
  note: string;
}

export const LANDMARK_KINDS: readonly LandmarkKindInfo[] = [
  {
    icon: 'mast',
    label: 'Mast or tower',
    note: 'Transmitters, radar and lookout towers.',
  },
  {
    icon: 'trig',
    label: 'Trig point',
    note: 'Survey pillars and beacons. On a summit, shown as the summit.',
  },
  {
    icon: 'cairn',
    label: 'Cairn',
    note: 'Pile of stones marking a top, a path or a junction.',
  },
  {
    icon: 'turbine',
    label: 'Wind turbine',
    note: 'Each turbine of a wind farm.',
  },
  {
    icon: 'lighthouse',
    label: 'Lighthouse',
    note: 'For the coast path.',
  },
];

/** Icon edge in CSS px, the car park sign's. */
const ICON_SIZE = 16;

// Laid out on a 32-unit grid (src/overlays/icon-shapes.ts).
export const LANDMARK_SHAPES: Record<LandmarkIcon, Shape> = {
  // A lattice mast: two legs splayed from the top, braced twice, with the aerial's ball.
  mast: {
    strokes: [
      [16, 7, 10, 29],
      [16, 7, 22, 29],
      [12.4, 20.2, 19.6, 20.2],
      [12.4, 20.2, 18.5, 15.8],
      [10.6, 27, 21.4, 27],
    ],
    discs: [[16, 5, 3]],
  },
  // The OS trig symbol: a triangle with a dot at its centre.
  trig: {
    strokes: [
      [16, 4.5, 4, 26.5],
      [4, 26.5, 28, 26.5],
      [28, 26.5, 16, 4.5],
    ],
    discs: [[16, 19, 3.2]],
    backing: [
      [16, 4.5],
      [4, 26.5],
      [28, 26.5],
    ],
  },
  // Flat stones stacked into a pyramid, the halo showing between the courses.
  cairn: {
    strokes: [
      [7.5, 26, 24.5, 26, 5],
      [10.5, 19.5, 21.5, 19.5, 5],
      [13.5, 13, 18.5, 13, 5],
    ],
    discs: [[16, 7, 2.6]],
  },
  // A tapering tower under its lantern, with the light's beams either side.
  lighthouse: {
    fills: [
      [
        [12, 28.5],
        [14, 12],
        [18, 12],
        [20, 28.5],
      ],
    ],
    strokes: [
      [10, 28.5, 22, 28.5],
      [5, 6, 10, 8],
      [27, 6, 22, 8],
    ],
    discs: [[16, 8, 3.4]],
  },
  // Three blades from the hub, on a slim tower.
  turbine: {
    strokes: [
      [16, 13, 16, 29.5],
      [16, 13, 16, 2.5, 2.4],
      [16, 13, 6.9, 18.25, 2.4],
      [16, 13, 25.1, 18.25, 2.4],
      [12, 29.5, 20, 29.5],
    ],
    discs: [[16, 13, 2.4]],
  },
};

function iconColors(ink: MapInk) {
  return { glyph: ink.landmark, rim: ink.landmarkRim };
}

/** The image id for a landmark symbol in the theme's ink, registering it on first use. */
export function ensureLandmarkIcon(map: MLMap, icon: LandmarkIcon, ink: MapInk): string {
  return ensureShapeImage(map, `ratmap-landmark-${icon}`, LANDMARK_SHAPES[icon], iconColors(ink), ICON_SIZE);
}

// --- Layer -------------------------------------------------------------------------------

/** From z13, the landmarks archive's own floor (build-landmarks.sh's -Z13). */
export const LANDMARKS_MIN_ZOOM = 13;

/**
 * From z14 every landmark icon draws, whatever it collides with.
 *
 * Below that, collision thins them, which is what keeps a town's rooftop masts from
 * piling up at z13. But collision also lost the landmarks that matter most: the summit's
 * own symbol and name are placed first, and the masts on Great Dun Fell, ~20 m from its
 * summit, were hidden by them from z13.5 to z14.5 and only partly shown above (measured
 * in the app, 2026-10-28). At walking zooms a landmark beside a summit is the point of the
 * layer. The icon then sits under the summit's name, which is drawn above it. Names still
 * collide, and give way.
 */
export const LANDMARKS_OVERLAP_ZOOM = 14;

export function landmarksLayerId(sourceId: string): string {
  return `${sourceId}-symbols`;
}

/** The layer from LANDMARKS_OVERLAP_ZOOM up. */
export function landmarksOverlapLayerId(sourceId: string): string {
  return `${sourceId}-symbols-overlap`;
}

/**
 * The landmark symbol layers: the icon from z13, its name beside it from z15. Two layers
 * because whether an icon may overlap is not something a zoom expression can change: one
 * below LANDMARKS_OVERLAP_ZOOM, where they collide, and one from it up, where they don't.
 * A region whose own floor is already at or above that zoom gets only the second — a
 * layer whose minzoom reaches its maxzoom is a style error.
 *
 * Placement order when symbols collide: trig points, then lighthouses, masts, towers and
 * wind turbines, then cairns — a trig is the rarest and the one a walker checks a position
 * against — and within each, named ones first.
 */
export function landmarksLayers(
  sourceId: string,
  { minzoom, icons, ink }: { minzoom: number; icons: Record<LandmarkIcon, string>; ink: MapInk },
): SymbolLayerSpecification[] {
  const base = landmarksLayer(sourceId, icons, ink);
  const floor = Math.max(LANDMARKS_MIN_ZOOM, minzoom);
  const layers: SymbolLayerSpecification[] = [];
  if (floor < LANDMARKS_OVERLAP_ZOOM) {
    layers.push({ ...base, minzoom: floor, maxzoom: LANDMARKS_OVERLAP_ZOOM });
  }
  layers.push({
    ...base,
    id: landmarksOverlapLayerId(sourceId),
    minzoom: Math.max(LANDMARKS_OVERLAP_ZOOM, floor),
    layout: { ...base.layout, 'icon-allow-overlap': true },
  });
  return layers;
}

function landmarksLayer(sourceId: string, icons: Record<LandmarkIcon, string>, ink: MapInk): SymbolLayerSpecification {
  return {
    id: landmarksLayerId(sourceId),
    type: 'symbol',
    source: sourceId,
    'source-layer': LANDMARKS_SOURCE_LAYER,
    layout: {
      'icon-image': [
        'match',
        ['get', 'kind'],
        'survey_point',
        icons.trig,
        'cairn',
        icons.cairn,
        'lighthouse',
        icons.lighthouse,
        'wind_turbine',
        icons.turbine,
        icons.mast,
      ],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 15, 1],
      'symbol-sort-key': [
        '+',
        ['match', ['get', 'kind'], 'survey_point', 0, 'lighthouse', 1, 'cairn', 3, 2],
        ['case', ['has', 'name'], 0, 4],
      ],
      'text-field': ['step', ['zoom'], '', 15, ['coalesce', ['get', 'name'], '']],
      'text-font': [MAP_FONTS.italic],
      'text-size': 10.5,
      'text-max-width': 8,
      'text-offset': [1, 0],
      'text-variable-anchor': ['left', 'right'],
      'text-justify': 'auto',
      // A symbol with no room for its name still shows; the name never shows without it.
      'text-optional': true,
    },
    paint: {
      'text-color': ink.landmarkText,
      'text-halo-color': ink.labelHalo,
      'text-halo-width': 1.4,
    },
  };
}

/** Register the symbols and add the layers, before `before`. */
export function addLandmarkLayers(
  map: MLMap,
  sourceId: string,
  { minzoom, before, ink }: { minzoom: number; before?: string; ink: MapInk },
): void {
  const icons = Object.fromEntries(
    (Object.keys(LANDMARK_SHAPES) as LandmarkIcon[]).map((icon) => [icon, ensureLandmarkIcon(map, icon, ink)]),
  ) as Record<LandmarkIcon, string>;
  for (const layer of landmarksLayers(sourceId, { minzoom, icons, ink })) map.addLayer(layer, before);
}

/** The symbol as a legend swatch, from the same shape the map image is drawn from. */
export function landmarkSwatch(icon: LandmarkIcon, ink: MapInk): string {
  return shapeSwatch(LANDMARK_SHAPES[icon], iconColors(ink));
}
