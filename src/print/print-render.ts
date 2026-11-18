import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import { buildBaseStyle } from '../map/base-style';
import { applyAllStoredVisibility } from '../map/layers';
import { supplyParkingIcons } from '../map/parking';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import { addPeaksLayer } from '../overlays/peaks';
import type { Region } from '../regions/manifest';
import { addRegionToMap } from '../regions/region-layers';
import { ROUTE_SOURCE_ID, addRouteLayers } from '../routes/route-layers';
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

    await document.fonts.load(`600 40px "Barlow Semi Condensed"`).catch(() => []);
    await document.fonts.load(`400 24px "Barlow"`).catch(() => []);

    const page = composePage(map.getCanvas(), layout, css, sheet, attribution);
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

  ctx.strokeStyle = INK;
  ctx.lineWidth = px(0.3);
  ctx.strokeRect(px(mapRect.x), px(mapRect.y), px(mapRect.w), px(mapRect.h));

  drawFooter(ctx, px, { ...layout.footer, y: mapRect.y + mapRect.h }, sheet, attribution);
  return page;
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

  // Attribution, right-aligned, wrapped into what is left of the strip.
  const textLeft = northX + 6;
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
