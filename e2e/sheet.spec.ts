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
    await expect(page.locator('#chips .chip')).toHaveText(['Routes', 'Offline', 'Saved', 'Layers']);
    await expect(page.locator('#legend-btn')).toBeVisible();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });

  test('opens a destination from its chip, and closes it from the same chip', async ({ page }) => {
    const routes = page.locator('#chips .chip', { hasText: 'Routes' });
    await expect(routes).toHaveAttribute('aria-expanded', 'false');

    await openChip(page, 'Routes');

    // A disclosure, not a tab: the chip reports that its own view is open.
    await expect(routes).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sheet-body')).toHaveAttribute('aria-label', 'Routes');

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

// The bottom sheet's geometry — detents, and the --sheet-visible height everything above
// it is lifted by — only exists on a touch screen. The project's Desktop Chrome window is
// wide enough, with a fine pointer, to get the docked panel instead
// (plans/desktop-ux-review.md), so these run as a phone. Behaviour that is the same in
// both layouts (chips, Escape, one view at a time) stays in 'the sheet' above, on desktop.
test.describe('the touch sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('is the bottom sheet, not the docked panel', async ({ page }) => {
    // Guards the test setup as much as the app: if this emulation ever stops reading as
    // a touch screen, everything below would be testing the docked panel by mistake.
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.locator('.sheet-grip')).toBeVisible();
  });

  test('takes room even at rest, so nothing above it ends up underneath', async ({ page }) => {
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
    // Everything positioned above the sheet reads this number — the map attribution,
    // which is legally required and must never end up underneath.
    expect(await sheetHeight(page)).toBeGreaterThan(0);
  });

  test('grows when a destination opens, and gives the room back when it closes', async ({
    page,
  }) => {
    const resting = await sheetHeight(page);
    await openChip(page, 'Routes');
    expect(await sheetHeight(page)).toBeGreaterThan(resting);

    await page.locator('#chips .chip', { hasText: 'Routes' }).click();
    await expect(page.locator('#sheet')).toHaveClass(/at-peek/);
    await expect.poll(() => sheetHeight(page)).toBe(resting);
  });
});

test.describe('the docked panel', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('docks down the left edge on a mouse-width window, and lifts nothing', async ({
    page,
  }) => {
    const panel = await page.locator('#sheet').boundingBox();
    const viewport = page.viewportSize()!;
    expect(panel).not.toBeNull();
    // Full height, on the left, a fixed width — not a bottom sheet stretched to 1280 px.
    expect(panel!.x).toBe(0);
    expect(panel!.height).toBeGreaterThanOrEqual(viewport.height - 1);
    expect(panel!.width).toBeLessThan(viewport.width / 2);
    await expect(page.locator('.sheet-grip')).toBeHidden();

    // Nothing sits at the bottom any more, so nothing is lifted clear of it...
    expect(await sheetHeight(page)).toBe(0);
    // ...and opening a destination doesn't change that: it fills the panel, not the map.
    await openChip(page, 'Routes');
    expect(await sheetHeight(page)).toBe(0);

    // The attribution (ODbL, legally required) is on the map, clear of the panel.
    const attribution = await page.locator('.maplibregl-ctrl-attrib').boundingBox();
    expect(attribution).not.toBeNull();
    expect(attribution!.x).toBeGreaterThanOrEqual(panel!.x + panel!.width);
    expect(attribution!.y + attribution!.height).toBeLessThanOrEqual(viewport.height);
  });
});

test.describe('theme', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('starts dark, and turns light from settings — and remembers it', async ({ page }) => {
    const root = page.locator('html');

    // Dark is the app's own look, whatever the device is set to. The peek row has no
    // theme control at all any more.
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#theme-btn')).toHaveCount(0);

    await page.locator('#settings-btn').click();
    const toggle = page.locator('#light-theme-toggle');
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(root).toHaveAttribute('data-theme', 'light');

    // Stored, not re-derived on every launch: someone who wants the light map on a
    // glaring day should not have to ask for it again at the next screen lock.
    await page.reload();
    await page.locator('#map').waitFor();
    await expect(root).toHaveAttribute('data-theme', 'light');

    await page.locator('#settings-btn').click();
    await expect(page.locator('#light-theme-toggle')).toBeChecked();
    await page.locator('#light-theme-toggle').uncheck();
    await expect(root).toHaveAttribute('data-theme', 'dark');
  });

  test('keeps the app’s own layers across a theme change', async ({ page }) => {
    // Protomaps ships flavours as whole layer sets, so switching means replacing the
    // style — which drops every source and layer the app added on top of it. Losing the
    // summits (or a half-planned route) because someone turned the map dark would be its
    // own bug.
    await expect.poll(async () => (await styleLayers(page)).map((l) => l.id)).toContain(
      'peaks-symbol',
    );

    // Switch away from the default and back, so the style really is replaced twice.
    await page.locator('#settings-btn').click();
    await page.locator('#light-theme-toggle').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#light-theme-toggle').uncheck();
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
    // the map is enlarged, and a specific download is the thing that fixes it. "Scotland"
    // since the catalogue's Great Britain entry was later split into England/Scotland/
    // Wales (infra/regions.json) — check the live catalogue if this drifts again rather
    // than re-guessing which UK region currently covers Ben Nevis.
    await expect(notice).toHaveText(/Limited detail/);
    await expect(notice).toHaveText(/Scotland/);

    // The offered region gets an outline, so "get Scotland" has a visible extent rather
    // than naming a place without showing how much of the screen it covers.
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
