// The arithmetic of a printed A4 sheet: where the map sits on the paper, how much ground it
// covers at a given scale, and the zoom that draws that ground at that scale. Pure, so it
// can be tested to the millimetre — a printed map whose scale is quietly wrong is worse
// than no printed map, because someone measures a distance off it with a ruler.

export type PrintScale = 25_000 | 50_000;
export type Orientation = 'portrait' | 'landscape';

export const PRINT_SCALES: readonly PrintScale[] = [25_000, 50_000];

/** ISO 216 A4, in mm. */
const A4 = { short: 210, long: 297 } as const;

/**
 * Space left blank round the edge, in mm. Most printers cannot print the outer ~4–6 mm,
 * and a map that silently loses a strip down one side is a map whose frame lies.
 */
export const MARGIN_MM = 10;

/** The strip under the map for scale, scale bar, north and attribution, in mm. */
export const FOOTER_MM = 14;

/**
 * CSS px per mm. MapLibre lays everything out in CSS px — line widths, label sizes, the
 * map's own size — so the print map is sized in CSS px at the CSS reference density, and
 * `pixelRatio` only adds resolution. A 12px label then prints at the same physical size
 * the CSS spec gives it on screen (about 9 pt).
 */
export const CSS_PX_PER_MM = 96 / 25.4;

/**
 * How much smaller than on screen the map's lines and labels print, as a power of two.
 *
 * The style switches its detail on by zoom, tuned for a screen: every contour from z13,
 * landmarks and car parks from z13, region paths from z12. At the CSS reference density a
 * 1:25 000 sheet in Scotland renders at z12.7 and 1:50 000 at z11.7 — below most of
 * that. Rendering a larger map at a higher zoom keeps the ground the same and brings the
 * detail in, at the cost of smaller type. 0 would print the screen's symbol sizes.
 */
export const DETAIL_BOOST = 0.5;

/** CSS px of print map per mm of paper. */
export const MAP_CSS_PX_PER_MM = CSS_PX_PER_MM * 2 ** DETAIL_BOOST;

/**
 * Raster resolution of the printed page: 10 px per mm, 254 dpi. Sharp on a home printer,
 * and the map canvas (at most 2770 × 2630 px) stays inside MapLibre's default
 * `maxCanvasSize` of 4096 and the GL limits of any phone this app supports, without which
 * MapLibre quietly lowers the pixel ratio (Map._resize, map.ts).
 */
export const PAGE_PX_PER_MM = 10;

/** WGS84 semi-major axis and first eccentricity squared — the ellipsoid the data is on. */
const WGS84_A = 6_378_137;
const WGS84_E2 = 0.006_694_379_990_14;

/** MapLibre's world is 512 CSS px wide at zoom 0. */
const WORLD_PX_AT_Z0 = 512;

export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLayout {
  page: { w: number; h: number };
  /** Where the map may go: inside the margins, above the footer. */
  map: RectMm;
  footer: RectMm;
}

export function sheetLayout(orientation: Orientation): SheetLayout {
  const page =
    orientation === 'portrait' ? { w: A4.short, h: A4.long } : { w: A4.long, h: A4.short };
  const map = {
    x: MARGIN_MM,
    y: MARGIN_MM,
    w: page.w - 2 * MARGIN_MM,
    h: page.h - 2 * MARGIN_MM - FOOTER_MM,
  };
  return {
    page,
    map,
    footer: { x: MARGIN_MM, y: map.y + map.h, w: map.w, h: FOOTER_MM },
  };
}

/**
 * The map area in whole CSS px: what the print map's container is sized to. Whole, because
 * a fractional container would be rounded by the browser anyway. The sheet is then drawn
 * at this size's exact physical width (`mapMmFromCssPx`), never stretched to the margin,
 * so the rounding costs a fraction of a mm of margin rather than any accuracy of scale.
 */
export function mapCssPx(layout: SheetLayout): { w: number; h: number } {
  return {
    w: Math.floor(layout.map.w * MAP_CSS_PX_PER_MM),
    h: Math.floor(layout.map.h * MAP_CSS_PX_PER_MM),
  };
}

export function mapMmFromCssPx(px: number): number {
  return px / MAP_CSS_PX_PER_MM;
}

/** Ground covered by the map area at a scale, in metres. */
export function groundSize(layout: SheetLayout, scale: PrintScale): { w: number; h: number } {
  const css = mapCssPx(layout);
  return {
    w: (mapMmFromCssPx(css.w) / 1000) * scale,
    h: (mapMmFromCssPx(css.h) / 1000) * scale,
  };
}

/**
 * Length of a whole circle of latitude on the WGS84 ellipsoid, in metres.
 *
 * Not MapLibre's sphere (`earthRadius` 6371008.8, used by its ScaleControl): a degree of
 * longitude on the ground is N·cos φ, where N is the ellipsoid's prime-vertical radius.
 * The sphere is 0.3–0.4% short at British and Alpine latitudes — a millimetre over the
 * height of the sheet, enough to notice with a romer.
 */
export function parallelCircumference(lat: number): number {
  const phi = (lat * Math.PI) / 180;
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(phi) ** 2);
  return 2 * Math.PI * n * Math.cos(phi);
}

/** Ground metres per CSS px at a zoom, east–west, at a latitude. */
export function metresPerCssPx(zoom: number, lat: number): number {
  return parallelCircumference(lat) / (WORLD_PX_AT_Z0 * 2 ** zoom);
}

/**
 * The zoom at which a CSS px covers `scale` times its own physical width on the ground,
 * at the sheet's centre latitude.
 *
 * Exact east–west through the centre. Web Mercator's scale grows with latitude, so it is
 * off by tan φ·Δφ toward the top and bottom edges: 0.08% at the edge of a 1:25 000
 * portrait sheet in Scotland (1:50 000: 0.16%) — a fraction of a mm on the paper.
 */
export function zoomForScale(scale: PrintScale, lat: number): number {
  const metresPerPxWanted = scale / (MAP_CSS_PX_PER_MM * 1000);
  return Math.log2(parallelCircumference(lat) / (WORLD_PX_AT_Z0 * metresPerPxWanted));
}

/**
 * The scale bar: the longest round length that fits in `maxMm` of paper, and where its
 * divisions fall. Drawn at the nominal scale, from the same number as the zoom, so the bar
 * and the map cannot disagree.
 */
export function scaleBar(scale: PrintScale, maxMm = 60): { metres: number; mm: number; divisions: number } {
  const candidates = [5000, 2000, 1000, 500, 250];
  const metres = candidates.find((m) => (m / scale) * 1000 <= maxMm) ?? 250;
  return { metres, mm: (metres / scale) * 1000, divisions: metres === 2000 ? 4 : 5 };
}

export function formatScale(scale: PrintScale): string {
  // A thin space, the way OS and Harvey print it: 1:25 000.
  return `1:${String(scale).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}
