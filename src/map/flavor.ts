// ratmap's own basemap palette (plans/signature-style.md §6.1), as Protomaps flavours.
//
// Built by spreading Protomaps' own LIGHT / DARK and overriding only the colours that
// carry the look. The rest (tunnels, bridges, POI kinds, school/hospital fills) come from
// upstream unchanged. A flavour is a plain object of colour strings, and `layers()`
// reads it at generation time, so this needs no fork of the style. The price is that a
// basemaps upgrade can add keys we have not tuned. They fall back to upstream's colour,
// which is a visual, not a correctness, risk (C13 pins the tile schema; this is paint).
//
// Day: a quiet, desaturated topo, warm-neutral to sit under the bone chrome. The stock
// cyan water and saturated park greens were the loudest things on screen, and they are
// what made it read as a city map. Here the roads, footpaths and water carry the page,
// in the order a paper hill map prints them, and the orange-brown contours sit beneath as
// the ground they cross (see landuse.ts's OVER_GROUND_FROM_LAYER_ID).
//
// Night: graphite land and deep slate water, matching the chrome's --surface-sunken.
// Landcover is only just off the land colour, so hillshade, the magenta route and the
// orange position dot are the brightest things on the screen.
//
// Every value is a literal hex/rgba. MapLibre paint properties cannot read CSS variables,
// so these are kept in step with style.css by hand, like the SAC ramp.

import { DARK, LIGHT, type Flavor } from '@protomaps/basemaps';
import type { Theme } from '../ui/theme';

/**
 * The map's label fontstacks: Barlow, with Noto Sans baked in as the fallback for every
 * codepoint Barlow lacks (Greek, Cyrillic, symbols). Built by scripts/build-map-glyphs.sh
 * into public/fonts/<name>/; see its header for why the fallback is baked rather than
 * listed. Every `text-font` in the app uses one of these, so the chrome's type and the
 * map's type are one family.
 *
 * Medium does the job Noto Sans Medium did (peaks, low-zoom cities). There is no bold:
 * Protomaps' `bold` slot is only ever a medium weight.
 */
export const MAP_FONTS = {
  regular: 'Barlow Noto Regular',
  medium: 'Barlow Noto Medium',
  italic: 'Barlow Noto Italic',
} as const;

const FONT_SLOTS = {
  regular: MAP_FONTS.regular,
  bold: MAP_FONTS.medium,
  italic: MAP_FONTS.italic,
};

const DAY: Flavor = {
  ...LIGHT,
  ...FONT_SLOTS,
  background: '#d9d6cf',
  earth: '#ebe9e3',
  water: '#a9c3cc',
  // Water names: 4.7:1 on the water-coloured halo they sit in. #5f7f8c was 2.3:1 — a
  // loch's name greyed out on the loch.
  ocean_label: '#2a5060',

  park_a: '#dde3da',
  park_b: '#c4d3c3',
  wood_a: '#d8e0d4',
  wood_b: '#b9cbb5',
  scrub_a: '#dde2d7',
  scrub_b: '#c9d4c1',
  glacier: '#f4f6f7',
  sand: '#e6e1d4',
  beach: '#e9e3d0',
  pedestrian: '#e6e3dc',
  buildings: '#d2cec6',

  boundaries: '#a8a39a',
  // Drawn at 0.85 (landuse.ts), not upstream's 0.5: 3.4:1, where the pale dashes were 1.5.
  railway: '#6e685f',

  // Roads: pale fills inside dark edges, as on a paper map, where the edge is what makes a
  // road read on busy ground. The edges used to be 2.2–2.6:1 against the earth, fainter
  // than any 10 m contour (2.8:1), so the contours outdrew the roads. Now minor 4.6:1,
  // main roads 6.0:1 and motorways 7.2:1 (4.8 and 5.9:1 over woodland). Fills grade by class: motorway terracotta,
  // then trunk/primary and secondary (ROAD_CLASS_FILL), tertiary pale yellow, the rest
  // white.
  other: '#f7f5f0',
  minor_service: '#f7f5f0',
  minor_a: '#fbfaf7',
  minor_b: '#fbfaf7',
  minor_casing: '#6e685e',
  link: '#f3c47e',
  major: '#f6e2a8',
  major_casing_early: '#5c564d',
  major_casing_late: '#5c564d',
  highway: '#dc8e6c',
  highway_casing_early: '#4f4a43',
  highway_casing_late: '#4f4a43',

  city_label: '#3a3f45',
  city_label_halo: '#ebe9e3',
  // Villages and hamlets: 6.6:1 on their halo, 4.7:1 over woodland. #6b7076 was 4.1 and
  // 2.9 — and in the hills, a hamlet is often the name that says where the walk starts.
  subplace_label: '#4c5157',
  subplace_label_halo: '#ebe9e3',
  state_label: '#9a968e',
  state_label_halo: '#ebe9e3',
  country_label: '#8a867e',
  roads_label_minor: '#6a655c', // 5.8:1 on its white halo; 4.4 before
  roads_label_major: '#6b665e',
  address_label: '#6a655c',
  // Point-of-interest labels, upstream's hues a step darker: each 4.5:1 or more on the
  // ground-coloured halo. Shops, cafés, attractions and parks were 2.6–3.9.
  pois: {
    ...(LIGHT.pois as NonNullable<Flavor['pois']>),
    blue: '#0f6a91',
    green: '#1d7444',
    pink: '#b52a85',
    red: '#bd2a4c',
    tangerine: '#a35303',
    turquoise: '#007480',
  },

  landcover: {
    grassland: 'rgba(221, 229, 214, 1)',
    // Bare rock and scree are the ground a hill map is about, so they stay distinct
    // from grass: stone, not the stock cream (which read as sand).
    barren: 'rgba(228, 222, 210, 1)',
    urban_area: 'rgba(225, 223, 218, 1)',
    farmland: 'rgba(226, 231, 216, 1)',
    glacier: 'rgba(246, 248, 249, 1)',
    scrub: 'rgba(224, 229, 211, 1)',
    forest: 'rgba(200, 215, 198, 1)',
  },
};

const NIGHT: Flavor = {
  ...DARK,
  ...FONT_SLOTS,
  background: '#0e1114',
  earth: '#161a1f',
  // Lifted and blue, not sunk: #0f1a22 was the first try, and at night the lochs
  // disappeared into the land. Water is a landmark, so it must read.
  water: '#1d3040',
  ocean_label: '#8fb8cd', // 6.4:1 on the water halo; 2.8 before

  park_a: '#18201c',
  park_b: '#1a241f',
  wood_a: '#18201c',
  wood_b: '#1b2520',
  scrub_a: '#1a1f1c',
  scrub_b: '#1c221e',
  // Glacier is lifted rather than sunk: ice is the one landcover a walker needs to see
  // at night.
  glacier: '#262c33',
  sand: '#1f1f1c',
  beach: '#22221f',
  pedestrian: '#1b1f24',
  buildings: '#0e1114',

  // Roads by night: the fill carries them, so it is lifted clear of graphite and of the
  // index contours (3.5:1) — minor 4.1:1, main roads 4.3–4.6:1 — and the edge goes to the
  // background colour, a dark channel that keeps the fill off whatever is under it.
  other: '#3a424c',
  minor_service: '#555d67',
  minor_a: '#737b86',
  minor_b: '#737b86',
  minor_casing: '#0e1114',
  link: '#958056',
  major: '#857e5e',
  major_casing_early: '#0e1114',
  major_casing_late: '#0e1114',
  highway: '#b0705a',
  highway_casing_early: '#0e1114',
  highway_casing_late: '#0e1114',
  // The background colour, before: railways were not drawn at night at all (1.1:1).
  // 3.8:1 at the 0.85 landuse.ts draws them at.
  railway: '#7d858f',
  boundaries: '#4a525c',

  city_label: '#9aa3ad',
  city_label_halo: '#0e1114',
  subplace_label: '#868f99', // 5.8:1; 4.2 before
  subplace_label_halo: '#0e1114',
  state_label: '#4a525c',
  state_label_halo: '#0e1114',
  country_label: '#5c646e',
  // 5.2 and 6.4:1, under the towns' 6.8; they were 2.9 and 3.9.
  roads_label_minor: '#848d97',
  roads_label_minor_halo: '#161a1f',
  roads_label_major: '#959ea8',
  roads_label_major_halo: '#161a1f',
  address_label: '#848d97',
  address_label_halo: '#161a1f',
  // Transport labels were 3.2:1 in upstream's dark blue; the rest hold.
  pois: { ...(DARK.pois as NonNullable<Flavor['pois']>), lapis: '#6f8ff2' },

  landcover: {
    grassland: 'rgba(25, 32, 28, 1)',
    barren: 'rgba(34, 36, 38, 1)',
    urban_area: 'rgba(26, 30, 35, 1)',
    farmland: 'rgba(26, 31, 28, 1)',
    glacier: 'rgba(40, 46, 53, 1)',
    scrub: 'rgba(28, 33, 29, 1)',
    forest: 'rgba(24, 33, 29, 1)',
  },
};

/**
 * Streams and rivers. Upstream draws them 0.5 px wide in the lakes' fill colour: 1.5:1 on
 * open ground by day, 1.1 over woodland, 1.3 at night — a river's name floating over no
 * river. A blue of their own instead, darker by day and lighter at night: 3.6:1 by day
 * (2.9 over woodland), 4.8 at night. See landuse.ts for the width.
 */
export const STREAM_INK: Record<Theme, string> = {
  light: '#3f7fa3',
  dark: '#4f8db3',
};

/**
 * Fills for main roads above tertiary, by class — see landuse.ts's majorFill. Tertiary and
 * unclassified main roads take the flavour's `major`; motorways its `highway`.
 */
export const ROAD_CLASS_FILL: Record<Theme, { primary: string; secondary: string }> = {
  light: { primary: '#eba46c', secondary: '#f3c47e' },
  dark: { primary: '#a8794b', secondary: '#958056' },
};

/**
 * The edge drawn round every building (src/map/landuse.ts). Protomaps fills buildings at
 * half opacity in a colour a step off the ground, which by day reads as a faint smudge and
 * at night does not read at all. An outline gives each footprint a shape: a step darker
 * than the day casing ink, and by night a lift off graphite — kept below the road fills so
 * a row of houses never reads as a street.
 */
export const BUILDING_OUTLINE: Record<Theme, string> = {
  light: '#a49e93',
  dark: '#2f363e',
};

export function ratmapFlavor(theme: Theme): Flavor {
  return theme === 'dark' ? NIGHT : DAY;
}

/**
 * Inks for the layers the app draws over the basemap: peaks, routes, and a downloaded
 * region's paths, contours and grade labels.
 *
 * These were written for a light map (white halos and casings, brown and near-black
 * ink), and on the day theme they are unchanged. They could stay that way only while a
 * region was wrongly drawn in the light flavour even at night. Once regions follow the
 * theme, a #8a3d2e footpath on graphite is 2.3:1 and a white casing glares, so night
 * gets its own set: casings and halos turn to graphite, and the browns lift in lightness
 * while keeping their hue, the same rule the SAC ramp follows in style.css.
 */
export interface MapInk {
  /** Halo behind any map text the app draws (peak, contour and grade labels). */
  labelHalo: string;
  /**
   * Footpaths dashed and tracks solid, in this one ink. A track is the thinner of the two:
   * solid and 3.5 px wide it was the boldest line on the map, heavier than the main road it
   * left, and as a lane between two edges in this ink it read as a pair of contours.
   */
  pathLine: string;
  /** Under a path from z14 (see PATH_CASING_FROM in src/regions/region-layers.ts). */
  pathCasing: string;
  /**
   * Contours. Two inks, not one width: the 10 m lines are read by counting and must stay
   * recessive; the 50 m index lines are what the relief is read from, a step firmer.
   * Contrast over earth / forest / bare rock is noted beside each value.
   *
   * Orange-brown, as a paper map prints them, and kept below the roads' edges. They were
   * a dark red-brown at 6.6:1 for the index lines (2026-09-25 to 2026-11-21): as strong as
   * a footpath and nearly its colour, and stronger than any road on the map.
   */
  contour: string;
  contourIndex: string;
  contourLabel: string;
  peakText: string;
  peakMunroText: string;
  peakDot: string;
  peakMunroDot: string;
  peakDotStroke: string;
  /**
   * The planned route. Magenta, the GPS "course line" colour: orange is already SAC T4
   * and avalanche 30°, and the chrome's accent must not read as map data.
   */
  routeLine: string;
  routeStraight: string;
  routeCasing: string;
  offRoute: string;
  /**
   * Ground-surface texture (scree, shingle, rock outcrops): the stipple dots and the outcrop
   * outline. Ink on a light ground, chalk on a dark one — dark dots would vanish at night.
   */
  terrainDot: string;
  terrainRock: string;
  /**
   * Hillshade. By day these are MapLibre's own defaults. At night a pure-white highlight
   * turns every sunlit slope into a pale blob on the graphite ground, brighter than the
   * route. So the highlight drops to a translucent grey: relief still reads, and it
   * stays under the marks that matter.
   */
  hillshadeHighlight: string;
  hillshadeShadow: string;
  /**
   * Car parks (src/map/parking.ts): the road-sign white P on blue, so it reads as parking
   * before it reads as anything else. The rim is the halo colour, as the summit dot's is.
   */
  parkingFill: string;
  parkingGlyph: string;
  parkingRim: string;
  parkingText: string;
  /**
   * Landmarks (src/overlays/landmarks.ts): masts, trig points and cairns, in one dark ink
   * haloed in the ground colour like the parking sign — black on a paper map, chalk at
   * night. Their names take a quieter ink than summit names, which they sit beside.
   */
  landmark: string;
  landmarkRim: string;
  landmarkText: string;
  /**
   * Field detail (src/overlays/detail.ts). Walls and fences in a quiet grey a step off the
   * contours' brown, so they read as a different thing without competing; power lines
   * darker and cooler; the ford symbol in the water-label blue.
   */
  boundary: string;
  power: string;
  ford: string;
  /**
   * Named walking routes (src/overlays/routes.ts).
   *
   * Lilac: blue-leaning, so neither the saturated magenta of the planned route nor the SAC
   * ramp's T6 purple, which is a band, not a corridor. The tints, national and regional
   * then local, are the opaque corridor round the path from z12 — pale by day, deep at
   * night, the local one a step nearer the ground. Below z12 a route is drawn in the paths'
   * own ink. `walkRouteText` names them.
   *
   * They were all teal, which sits beside water's blue: a pale band winding down a valley
   * was a river (day tint #b0ddd9 against water #a9c3cc; at night #1b4846 against #1d3040).
   */
  walkRouteTint: readonly [string, string];
  walkRouteText: string;
}

const DAY_INK: MapInk = {
  labelHalo: 'rgba(255,255,255,0.9)',
  pathLine: '#8a3d2e',
  pathCasing: 'rgba(255,255,255,0.85)',
  contour: 'rgba(176, 104, 44, 0.42)', // 1.6 / 1.5 / 1.6:1
  contourIndex: 'rgba(168, 96, 36, 0.8)', // 2.9 / 2.5 / 2.7:1
  contourLabel: '#94561f',
  peakText: '#14171a',
  peakMunroText: '#8a5d00',
  peakDot: '#14171a',
  // A step darker than night's: 3.2:1 on open ground, where #c9910a was 2.3.
  peakMunroDot: '#a97a08',
  peakDotStroke: '#ffffff',
  routeLine: '#d6127e',
  routeStraight: '#b45309',
  routeCasing: 'rgba(255,255,255,0.9)',
  offRoute: '#dc2626',
  terrainDot: '#5a5048',
  terrainRock: '#6b5d4f',
  hillshadeHighlight: '#ffffff',
  hillshadeShadow: '#000000',
  parkingFill: '#1f5ca8',
  parkingGlyph: '#ffffff',
  parkingRim: '#ffffff',
  parkingText: '#1d4a80',
  landmark: '#2b2724',
  landmarkRim: '#ffffff',
  landmarkText: '#4f4740',
  boundary: '#7d776e',
  power: '#454a52',
  ford: '#2f6b86',
  walkRouteTint: ['#cbb6e8', '#d8c8ee'],
  walkRouteText: '#62419a', // 7.7:1 on the halo
};

// Contrast against night earth (#161a1f): path 6.3:1, contour label 6.9:1, straight legs
// 8.1:1.
const NIGHT_INK: MapInk = {
  labelHalo: 'rgba(14,17,20,0.9)',
  pathLine: '#d08a6e',
  pathCasing: 'rgba(14,17,20,0.8)',
  contour: 'rgba(214, 170, 126, 0.3)', // 1.9 / 1.9 / 1.9:1
  contourIndex: 'rgba(222, 172, 122, 0.52)', // 3.2 / 3.2 / 3.1:1
  contourLabel: '#c89a70',
  peakText: '#e6e9ed',
  peakMunroText: '#e0b34d',
  peakDot: '#e6e9ed',
  peakMunroDot: '#c9910a',
  peakDotStroke: '#0e1114',
  routeLine: '#ff4fa8',
  routeStraight: '#f59e0b',
  routeCasing: 'rgba(14,17,20,0.9)',
  offRoute: '#f87171',
  terrainDot: '#c2b8a8',
  terrainRock: '#a89a86',
  hillshadeHighlight: 'rgba(154,163,173,0.45)',
  hillshadeShadow: '#000000',
  // Lifted a step so the sign holds against graphite; the rim goes dark, like the dots'.
  parkingFill: '#2f6fbf',
  parkingGlyph: '#ffffff',
  parkingRim: '#0e1114',
  parkingText: '#8db4e2',
  landmark: '#dfe3e8',
  landmarkRim: '#0e1114',
  landmarkText: '#aab2bb',
  boundary: '#7a8189',
  power: '#aeb5be',
  ford: '#7fb3c9',
  walkRouteTint: ['#46385f', '#3c3152'],
  walkRouteText: '#b9a0e8', // 8.4:1 on the halo
};

export function mapInk(theme: Theme): MapInk {
  return theme === 'dark' ? NIGHT_INK : DAY_INK;
}
