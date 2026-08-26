import { expect, test } from '@playwright/test';
import {
  clearConditions,
  clearSavedData,
  clickPeak,
  gotoApp,
  mapView,
  openChip,
  showArea,
} from './helpers';

// Summits and the places saved from them. The peaks overlay is our own archive rather than
// the basemap's POIs (C6 — Protomaps v4 dropped `ele`), and a saved place is a
// self-contained record (C18): name, coordinates and height, never a bare OSM node id.

const BEN_NEVIS_AREA: [number, number, number, number] = [-5.1, 56.78, -4.98, 56.82];

test.describe('summits and saved places', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearSavedData(page);
    await clearConditions(page);
    await showArea(page, BEN_NEVIS_AREA);
  });

  test('opens a summit and reports the summit’s own position', async ({ page }) => {
    const peak = await clickPeak(page);

    await expect(page.locator('#sheet-body h2')).toHaveText(peak.name);
    await expect(page.locator('#sheet-body')).toHaveAttribute('aria-label', 'Summit details');

    // The coordinates shown are the summit's, not the tap's. The tap box is 22 px, which
    // is kilometres at low zoom — reporting the tap would put the sheet, and anything
    // saved from it, somewhere the summit is not.
    await expect(page.locator('.sheet-coords')).toHaveText(
      `${peak.lat.toFixed(5)}, ${peak.lng.toFixed(5)}`,
    );

    await expect(page.locator('.sheet-ele')).toHaveText(
      peak.ele === null ? 'Elevation unknown' : `${Math.round(peak.ele)} m`,
    );
  });

  test('closes the summit sheet when the next tap misses', async ({ page }) => {
    await clickPeak(page);
    await expect(page.locator('#sheet-body h2')).toBeVisible();

    // A detail card, not a destination: it must not keep half the map it was opened on.
    await page.mouse.click(40, 120);
    await expect(page.locator('#sheet-body h2')).toHaveCount(0);
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
  });

  test('saves a summit, and keeps it across a relaunch', async ({ page }) => {
    const peak = await clickPeak(page);

    await page.locator('.sheet-save').click();
    await expect(page.locator('.toast.ok', { hasText: `Saved “${peak.name}”` })).toBeVisible();

    await openChip(page, 'Saved');
    await expect(page.locator('.place-goto')).toContainText(peak.name);
    if (peak.ele !== null) {
      await expect(page.locator('.place-goto')).toContainText(`${Math.round(peak.ele)} m`);
    }

    // C18/C10 in the same spirit: the record stands on its own, so it survives a cold
    // start with nothing in memory.
    await page.reload();
    await page.locator('#map').waitFor();
    await clearConditions(page);

    await openChip(page, 'Saved');
    await expect(page.locator('.place-goto')).toContainText(peak.name);
  });

  test('goes to a saved place from the list', async ({ page }) => {
    const peak = await clickPeak(page);
    await page.locator('.sheet-save').click();
    await expect(page.locator('.toast.ok', { hasText: `Saved “${peak.name}”` })).toBeVisible();

    // Somewhere else entirely, so arriving is unambiguous.
    await showArea(page, [-3.2, 55.9, -3.1, 56.0]);

    await openChip(page, 'Saved');
    await page.locator('.place-goto').first().click();

    await expect
      .poll(async () => {
        const view = await mapView(page);
        return Math.max(Math.abs(view.lng - peak.lng), Math.abs(view.lat - peak.lat));
      })
      .toBeLessThan(0.01);

    // Out of the way, but still one drag from the list — going to a place is usually the
    // first of several.
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
  });

  test('deletes a place immediately, and takes it back on Undo', async ({ page }) => {
    const peak = await clickPeak(page);
    await page.locator('.sheet-save').click();
    await expect(page.locator('.toast.ok', { hasText: `Saved “${peak.name}”` })).toBeVisible();

    await openChip(page, 'Saved');
    await page.locator('.place-delete').first().click();

    // Deleted straight away rather than behind a confirmation dialog — the way back is the
    // undo, and it has to restore the same record rather than a copy of it.
    await expect(page.locator('.places-empty')).toBeVisible();
    const undo = page.locator('.toast .toast-action', { hasText: 'Undo' });
    await expect(undo).toBeVisible();

    await undo.click();
    await expect(page.locator('.place-goto')).toContainText(peak.name);
    await expect(page.locator('.place-goto')).toHaveCount(1);
  });

  test('says the list is empty rather than showing nothing at all', async ({ page }) => {
    await openChip(page, 'Saved');
    await expect(page.locator('.places-empty')).toContainText(/Save place/);
  });
});
