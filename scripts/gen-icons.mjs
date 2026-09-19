#!/usr/bin/env node
// Renders ratmap's icons and iOS splash screens from public/icons/mark.svg.
//
// Replaces scripts/gen-placeholder-icons.py (the Phase 0 flat triangle). The mark is kept
// as SVG source and rasterised here with Playwright's Chromium, which is already a dev
// dependency for the e2e suite — no ImageMagick/rsvg on the build machine required.
//
//   node scripts/gen-icons.mjs
//
// Outputs are committed; nothing runs this at build time.

import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'public', 'icons');
const SPLASH = path.join(ROOT, 'public', 'splash');

/** --surface in the night theme, and the manifest's background_color. */
const GRAPHITE = '#0e1114';

const mark = await readFile(path.join(ICONS, 'mark.svg'), 'utf8');

/**
 * `scale` is the mark's width as a fraction of the shorter side.
 *
 * - any (0.72): full-bleed square; the platform may round the corners, not crop further.
 * - maskable (0.56): Android crops to as little as a circle of 80% diameter (radius 0.4).
 *   The mark's farthest point, the left foot at (8, 84), is 0.54 of its width from centre,
 *   so at 0.56 it reaches 0.30 of the icon — inside the circle with margin.
 * - apple-touch (0.64): iOS rounds the corners (a squircle), which clips less than a circle.
 * - splash (0.28 of width): the mark centred on graphite, the size iOS uses for its own
 *   launch icons.
 */
const ICON_JOBS = [
  { file: 'icon-192.png', w: 192, h: 192, scale: 0.72 },
  { file: 'icon-512.png', w: 512, h: 512, scale: 0.72 },
  { file: 'maskable-192.png', w: 192, h: 192, scale: 0.56 },
  { file: 'maskable-512.png', w: 512, h: 512, scale: 0.56 },
  { file: 'apple-touch-icon.png', w: 180, h: 180, scale: 0.64 },
];

/**
 * iOS picks an apple-touch-startup-image only on an exact match of device width, height
 * and pixel ratio — there is no fallback, so each supported screen needs its own file.
 * Portrait only: ratmap's manifest does not lock orientation, but iOS shows the splash in
 * the orientation the app is launched in, and a landscape launch just gets the graphite
 * page background, which is what the splash is anyway.
 *
 * Points and ratios from Apple's device specs; exported so index.html's link tags can be
 * checked against the same list (see splashLinks()).
 */
export const SPLASH_SCREENS = [
  { w: 440, h: 956, dpr: 3 }, // iPhone 16 Pro Max
  { w: 402, h: 874, dpr: 3 }, // iPhone 16 Pro
  { w: 430, h: 932, dpr: 3 }, // iPhone 16 Plus, 15 Pro Max, 15 Plus, 14 Pro Max
  { w: 393, h: 852, dpr: 3 }, // iPhone 16, 15 Pro, 15, 14 Pro
  { w: 428, h: 926, dpr: 3 }, // iPhone 14 Plus, 13 Pro Max, 12 Pro Max
  { w: 390, h: 844, dpr: 3 }, // iPhone 14, 13 Pro, 13, 12 Pro, 12
  { w: 375, h: 812, dpr: 3 }, // iPhone 13 mini, 12 mini, 11 Pro, XS, X
  { w: 414, h: 896, dpr: 3 }, // iPhone 11 Pro Max, XS Max
  { w: 414, h: 896, dpr: 2 }, // iPhone 11, XR
  { w: 414, h: 736, dpr: 3 }, // iPhone 8 Plus
  { w: 375, h: 667, dpr: 2 }, // iPhone SE (2nd/3rd gen), 8
];

export function splashFile({ w, h, dpr }) {
  return `splash-${w * dpr}x${h * dpr}.png`;
}

export function splashLinks() {
  return SPLASH_SCREENS.map(
    (s) =>
      `<link rel="apple-touch-startup-image" href="/splash/${splashFile(s)}" media="(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait)" />`,
  ).join('\n');
}

function page(w, h, markPx) {
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:${GRAPHITE};display:flex;align-items:center;justify-content:center">
<div style="width:${markPx}px;height:${markPx}px">${mark.replace('<svg ', `<svg width="${markPx}" height="${markPx}" `)}</div>
</body></html>`;
}

async function render(browser, out, w, h, markPx) {
  const tab = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await tab.setContent(page(w, h, markPx));
  await tab.screenshot({ path: out, omitBackground: false });
  await tab.close();
}

// Only when run directly, so the splash list can be imported without launching a browser.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(SPLASH, { recursive: true });
  const browser = await chromium.launch();
  for (const { file, w, h, scale } of ICON_JOBS) {
    await render(browser, path.join(ICONS, file), w, h, Math.round(Math.min(w, h) * scale));
    console.log(`icons/${file}`);
  }
  for (const s of SPLASH_SCREENS) {
    const w = s.w * s.dpr;
    const h = s.h * s.dpr;
    await render(browser, path.join(SPLASH, splashFile(s)), w, h, Math.round(w * 0.28));
    console.log(`splash/${splashFile(s)}`);
  }
  await browser.close();
  console.log('\nindex.html link tags:\n' + splashLinks());
}
