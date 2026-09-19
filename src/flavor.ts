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
// what made it read as a city map. Here the brown contours and footpaths carry the page.
//
// Night: graphite land and deep slate water, matching the chrome's --surface-sunken.
// Landcover is only just off the land colour, so hillshade, the magenta route and the
// orange position dot are the brightest things on the screen.
//
// Every value is a literal hex/rgba. MapLibre paint properties cannot read CSS variables,
// so these are kept in step with style.css by hand, like the SAC ramp.

import { DARK, LIGHT, type Flavor } from '@protomaps/basemaps';
import type { Theme } from './theme';

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
  ocean_label: '#5f7f8c',

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
  railway: '#a19c93',

  city_label: '#3a3f45',
  city_label_halo: '#ebe9e3',
  subplace_label: '#6b7076',
  subplace_label_halo: '#ebe9e3',
  state_label: '#9a968e',
  state_label_halo: '#ebe9e3',
  country_label: '#8a867e',
  roads_label_minor: '#7d7870',
  roads_label_major: '#6b665e',
  address_label: '#7d7870',

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
  ocean_label: '#5d7684',

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

  other: '#2a3038',
  minor_service: '#2a3038',
  minor_a: '#2e343c',
  minor_b: '#2a3038',
  minor_casing: '#161a1f',
  link: '#2e343c',
  major: '#353c45',
  major_casing_early: '#161a1f',
  major_casing_late: '#161a1f',
  highway: '#3a424c',
  highway_casing_early: '#161a1f',
  highway_casing_late: '#161a1f',
  railway: '#0e1114',
  boundaries: '#4a525c',

  city_label: '#9aa3ad',
  city_label_halo: '#0e1114',
  subplace_label: '#6f7883',
  subplace_label_halo: '#0e1114',
  state_label: '#4a525c',
  state_label_halo: '#0e1114',
  country_label: '#5c646e',
  roads_label_minor: '#5c646e',
  roads_label_minor_halo: '#161a1f',
  roads_label_major: '#6f7883',
  roads_label_major_halo: '#161a1f',
  address_label: '#5c646e',
  address_label_halo: '#161a1f',

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
  pathLine: string;
  pathCasing: string;
  contour: string;
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
   * Hillshade. By day these are MapLibre's own defaults. At night a pure-white highlight
   * turns every sunlit slope into a pale blob on the graphite ground, brighter than the
   * route. So the highlight drops to a translucent grey: relief still reads, and it
   * stays under the marks that matter.
   */
  hillshadeHighlight: string;
  hillshadeShadow: string;
}

const DAY_INK: MapInk = {
  labelHalo: 'rgba(255,255,255,0.9)',
  pathLine: '#8a3d2e',
  pathCasing: 'rgba(255,255,255,0.85)',
  contour: 'rgba(120, 85, 55, 0.55)',
  contourLabel: '#6b4a33',
  peakText: '#14171a',
  peakMunroText: '#8a5d00',
  peakDot: '#14171a',
  peakMunroDot: '#c9910a',
  peakDotStroke: 'rgba(255,255,255,0.95)',
  routeLine: '#d6127e',
  routeStraight: '#b45309',
  routeCasing: 'rgba(255,255,255,0.9)',
  offRoute: '#dc2626',
  hillshadeHighlight: '#ffffff',
  hillshadeShadow: '#000000',
};

// Contrast against night earth (#161a1f): path 6.3:1, contour label 6.5:1, route 5.8:1,
// straight legs 8.1:1.
const NIGHT_INK: MapInk = {
  labelHalo: 'rgba(14,17,20,0.9)',
  pathLine: '#d08a6e',
  pathCasing: 'rgba(14,17,20,0.8)',
  contour: 'rgba(196, 160, 122, 0.35)',
  contourLabel: '#b8977a',
  peakText: '#e6e9ed',
  peakMunroText: '#e0b34d',
  peakDot: '#e6e9ed',
  peakMunroDot: '#c9910a',
  peakDotStroke: 'rgba(14,17,20,0.95)',
  routeLine: '#ff4fa8',
  routeStraight: '#f59e0b',
  routeCasing: 'rgba(14,17,20,0.9)',
  offRoute: '#f87171',
  hillshadeHighlight: 'rgba(154,163,173,0.45)',
  hillshadeShadow: '#000000',
};

export function mapInk(theme: Theme): MapInk {
  return theme === 'dark' ? NIGHT_INK : DAY_INK;
}
