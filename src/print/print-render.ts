import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import { declinationLine, magneticField } from '../location/declination';
import { buildBaseStyle } from '../map/base-style';
import { applyAllStoredVisibility } from '../map/layers';
import { supplyParkingIcons } from '../map/parking';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import { addPeaksLayer } from '../overlays/peaks';
import type { Region } from '../regions/manifest';
import { addRegionToMap } from '../regions/region-layers';
import { ROUTE_SOURCE_ID, addRouteLayers } from '../routes/route-layers';
import { gridConvergence, gridFor, gridLabel, gridLines, type Grid, type LngLat } from './grid';
import { jpegPdf } from './pdf';
import {
  MAP_CSS_PX_PER_MM,
  PAGE_PX_PER_MM,
  formatDistance,
  formatScale,
  mapCssPx,
  mapMmFromCssPx,
  scaleBar,
  sheetLayout,
  zoomForScale,
  type Orientation,
  type PrintScale,
  type RectMm,
  type SheetLayout,
} from './sheet-geometry';

// Draws an A4 sheet: a second, hidden MapLibre map sized to the paper and set to the
// zoom that gives the chosen scale, then the page around it — scale bar, north, the
// attribution ODbL requires — then a PDF of the lot.
//
// A second map rather than the one on screen: the on-screen map is the size of the phone,
// in whatever theme the phone is in, with the sheet over half of it. Resizing it to paper
// and back would flash, and lose whatever the person was looking at.

export interface PrintSheet {
  /** Centre of the sheet, [lng, lat]. */
  centre: [number, number];
  scale: PrintScale;
  orientation: Orientation;
}

export interface PrintSources {
  registry: TileSourceRegistry;
  /** The regions on this device, drawn exactly as the map draws them. */
  regions: readonly Region[];
  /** The route on the map, if there is one — it prints with the sheet. */
  route: GeoJSON.GeoJSON | null;
}

export interface PrintedSheet {
  file: File;
  /**
   * False when the map had not finished loading by the deadline. The sheet is still made
   * from what had arrived, and the caller says so, rather than handing over a sheet with
   * holes in it as though it were whole.
   */
  complete: boolean;
}

/** How long to wait for every tile before printing what has arrived. */
const LOAD_DEADLINE_MS = 45_000;

const INK = '#14171a';
const MUTED = '#4a4f55';
const PAPER = '#ffffff';

export async function renderSheet(sheet: PrintSheet, sources: PrintSources): Promise<PrintedSheet> {
  const layout = sheetLayout(sheet.orientation);
  const css = mapCssPx(layout);

  const container = document.createElement('div');
  container.className = 'print-render';
  container.setAttribute('aria-hidden', 'true');
  container.style.width = `${css.w}px`;
  container.style.height = `${css.h}px`;
  document.body.append(container);

  let map: MLMap | null = null;
  try {
    map = new maplibregl.Map({
      container,
      // Always the light flavour. A printed map is ink on white paper; the night theme
      // would print as a sheet of black toner with the map in the gaps.
      style: buildBaseStyle('light', sources.registry),
      center: sheet.centre,
      zoom: zoomForScale(sheet.scale, sheet.centre[1]),
      // North up and flat: a scale is only a scale on a map seen from straight above.
      bearing: 0,
      pitch: 0,
      interactive: false,
      // Read back below and printed in the footer: the credit for exactly the sources on
      // this sheet, which is what ODbL asks for.
      attributionControl: { compact: false },
      pixelRatio: PAGE_PX_PER_MM / MAP_CSS_PX_PER_MM,
      // Labels appear at once rather than fading in over a frame that might be the one
      // printed.
      fadeDuration: 0,
      // So the canvas can be read after the frame that drew it has been presented.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    supplyParkingIcons(map);

    await new Promise<void>((resolve) => map!.once('styledata', () => resolve()));

    // What main.ts's installAppLayers puts on the on-screen map, less the region outlines,
    // which are a screen affordance rather than part of the map.
    addPeaksLayer(map, sources.registry, 'light');
    addRouteLayers(map, 'light');
    if (sources.route) {
      (map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(sources.route);
    }
    for (const region of sources.regions) {
      await addRegionToMap(map, sources.registry, region, 'light');
    }
    // The Layers switches: a sheet prints what the person chose to see.
    applyAllStoredVisibility(map);

    const complete = await settled(map, LOAD_DEADLINE_MS);
    const attribution =
      container.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent?.trim() ?? '';
    // Projected through the print map itself while it still exists, so the grid lands on
    // exactly the pixels the map drew its ground at.
    const grid = gridOverlay(map, css, sheet.centre);

    await document.fonts.load(`600 40px "Barlow Semi Condensed"`).catch(() => []);
    await document.fonts.load(`400 24px "Barlow"`).catch(() => []);

    const page = composePage(map.getCanvas(), layout, css, sheet, attribution, grid);
    const jpeg = await canvasJpeg(page);
    page.width = page.height = 0; // Release the page's memory now, not at the next GC.

    const name = sheetFilename(sheet);
    const pdf = jpegPdf({
      jpeg,
      widthPx: Math.round(layout.page.w * PAGE_PX_PER_MM),
      heightPx: Math.round(layout.page.h * PAGE_PX_PER_MM),
      pageWidthMm: layout.page.w,
      pageHeightMm: layout.page.h,
      title: `ratmap ${formatScale(sheet.scale)} ${formatCentre(sheet.centre)}`,
    });
    return { file: new File([pdf], name, { type: 'application/pdf' }), complete };
  } finally {
    // remove() also loses the GL context, which a phone has only a handful of.
    map?.remove();
    container.remove();
  }
}

/** Resolves true once every tile has loaded and drawn, false at the deadline. */
function settled(map: MLMap, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      map.off('idle', done);
      resolve(false);
    }, deadlineMs);
    map.once('idle', done);
    // `idle` follows a render. The layers above already asked for one, but a map with
    // nothing left to load might otherwise have had its last one before this listened.
    map.triggerRepaint();
  });
}

export function sheetFilename(sheet: PrintSheet): string {
  const [lng, lat] = sheet.centre;
  const ns = `${Math.abs(lat).toFixed(3)}${lat >= 0 ? 'n' : 's'}`;
  const ew = `${Math.abs(lng).toFixed(3)}${lng >= 0 ? 'e' : 'w'}`;
  return `ratmap-${sheet.scale / 1000}k-${ns}-${ew}.pdf`;
}

export function formatCentre([lng, lat]: [number, number]): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? 'E' : 'W'}`;
}

// --- The page ------------------------------------------------------------------------

function composePage(
  mapCanvas: HTMLCanvasElement,
  layout: SheetLayout,
  css: { w: number; h: number },
  sheet: PrintSheet,
  attribution: string,
  grid: GridOverlay,
): HTMLCanvasElement {
  const page = document.createElement('canvas');
  page.width = Math.round(layout.page.w * PAGE_PX_PER_MM);
  page.height = Math.round(layout.page.h * PAGE_PX_PER_MM);
  const ctx = page.getContext('2d')!;
  const px = (mm: number): number => mm * PAGE_PX_PER_MM;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, page.width, page.height);

  // The map at its exact physical size (sheet-geometry.ts mapCssPx says why that is not
  // quite the margin's width). drawImage rescales if MapLibre had to lower the pixel ratio
  // on a device with small GL limits: softer, never the wrong scale.
  const mapRect: RectMm = {
    x: layout.map.x,
    y: layout.map.y,
    w: mapMmFromCssPx(css.w),
    h: mapMmFromCssPx(css.h),
  };
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mapCanvas, px(mapRect.x), px(mapRect.y), px(mapRect.w), px(mapRect.h));

  drawGrid(ctx, px, mapRect, css, grid);

  ctx.strokeStyle = INK;
  ctx.lineWidth = px(0.3);
  ctx.strokeRect(px(mapRect.x), px(mapRect.y), px(mapRect.w), px(mapRect.h));

  drawFooter(ctx, px, { ...layout.footer, y: mapRect.y + mapRect.h }, sheet, attribution);
  return page;
}

// --- The grid ---------------------------------------------------------------------------

/** OS-map blue: reads as the grid, and stays out of the way of the route's red. */
const GRID_INK = '#1f5fa8';

/** The grid's lines, in the print map's CSS px, and what the sheet says about it. */
interface GridOverlay {
  grid: Grid;
  eastings: { value: number; points: [number, number][] }[];
  northings: { value: number; points: [number, number][] }[];
  /** Degrees grid north is turned from true north at the centre, positive east. */
  convergence: number;
  /** The 100 km squares the sheet reaches into, where the grid names them. */
  squares: string[];
}

function gridOverlay(map: MLMap, css: { w: number; h: number }, centre: [number, number]): GridOverlay {
  const grid = gridFor(centre);
  const corners: LngLat[] = [
    [0, 0],
    [css.w, 0],
    [css.w, css.h],
    [0, css.h],
  ].map(([x, y]) => {
    const { lng, lat } = map.unproject([x, y]);
    return [lng, lat];
  });
  const lines = gridLines(grid, corners);
  const toCss = (line: { value: number; points: LngLat[] }) => ({
    value: line.value,
    points: line.points.map((point): [number, number] => {
      const { x, y } = map.project(point);
      return [x, y];
    }),
  });
  const squares = [
    ...new Set(
      corners.map((corner) => grid.square(...grid.toGrid(corner))).filter((s): s is string => s !== null),
    ),
  ];
  return {
    grid,
    eastings: lines.eastings.map(toCss),
    northings: lines.northings.map(toCss),
    convergence: gridConvergence(grid, centre),
    squares,
  };
}

/**
 * The kilometre grid over the map, labelled round the edge, with a key in the corner: which
 * grid, which 100 km square, and how far grid north is from true north.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  px: (mm: number) => number,
  mapRect: RectMm,
  css: { w: number; h: number },
  overlay: GridOverlay,
): void {
  const x0 = px(mapRect.x);
  const y0 = px(mapRect.y);
  const sx = px(mapRect.w) / css.w;
  const sy = px(mapRect.h) / css.h;
  const toPage = ([x, y]: [number, number]): [number, number] => [x0 + x * sx, y0 + y * sy];

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, px(mapRect.w), px(mapRect.h));
  ctx.clip();

  ctx.strokeStyle = GRID_INK;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = px(0.12);
  for (const line of [...overlay.eastings, ...overlay.northings]) {
    ctx.beginPath();
    line.points.forEach((point, i) => {
      const [x, y] = toPage(point);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Labels just inside the frame, where each line meets it, haloed in white so a label
  // over a wood or a loch still reads. Clear of the corners, where two edges' labels meet.
  const size = 2.3;
  const clearOfCorner = px(5);
  const right = x0 + px(mapRect.w);
  const bottom = y0 + px(mapRect.h);
  ctx.font = `600 ${px(size)}px "Barlow Semi Condensed", system-ui, sans-serif`;

  // On a paper-coloured tab rather than a halo: a line running straight into "74" read as
  // "-74", and a gap either side is how a printed grid says where its line ends.
  const label = (text: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline): void => {
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    const width = ctx.measureText(text).width;
    const height = px(size);
    const pad = px(0.5);
    const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    const top = baseline === 'top' ? y : baseline === 'bottom' ? y - height : y - height / 2;
    ctx.fillStyle = PAPER;
    ctx.fillRect(left - pad, top - pad / 2, width + 2 * pad, height + pad);
    ctx.fillStyle = GRID_INK;
    ctx.fillText(text, x, y);
  };

  // Any line of the other set on the sheet, to say which 100 km square a 00 line opens.
  const someNorthing = overlay.northings[Math.floor(overlay.northings.length / 2)]?.value ?? 0;
  const someEasting = overlay.eastings[Math.floor(overlay.eastings.length / 2)]?.value ?? 0;

  for (const line of overlay.eastings) {
    const page = line.points.map(toPage);
    const text = gridLabel(overlay.grid, line.value, 'easting', someNorthing);
    for (const [edge, baseline, offset] of [
      [y0, 'top', px(0.8)],
      [bottom, 'bottom', -px(0.8)],
    ] as const) {
      const x = crossing(page, 1, edge);
      if (x === null || x < x0 + clearOfCorner || x > right - clearOfCorner) continue;
      label(text, x, edge + offset, 'center', baseline);
    }
  }
  for (const line of overlay.northings) {
    const page = line.points.map(toPage);
    const text = gridLabel(overlay.grid, line.value, 'northing', someEasting);
    for (const [edge, align, offset] of [
      [x0, 'left', px(0.8)],
      [right, 'right', -px(0.8)],
    ] as const) {
      const y = crossing(page, 0, edge);
      if (y === null || y < y0 + clearOfCorner || y > bottom - clearOfCorner) continue;
      label(text, edge + offset, y, align, 'middle');
    }
  }

  // The key, bottom left: enough to give a full grid reference and to turn a bearing off
  // the lines into a true one.
  const squares = overlay.squares.length > 0 ? ` ${overlay.squares.join('/')}` : '';
  const turn = Math.abs(overlay.convergence);
  const north =
    turn < 0.05
      ? 'Grid north is true north'
      : `Grid north ${turn.toFixed(1)}° ${overlay.convergence > 0 ? 'E' : 'W'} of true`;
  const lines = [`${overlay.grid.name}${squares} · 1 km squares`, north];
  ctx.font = `400 ${px(2.1)}px "Barlow", system-ui, sans-serif`;
  const pad = px(1);
  const lineHeight = px(2.8);
  const width = Math.max(...lines.map((text) => ctx.measureText(text).width)) + 2 * pad;
  const height = lines.length * lineHeight + pad;
  const boxX = x0 + px(5);
  const boxY = bottom - px(4.5) - height;
  ctx.fillStyle = PAPER;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = GRID_INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((text, i) => ctx.fillText(text, boxX + pad, boxY + pad + (i + 0.75) * lineHeight));

  ctx.restore();
}

/**
 * Where a polyline crosses `value` on one axis (0: x, 1: y), as the other coordinate — or
 * null if it never does.
 */
function crossing(points: [number, number][], axis: 0 | 1, value: number): number | null {
  const other = axis === 0 ? 1 : 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if ((a[axis] - value) * (b[axis] - value) > 0 || a[axis] === b[axis]) continue;
    const t = (value - a[axis]) / (b[axis] - a[axis]);
    return a[other] + t * (b[other] - a[other]);
  }
  return null;
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  px: (mm: number) => number,
  footer: RectMm,
  sheet: PrintSheet,
  attribution: string,
): void {
  const top = footer.y;
  const font = (weight: number, sizeMm: number, family = '"Barlow"'): string =>
    `${weight} ${px(sizeMm)}px ${family}, system-ui, sans-serif`;

  // Scale, then where and when.
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = font(600, 4.6, '"Barlow Semi Condensed"');
  ctx.fillText(formatScale(sheet.scale), px(footer.x), px(top + 6.5));

  ctx.fillStyle = MUTED;
  ctx.font = font(400, 2.3);
  ctx.fillText(formatCentre(sheet.centre), px(footer.x), px(top + 10));
  ctx.fillText(`Printed ${new Date().toLocaleDateString('en-GB', { dateStyle: 'medium' })}`, px(footer.x), px(top + 13));

  // Scale bar: alternate filled and open divisions, labelled at each end and the middle.
  const bar = scaleBar(sheet.scale, 40);
  const barX = footer.x + 48;
  const barY = top + 4.5;
  const barH = 1.4;
  const step = bar.mm / bar.divisions;
  ctx.lineWidth = px(0.2);
  ctx.strokeStyle = INK;
  for (let i = 0; i < bar.divisions; i++) {
    ctx.fillStyle = i % 2 === 0 ? INK : PAPER;
    ctx.fillRect(px(barX + i * step), px(barY), px(step), px(barH));
  }
  ctx.strokeRect(px(barX), px(barY), px(bar.mm), px(barH));

  ctx.fillStyle = INK;
  ctx.font = font(400, 2.4);
  ctx.textAlign = 'center';
  ctx.fillText('0', px(barX), px(barY + barH + 3));
  if (bar.divisions % 2 === 0) {
    ctx.fillText(formatDistance(bar.metres / 2).replace(/ (k?m)$/, ''), px(barX + bar.mm / 2), px(barY + barH + 3));
  }
  ctx.fillText(formatDistance(bar.metres), px(barX + bar.mm), px(barY + barH + 3));

  // North: the sheet is always north-up, so this is true north, the meridian through the
  // centre — not grid north of any national grid.
  const northX = barX + bar.mm + 9;
  ctx.beginPath();
  ctx.moveTo(px(northX), px(top + 2.2));
  ctx.lineTo(px(northX + 1.6), px(top + 7.4));
  ctx.lineTo(px(northX), px(top + 6.4));
  ctx.lineTo(px(northX - 1.6), px(top + 7.4));
  ctx.closePath();
  ctx.fill();
  ctx.font = font(600, 2.6, '"Barlow Semi Condensed"');
  ctx.fillText('N', px(northX), px(top + 10.6));

  // Magnetic north, under the scale bar and the arrow, for the centre of the sheet on the
  // day it is printed — the date is on the sheet, and the drift a year beside it, so the
  // line stays usable for years. Nothing when the model has expired (declination.ts).
  const textLeft = northX + 6;
  const field = magneticField(sheet.centre[1], sheet.centre[0], new Date());
  if (field) {
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    let size = 2.3;
    const line = declinationLine(field);
    ctx.font = font(400, size);
    // Shrink rather than run into the attribution: the near-pole caution is the long one.
    const room = px(textLeft - 1.5 - barX);
    while (ctx.measureText(line).width > room && size > 1.6) {
      size -= 0.1;
      ctx.font = font(400, size);
    }
    ctx.fillText(line, px(barX), px(top + 13));
  }

  // Attribution, right-aligned, wrapped into what is left of the strip.
  const width = footer.x + footer.w - textLeft;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'right';
  ctx.font = font(400, 2.1);
  const lines = wrap(ctx, attribution, px(width)).slice(0, 4);
  lines.forEach((line, i) => {
    ctx.fillText(line, px(footer.x + footer.w), px(top + 4 + i * 2.9));
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxPx) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function canvasJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // High quality: a map is fine line work and small type, which is what JPEG blurs.
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('The sheet was too large to encode on this device.'));
          return;
        }
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      'image/jpeg',
      0.92,
    );
  });
}
