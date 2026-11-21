import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Map as MLMap } from 'maplibre-gl';
import { clearConditions, gotoApp, jumpTo, openChip, preferFileDownloads } from './helpers';

// Printing an A4 sheet: the frame that shows what will be on the paper, and the PDF made
// from it. Needs no downloaded region — outside one the sheet is drawn from the world
// catalog, which is enough to prove the frame, the render and the file.

/** Ben Nevis, where the frame is measured. */
const BEN_NEVIS: [number, number] = [-5.0037, 56.7969];

/** The frame's width on the ground, measured by MapLibre itself across its middle. */
async function frameGroundWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const map = (window as unknown as { __ratmapMap: MLMap }).__ratmapMap;
    const frame = document.querySelector<HTMLElement>('.print-frame')!.getBoundingClientRect();
    const origin = map.getContainer().getBoundingClientRect();
    const y = frame.top + frame.height / 2 - origin.top;
    const left = map.unproject([frame.left - origin.left, y]);
    const right = map.unproject([frame.right - origin.left, y]);
    return left.distanceTo(right);
  });
}

async function frameRatio(page: Page): Promise<number> {
  const box = (await page.locator('.print-frame').boundingBox())!;
  return box.width / box.height;
}

test.describe('printing', () => {
  test.beforeEach(async ({ context, page }) => {
    await preferFileDownloads(context);
    await gotoApp(page);
    await clearConditions(page);
    await jumpTo(page, BEN_NEVIS, 11);
  });

  test('frames an A4 sheet at its true scale, and takes the frame away on close', async ({ page }) => {
    await openChip(page, 'Print');
    const frame = page.locator('.print-frame');
    await expect(frame).toBeVisible();
    await expect(frame).toContainText('1:25');

    // 190 mm of map across a portrait sheet is 4.75 km at 1:25 000. MapLibre measures on a
    // sphere, the sheet on the ellipsoid: 0.35% apart here, well inside the tolerance.
    await expect.poll(() => frameGroundWidth(page)).toBeGreaterThan(4750 * 0.99);
    expect(await frameGroundWidth(page)).toBeLessThan(4750 * 1.01);
    expect(await frameRatio(page)).toBeCloseTo(190 / 263, 2);

    await page.locator('input[name="print-scale"][value="50000"]').check({ force: true });
    await page.locator('input[name="print-orientation"][value="landscape"]').check({ force: true });
    await expect(frame).toContainText('1:50');
    await expect.poll(() => frameRatio(page)).toBeCloseTo(277 / 176, 2);
    await expect.poll(() => frameGroundWidth(page)).toBeGreaterThan(13_850 * 0.99);

    // Outside any downloaded region the sheet would print with very little detail.
    await expect(page.locator('.print-coverage')).toContainText('outside');

    await page.locator('#chips .chip', { hasText: 'Print' }).click();
    await expect(frame).toBeHidden();
  });

  test('keeps the frame on the same ground when the sheet moves', async ({ page }) => {
    // On a phone the sheet is dragged up to reach Make PDF. The frame used to stay in the
    // middle of whatever map was left, and so slid onto ground nobody chose.
    await page.setViewportSize({ width: 375, height: 812 });
    await openChip(page, 'Print');
    await expect(page.locator('.print-frame')).toBeVisible();

    const frameCentre = () =>
      page.evaluate(() => {
        const map = (window as unknown as { __ratmapMap: MLMap }).__ratmapMap;
        const frame = document.querySelector<HTMLElement>('.print-frame')!.getBoundingClientRect();
        const origin = map.getContainer().getBoundingClientRect();
        const { lng, lat } = map.unproject([
          frame.left + frame.width / 2 - origin.left,
          frame.top + frame.height / 2 - origin.top,
        ]);
        return { lng, lat, top: frame.top };
      });
    const settled = async () => {
      // Two reads a moment apart that agree: the sheet and the map have both stopped.
      let previous = await frameCentre();
      await expect
        .poll(async () => {
          const now = await frameCentre();
          const still = Math.abs(now.top - previous.top) < 0.5;
          previous = now;
          return still;
        })
        .toBe(true);
      return previous;
    };

    const before = await settled();
    const setDetent = (detent: string) =>
      page.evaluate((d) => {
        (window as unknown as { __ratmapSheet: { open(d: string): void } }).__ratmapSheet.open(d);
      }, detent);

    for (const detent of ['peek', 'full', 'content']) {
      await setDetent(detent);
      const after = await settled();
      // A metre or so: the frame's middle, read back through the map's own projection.
      expect(Math.abs(after.lng - before.lng)).toBeLessThan(0.00002);
      expect(Math.abs(after.lat - before.lat)).toBeLessThan(0.00002);
    }
  });

  test('makes an A4 PDF of what is in the frame', async ({ page }) => {
    test.setTimeout(180_000);
    await openChip(page, 'Print');
    await page.locator('input[name="print-scale"][value="25000"]').check({ force: true });
    await page.locator('input[name="print-orientation"][value="portrait"]').check({ force: true });

    const action = page.locator('.print-action');
    await action.click();
    await expect(action).toHaveText('Save PDF', { timeout: 150_000 });
    // The hidden map the sheet is drawn from is gone once it has been drawn.
    await expect(page.locator('.print-render')).toHaveCount(0);

    const download = page.waitForEvent('download');
    await action.click();
    const file = await download;
    // Named for the frame's centre, which is the middle of the map beside the panel rather
    // than the map's own centre — so east of Ben Nevis on a docked layout.
    expect(file.suggestedFilename()).toMatch(/^ratmap-25k-56\.\d{3}n-[45]\.\d{3}w\.pdf$/);

    const bytes = await readFile((await file.path())!);
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // A page with map on it, not an empty canvas. Measured in this headless Chromium
    // (2026-11-18): a white page encodes to 38 KB, a flat grey map box with the footer to
    // 72 KB, and this catalog-only sheet (summits on relief) to about 160 KB.
    expect(bytes.length).toBeGreaterThan(110_000);

    // Moving the map means a new sheet.
    await jumpTo(page, [BEN_NEVIS[0] + 0.05, BEN_NEVIS[1]], 11);
    await expect(action).toHaveText('Make PDF');
  });
});
