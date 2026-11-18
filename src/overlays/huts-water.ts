import type { ExpressionSpecification, Map as MLMap, SymbolLayerSpecification } from 'maplibre-gl';
import { MAP_FONTS, type MapInk } from '../map/flavor';
import { ensureShapeImage, shapeSwatch, type Shape } from './icon-shapes';

// Huts, bothies, shelters, campsites, drinking water and springs: where a walker can get
// out of the weather, sleep or fill a bottle. They ride on their own artifact,
// `<region>-huts-1.pmtiles`, built by infra/scripts/build-huts.sh and cut per region like
// landmarks (C16).
//
// They used to come from the region basemap's `pois`, where Protomaps keeps most of them
// and its style draws only drinking water. That was not enough. Measured against
// scotland-latest.osm.pbf and the scotland-basemap tiles (2026-11-18): it keeps no
// `shelter_type`, so 642 of Scotland's 1,282 shelters were bus shelters with nothing to tell
// them apart, and only named shelters could be drawn; bothies also tagged as shelters,
// Corrour among them, came out as shelters; drinkable taps were missing entirely; and below
// z15 it had almost none — 23 of 147 bothies in the z14 tiles, no springs at all.
//
// What reaches the tiles is already curated (infra/scripts/tools/cmd/normalize-huts): bus
// shelters, gazebos and the like are dropped, a bothy is a hut however else it is tagged,
// a tap is kept only when tagged drinkable, private ones are dropped, and areas are
// reduced to one point.
//
// **Coverage is partial, and a symbol is not a promise.** A bothy may be locked or closed
// for stalking, and a spring may be dry or unsafe to drink. The legend says so.

export const HUTS_SOURCE_LAYER = 'huts';

/** The artifact's `kind` values (normalize-huts), each with its own symbol. */
export type HutsWaterIcon = 'hut' | 'shelter' | 'campsite' | 'water' | 'spring';

/**
 * Protomaps' own `pois` kinds for the same things. The basemap's POI layer leaves these
 * out (src/map/landuse.ts): it drew drinking water itself, and would draw it twice.
 */
export const PROTOMAPS_HUTS_WATER_KINDS: readonly string[] = [
  'alpine_hut',
  'wilderness_hut',
  'shelter',
  'camp_site',
  'drinking_water',
  'water_point',
  'spring',
];

export interface HutsWaterLegendEntry {
  icon: HutsWaterIcon;
  label: string;
  note: string;
}

export const HUTS_WATER_LEGEND: readonly HutsWaterLegendEntry[] = [
  {
    icon: 'hut',
    label: 'Hut or bothy',
    note: 'Mountain huts and bothies. Some are locked or seasonal.',
  },
  {
    icon: 'shelter',
    label: 'Shelter',
    note: 'Weather shelters, lean-tos and picnic shelters. Not bus shelters.',
  },
  {
    icon: 'campsite',
    label: 'Campsite',
    note: 'Campsites and camping areas.',
  },
  {
    icon: 'water',
    label: 'Drinking water',
    note: 'Taps, fountains and refill points marked as drinking water.',
  },
  {
    icon: 'spring',
    label: 'Spring',
    note: 'A natural source. Not necessarily safe to drink, and may be dry.',
  },
];

/** Icon edge in CSS px, the landmarks' and car parks'. */
const ICON_SIZE = 16;

// Laid out on a 32-unit grid (src/overlays/icon-shapes.ts).
export const HUTS_WATER_SHAPES: Record<HutsWaterIcon, Shape> = {
  // A solid house: walls and a pitched roof with eaves.
  hut: {
    fills: [
      [
        [16, 4.5],
        [28.5, 15],
        [25, 15],
        [25, 28],
        [7, 28],
        [7, 15],
        [3.5, 15],
      ],
    ],
  },
  // The same roof on two posts, open underneath: cover, not a building.
  shelter: {
    strokes: [
      [3.5, 15, 16, 5, 2.6],
      [16, 5, 28.5, 15, 2.6],
      [8, 13, 8, 28],
      [24, 13, 24, 28],
      [4, 28, 28, 28],
    ],
  },
  // A ridge tent, its door a filled triangle, the poles crossing at the apex.
  campsite: {
    strokes: [
      [16, 6, 4, 27],
      [16, 6, 28, 27],
      [4, 27, 28, 27],
      [16, 6, 12.5, 2],
      [16, 6, 19.5, 2],
    ],
    fills: [
      [
        [16, 15],
        [20.5, 27],
        [11.5, 27],
      ],
    ],
    backing: [
      [16, 6],
      [28, 27],
      [4, 27],
    ],
  },
  // A drop: a disc with the triangle to its tangents from the tip.
  water: {
    discs: [[16, 20, 7.5]],
    fills: [
      [
        [16, 3.5],
        [9.32, 16.6],
        [22.68, 16.6],
      ],
    ],
  },
  // A smaller drop rising out of the ground's line: water from the earth, not a tap.
  spring: {
    discs: [[16, 14.5, 5.5]],
    fills: [
      [
        [16, 3],
        [11.17, 11.87],
        [20.83, 11.87],
      ],
    ],
    strokes: [
      [4.5, 26, 10.25, 23],
      [10.25, 23, 16, 26],
      [16, 26, 21.75, 23],
      [21.75, 23, 27.5, 26],
    ],
  },
};

function iconColors(icon: HutsWaterIcon, ink: MapInk) {
  // Water in the water-label blue the ford symbol uses; the rest in the landmarks' ink.
  return { glyph: icon === 'water' || icon === 'spring' ? ink.ford : ink.landmark, rim: ink.landmarkRim };
}

/** The image id for a symbol in the theme's ink, registering it on first use. */
export function ensureHutsWaterIcon(map: MLMap, icon: HutsWaterIcon, ink: MapInk): string {
  return ensureShapeImage(map, `ratmap-huts-water-${icon}`, HUTS_WATER_SHAPES[icon], iconColors(icon, ink), ICON_SIZE);
}

// --- Layer -------------------------------------------------------------------------------

/** From z13, the huts archive's own floor (build-huts.sh's -Z13). */
export const HUTS_MIN_ZOOM = 13;

export function hutsWaterLayerId(sourceId: string): string {
  return `${sourceId}-symbols`;
}

const ICONS: readonly HutsWaterIcon[] = ['hut', 'shelter', 'campsite', 'water', 'spring'];

/**
 * The symbol layer: the icon from z13, its name from z15.
 *
 * Placement order when symbols collide: huts, then shelters, drinking water, springs and
 * campsites — a roof first, then water — and within each, named ones first.
 */
export function hutsWaterLayer(
  sourceId: string,
  { minzoom, icons, ink }: { minzoom: number; icons: Record<HutsWaterIcon, string>; ink: MapInk },
): SymbolLayerSpecification {
  const iconMatch: unknown[] = ['match', ['get', 'kind']];
  for (const icon of ICONS.slice(1)) iconMatch.push(icon, icons[icon]);
  iconMatch.push(icons.hut);
  return {
    id: hutsWaterLayerId(sourceId),
    type: 'symbol',
    source: sourceId,
    'source-layer': HUTS_SOURCE_LAYER,
    minzoom: Math.max(HUTS_MIN_ZOOM, minzoom),
    layout: {
      'icon-image': iconMatch as ExpressionSpecification,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 15, 1],
      'symbol-sort-key': [
        '+',
        ['match', ['get', 'kind'], 'hut', 0, 'shelter', 1, 'water', 2, 'spring', 3, 4],
        ['case', ['has', 'name'], 0, 5],
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

/** Register the symbols and add the layer, before `before`. */
export function addHutsWaterLayer(
  map: MLMap,
  sourceId: string,
  { minzoom, before, ink }: { minzoom: number; before?: string; ink: MapInk },
): void {
  const icons = Object.fromEntries(
    ICONS.map((icon) => [icon, ensureHutsWaterIcon(map, icon, ink)]),
  ) as Record<HutsWaterIcon, string>;
  map.addLayer(hutsWaterLayer(sourceId, { minzoom, icons, ink }), before);
}

/** The symbol as a legend swatch, from the same shape the map image is drawn from. */
export function hutsWaterSwatch(icon: HutsWaterIcon, ink: MapInk): string {
  return shapeSwatch(HUTS_WATER_SHAPES[icon], iconColors(icon, ink));
}
