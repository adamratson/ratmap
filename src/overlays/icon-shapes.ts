import type { Map as MLMap } from 'maplibre-gl';
import { parseHex } from './terrain-features';

// Small map symbols drawn from geometry rather than from a sprite: the landmarks (masts,
// trig points, cairns…) and the field detail (gates, stiles, fords). Each is a few strokes,
// discs and filled polygons laid out on a 32-unit grid, rasterised by hand so it needs no
// DOM and is the same bytes everywhere (see parkingImage, src/map/parking.ts), and drawn
// again as SVG for the legend from the same numbers, so the two cannot drift apart.
//
// Every symbol is haloed: a point within RIM of a mark (or inside its `backing`) takes the
// rim colour — the theme's ground — so the symbol holds over hillshade, contours and the
// lines it sits on.

/** x0 y0 x1 y1, and a width when it is not STROKE. Round-ended. */
export type Segment = readonly [number, number, number, number, number?];
/** cx cy r */
export type Disc = readonly [number, number, number];
export type Vertex = readonly [number, number];

export interface Shape {
  strokes?: readonly Segment[];
  discs?: readonly Disc[];
  /** Closed polygons filled with the glyph colour. */
  fills?: ReadonlyArray<readonly Vertex[]>;
  /** A closed polygon whose interior is filled with the rim colour, not left clear. */
  backing?: readonly Vertex[];
}

export const GRID = 32;
export const STROKE = 1.9;
export const RIM = 2.2;
const PIXEL_RATIO = 2;
/** Samples per pixel edge, for antialiasing without a canvas. */
const SUPERSAMPLE = 4;

function segmentDistance(x: number, y: number, [x0, y0, x1, y1]: Segment): number {
  if (x0 === x1 && y0 === y1) return Math.hypot(x - x0, y - y0);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

function insidePolygon(x: number, y: number, polygon: readonly Vertex[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonDistance(x: number, y: number, polygon: readonly Vertex[]): number {
  if (insidePolygon(x, y, polygon)) return 0;
  let d = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    d = Math.min(d, segmentDistance(x, y, [...polygon[j], ...polygon[i]]));
  }
  return d;
}

/** Which part of a shape a point on the 32-unit grid falls in. */
export function shapePart(shape: Shape, u: number, v: number): 'none' | 'rim' | 'glyph' {
  // Distance outside the nearest mark: zero or less is on it.
  let edge = Infinity;
  for (const segment of shape.strokes ?? []) {
    edge = Math.min(edge, segmentDistance(u, v, segment) - (segment[4] ?? STROKE) / 2);
  }
  for (const [cx, cy, r] of shape.discs ?? []) edge = Math.min(edge, Math.hypot(u - cx, v - cy) - r);
  for (const polygon of shape.fills ?? []) edge = Math.min(edge, polygonDistance(u, v, polygon));
  if (edge <= 0) return 'glyph';
  if (edge <= RIM || (shape.backing && insidePolygon(u, v, shape.backing))) return 'rim';
  return 'none';
}

/**
 * RGBA pixels for a shape `size` CSS px square, at PIXEL_RATIO, in `glyph` haloed in
 * `rim` (both #rrggbb). Straight (not premultiplied) alpha, as addImage expects.
 */
export function shapeImage(
  shape: Shape,
  { glyph, rim }: { glyph: string; rim: string },
  size: number,
): { width: number; height: number; data: Uint8ClampedArray } {
  const colors = { glyph: parseHex(glyph), rim: parseHex(rim) };
  const px = size * PIXEL_RATIO;
  const scale = GRID / px;
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
          const part = shapePart(
            shape,
            (x + (sx + 0.5) / SUPERSAMPLE) * scale,
            (y + (sy + 0.5) / SUPERSAMPLE) * scale,
          );
          if (part === 'none') continue;
          const [cr, cg, cb] = colors[part];
          r += cr;
          g += cg;
          b += cb;
          covered++;
        }
      }
      if (covered === 0) continue;
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
 * The image id for a shape in a glyph colour, registering it on first use. Named by the
 * colour, like the scree stipple, so a day and a night symbol never collide; a theme change
 * replaces the style and every image with it, and installAppLayers re-adds the regions, so
 * this simply runs again.
 */
export function ensureShapeImage(
  map: MLMap,
  name: string,
  shape: Shape,
  colors: { glyph: string; rim: string },
  size: number,
): string {
  const id = `${name}-${colors.glyph.slice(1)}`;
  if (!map.hasImage(id)) {
    map.addImage(id, shapeImage(shape, colors, size) as never, { pixelRatio: PIXEL_RATIO });
  }
  return id;
}

/** The shape as a 40x24 legend swatch, drawn 20 px square in the middle. */
export function shapeSwatch(shape: Shape, { glyph, rim }: { glyph: string; rim: string }): string {
  const points = (polygon: readonly Vertex[]) => polygon.map(([x, y]) => `${x},${y}`).join(' ');
  const marks = (color: string, grow: number) =>
    (shape.strokes ?? [])
      .map(
        ([x0, y0, x1, y1, width = STROKE]) =>
          `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${color}" stroke-width="${width + grow * 2}" stroke-linecap="round"/>`,
      )
      .concat((shape.discs ?? []).map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r + grow}" fill="${color}"/>`))
      .concat(
        (shape.fills ?? []).map(
          (polygon) =>
            `<polygon points="${points(polygon)}" fill="${color}"` +
            (grow ? ` stroke="${color}" stroke-width="${grow * 2}" stroke-linejoin="round"` : '') +
            '/>',
        ),
      )
      .join('');
  const backing = shape.backing ? `<polygon points="${points(shape.backing)}" fill="${rim}"/>` : '';
  return (
    `<svg viewBox="0 0 40 24"><g transform="translate(10 2) scale(0.625)">` +
    `${backing}${marks(rim, RIM)}${marks(glyph, 0)}</g></svg>`
  );
}
