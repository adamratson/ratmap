import type { Map as MLMap, SymbolLayerSpecification } from 'maplibre-gl';
import { parseHex } from '../overlays/terrain-features';
import type { Theme } from '../ui/theme';
import { MAP_FONTS, mapInk, type MapInk } from './flavor';

// Car parks. On a hill map these are trailheads: where a walk starts is usually where the
// car is left. They ride in every basemap archive already — Protomaps puts OSM
// `amenity=parking` in the `pois` source-layer as `kind: "parking"` (checked by decoding
// scotland-basemap z12-15 tiles, 2026-10-15) — but upstream's `pois` layer has a hardcoded
// `kind` allowlist that omits it, and the vendored sprite has no parking icon. So the data
// was there and never drawn, same story as bare rock in landuse.ts.
//
// **No `min_zoom` gate.** Upstream's own POI layer hides a feature below its `min_zoom`,
// but for parking that hides the ones that matter: unnamed car parks — laybys and
// trailhead lots — carry `min_zoom: 17`, past the archives' z15 ceiling, so they would
// never show at all. The tiles already thin them by zoom (a few large named car parks at
// z13, more at z14, everything at z15), so this draws whatever a tile carries.

export const PARKING_LAYER_ID = 'pois_parking';

/** Icon edge in CSS px. The image is rendered at PIXEL_RATIO times this. */
const ICON_SIZE = 16;
const PIXEL_RATIO = 2;
/** Samples per pixel edge, for antialiasing without a canvas. */
const SUPERSAMPLE = 4;

/** Image id per theme: a theme swap replaces the style, and the two signs differ in ink. */
export function parkingIconId(theme: Theme): string {
  return `ratmap-parking-${theme}`;
}

/**
 * Which part of the sign a point (in image px, 0..px) falls in: outside it, the rim, the
 * letter, or the blue field. The letter is a stem plus a half-ring bowl joined by two bars,
 * so it needs no font — glyphs are SDF and MapLibre will not put text inside an icon box.
 */
function signPart(x: number, y: number, px: number): 'none' | 'rim' | 'glyph' | 'field' {
  const s = px / 32; // Geometry below is laid out on a 32-unit grid.
  const u = x / s;
  const v = y / s;

  // Rounded square, radius 6, with a 2-unit rim. `inside` is the distance to its edge
  // (the standard rounded-box distance, negated so positive is inside).
  const r = 6;
  const qx = Math.abs(u - 16) - (16 - r);
  const qy = Math.abs(v - 16) - (16 - r);
  const inside = r - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0);
  if (inside < 0) return 'none';
  if (inside < 2) return 'rim';

  // "P": stem x 10..14, y 7..25; bowl centred (16.5, 12.5), radii 1.5..5.5, right half
  // only, joined to the stem by bars at the top and bottom of the bowl.
  const stem = u >= 10 && u <= 14 && v >= 7 && v <= 25;
  const d = Math.hypot(u - 16.5, v - 12.5);
  const bowl = u >= 16.5 && d >= 1.5 && d <= 5.5;
  const bars = u >= 14 && u <= 16.5 && ((v >= 7 && v <= 11) || (v >= 14 && v <= 18));
  return stem || bowl || bars ? 'glyph' : 'field';
}

/**
 * RGBA pixels for the parking sign: the road-sign white "P" on a blue square, ringed in the
 * theme's halo so it holds over hillshade and woodland. Built by hand rather than on a
 * canvas so it needs no DOM and is the same bytes everywhere (see stippleImage).
 */
export function parkingImage(ink: MapInk): { width: number; height: number; data: Uint8ClampedArray } {
  const colors = {
    rim: parseHex(ink.parkingRim),
    glyph: parseHex(ink.parkingGlyph),
    field: parseHex(ink.parkingFill),
  };
  const px = ICON_SIZE * PIXEL_RATIO;
  const data = new Uint8ClampedArray(px * px * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const part = signPart(x + (sx + 0.5) / SUPERSAMPLE, y + (sy + 0.5) / SUPERSAMPLE, px);
          if (part === 'none') continue;
          const [cr, cg, cb] = colors[part];
          r += cr;
          g += cg;
          b += cb;
          covered++;
        }
      }
      if (covered === 0) continue;
      // Straight (not premultiplied) alpha, as addImage expects: the colour is the mean of
      // the covered samples, the alpha is how many were covered.
      const at = (y * px + x) * 4;
      data[at] = Math.round(r / covered);
      data[at + 1] = Math.round(g / covered);
      data[at + 2] = Math.round(b / covered);
      data[at + 3] = Math.round((covered / samples) * 255);
    }
  }
  return { width: px, height: px, data };
}

/**
 * Supply the parking sign whenever a style asks for it. The layer lives in the basemap's
 * own layer set — the global style and every downloaded region's copy — so the image has
 * to survive every style replacement; answering `styleimagemissing` covers each one
 * without the theme swap or region restore having to remember. Register once.
 */
export function supplyParkingIcons(map: MLMap): void {
  map.on('styleimagemissing', (event: { id: string }) => {
    for (const theme of ['light', 'dark'] as const) {
      if (event.id === parkingIconId(theme) && !map.hasImage(event.id)) {
        map.addImage(event.id, parkingImage(mapInk(theme)) as never, { pixelRatio: PIXEL_RATIO });
      }
    }
  });
}

/** The car park symbol layer: the sign from z13, its name beside it from z15. */
export function parkingLayer(source: string, theme: Theme): SymbolLayerSpecification {
  const ink = mapInk(theme);
  return {
    id: PARKING_LAYER_ID,
    type: 'symbol',
    source,
    'source-layer': 'pois',
    minzoom: 13,
    filter: ['==', ['get', 'kind'], 'parking'],
    layout: {
      'icon-image': parkingIconId(theme),
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 15, 1],
      // Named car parks place first: they are the ones a walk description sends you to.
      'symbol-sort-key': ['case', ['has', 'name'], 0, 1],
      'text-field': ['step', ['zoom'], '', 15, ['coalesce', ['get', 'name:en'], ['get', 'name']]],
      'text-font': [MAP_FONTS.regular],
      'text-size': 11,
      'text-max-width': 8,
      'text-offset': [1.1, 0],
      'text-variable-anchor': ['left', 'right'],
      'text-justify': 'auto',
      // A sign with no room for its name still shows; the name never shows without it.
      'text-optional': true,
    },
    paint: {
      'text-color': ink.parkingText,
      'text-halo-color': ink.labelHalo,
      'text-halo-width': 1.4,
    },
  };
}
