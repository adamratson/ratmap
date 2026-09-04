import { expect, test } from '@playwright/test';
import {
  clearConditions,
  gotoApp,
  jumpTo,
  openChip,
  sheetHeight,
  styleLayers,
} from './helpers';

// The sheet is the app's one non-map surface, so every destination is reached through it
// and every one of them has to give the map back. This file covers that contract, the
// theme it is drawn in, and the notice that explains a stretched map — the parts of the
// UI that need no network and no downloaded region.

/** Ben Nevis, at a zoom well past the world catalog's z5 ceiling. */
const BEN_NEVIS: [number, number] = [-5.0037, 56.7969];

test.describe('the sheet', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('rests at peek with the controls that must always be in reach', async ({ page }) => {
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
    await expect(page.locator('#search-input')).toBeVisible();
    await expect(page.locator('#chips .chip')).toHaveText(['Routes', 'Offline', 'Saved']);
    await expect(page.locator('#theme-btn')).toBeVisible();
    await expect(page.locator('#settings-btn')).toBeVisible();

    // Even at rest it takes room, and everything positioned above it reads this number —
    // the map attribution, which is legally required and must never end up underneath.
    expect(await sheetHeight(page)).toBeGreaterThan(0);
  });

  test('opens a destination from its chip, and closes it from the same chip', async ({ page }) => {
    const routes = page.locator('#chips .chip', { hasText: 'Routes' });
    await expect(routes).toHaveAttribute('aria-expanded', 'false');

    const resting = await sheetHeight(page);
    await openChip(page, 'Routes');

    // A disclosure, not a tab: the chip reports that its own view is open.
    await expect(routes).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sheet-body')).toHaveAttribute('aria-label', 'Routes');
    expect(await sheetHeight(page)).toBeGreaterThan(resting);

    // Tapping the open one puts the map back, so every chip is its own way out — there
    // are no per-panel close buttons left.
    await routes.click();
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
    await expect(routes).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sheet-body')).toBeEmpty();
  });

  test('puts the map back on Escape', async ({ page }) => {
    await openChip(page, 'Offline');
    await expect(page.locator('#sheet-body')).toHaveAttribute('aria-label', 'Offline regions');

    // The one thing every dismissible surface owes a keyboard user, and with no close
    // buttons anywhere it is the only key that closes anything.
    await page.keyboard.press('Escape');
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
    await expect(page.locator('#sheet-body')).toBeEmpty();
  });

  test('swaps one destination for another without stacking them', async ({ page }) => {
    await openChip(page, 'Routes');
    await openChip(page, 'Saved');

    await expect(page.locator('#sheet-body')).toHaveAttribute('aria-label', 'Saved places');
    await expect(page.locator('#chips .chip', { hasText: 'Saved' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.locator('#chips .chip', { hasText: 'Routes' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // One view at a time: the previous one's contents are gone, not merely hidden.
    await expect(page.locator('.routes-toolbar')).toHaveCount(0);
  });

  test('turns the debug overlay on from settings, and remembers it', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await page.locator('#debug-overlay-toggle').waitFor();
    await expect(page.locator('.debug-overlay')).toHaveCount(0);

    await page.locator('#debug-overlay-toggle').check();
    await expect(page.locator('.debug-overlay')).toBeVisible();

    // It holds a ResizeObserver and a repeating timer, so it is created and destroyed
    // with the setting rather than left running and hidden.
    await page.locator('#debug-overlay-toggle').uncheck();
    await expect(page.locator('.debug-overlay')).toHaveCount(0);
  });
});

test.describe('theme', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('cycles system → light → dark and remembers the choice', async ({ page }) => {
    const button = page.locator('#theme-btn');
    const root = page.locator('html');

    // The label says the current state rather than the next one — a control that
    // announces what it will become is unreadable when you are working out where you are.
    await expect(button).toHaveAttribute('aria-label', 'Map theme: follows your device');

    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'Map theme: light');
    await expect(root).toHaveAttribute('data-theme', 'light');

    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'Map theme: dark');
    await expect(root).toHaveAttribute('data-theme', 'dark');

    // People turn the map dark before they turn the phone dark, so the choice is stored
    // rather than re-derived from the system on every launch.
    await page.reload();
    await page.locator('#map').waitFor();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#theme-btn')).toHaveAttribute('aria-label', 'Map theme: dark');
  });

  test('keeps the app’s own layers across a theme change', async ({ page }) => {
    // Protomaps ships flavours as whole layer sets, so switching means replacing the
    // style — which drops every source and layer the app added on top of it. Losing the
    // summits (or a half-planned route) because someone turned the map dark would be its
    // own bug.
    await expect.poll(async () => (await styleLayers(page)).map((l) => l.id)).toContain(
      'peaks-symbol',
    );

    await page.locator('#theme-btn').click();
    await page.locator('#theme-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await expect
      .poll(async () => (await styleLayers(page)).map((l) => l.id), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(['peaks-symbol', 'peaks-symbol-marker', 'route-line']));
  });
});

test.describe('detail limit', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('stays quiet while the map is showing data it actually has', async ({ page }) => {
    // The world catalog holds z0-5, so nothing is being stretched at the opening view.
    await expect(page.locator('#detail-notice')).toBeHidden();
  });

  test('says the map is stretched here, and names the download that fixes it', async ({
    page,
  }) => {
    await jumpTo(page, BEN_NEVIS, 12);

    const notice = page.locator('#detail-notice');
    await expect(notice).toBeVisible();
    // Naming the region turns a complaint into an instruction: the notice reports that
    // the map is enlarged, and a specific download is the thing that fixes it. "Great
    // Britain" since the catalogue moved to Geofabrik's country-level extracts (see
    // TEST_REGION in e2e/helpers.ts) — there is no smaller UK region publishing any more.
    await expect(notice).toHaveText(/Limited detail/);
    await expect(notice).toHaveText(/Great Britain/);

    // The offered region gets an outline, so "get Great Britain" has a visible extent
    // rather than naming a place without showing how much of the screen it covers.
    await expect
      .poll(async () => (await styleLayers(page)).map((l) => l.id))
      .toEqual(expect.arrayContaining(['region-footprints-fill', 'region-footprints-line']));

    await notice.click();
    await expect(page.locator('#sheet-body')).toHaveAttribute('aria-label', 'Offline regions');
  });

  test('goes quiet again on zooming back out', async ({ page }) => {
    await jumpTo(page, BEN_NEVIS, 12);
    await expect(page.locator('#detail-notice')).toBeVisible();

    await jumpTo(page, BEN_NEVIS, 5);
    await expect(page.locator('#detail-notice')).toBeHidden();
  });
});
