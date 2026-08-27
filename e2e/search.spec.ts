import { expect, test } from '@playwright/test';
import {
  clearConditions,
  gotoApp,
  mapView,
  searchFor,
  waitForServiceWorkerControl,
} from './helpers';

// C9: search is a local SQLite FTS5 index shipped with the app — no geocoding API, no key,
// no quota, and the query never leaves the device. The point of testing it end to end is
// that "works offline" is not a property of the query code: it depends on the index being
// precached by the service worker and on the wasm runtime loading with no network at all.

/** The one place in the index whose name starts with these letters. Checked, not assumed. */
const BEN_NEVIS = { name: 'Ben Nevis', lng: -5.003526, lat: 56.7968582 };

test.describe('search', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearConditions(page);
  });

  test('finds a summit by name, with what it is and where it is', async ({ page }) => {
    await searchFor(page, 'Ben Nev');

    const first = page.locator('#search-results li').first();
    await expect(first.locator('.result-name')).toHaveText(BEN_NEVIS.name);

    // Kind and height come from the index; distance and bearing are computed against the
    // viewport centre. All three matter: Scotland has several Ben Mores, and without the
    // distance they render as identical rows.
    await expect(first.locator('.result-meta')).toHaveText(/^peak · 1345 m · .+ (N|NE|E|SE|S|SW|W|NW)$/);
  });

  test('takes the map to a chosen result', async ({ page }) => {
    const before = await mapView(page);
    expect(before.zoom).toBeLessThan(11);

    await searchFor(page, 'Ben Nev');
    await page.locator('#search-results li button').first().click();

    // easeTo is animated, so poll rather than reading once.
    await expect
      .poll(async () => {
        const view = await mapView(page);
        return Math.max(
          Math.abs(view.lng - BEN_NEVIS.lng),
          Math.abs(view.lat - BEN_NEVIS.lat),
        );
      })
      .toBeLessThan(0.01);

    // Zoomed in far enough to be useful — a jump that kept z6 would land you on the
    // right pixel of a blurry map. Polled, not read once: easeTo is still animating when
    // the centre arrives, and a zoom caught a frame early reads 10.9994.
    await expect.poll(async () => (await mapView(page)).zoom).toBeGreaterThanOrEqual(11);
    await expect(page.locator('#search-results')).toBeHidden();
  });

  test('says so when nothing matches, rather than showing an empty list', async ({ page }) => {
    await searchFor(page, 'qqzzxx');
    await expect(page.locator('#search-results .search-empty')).toHaveText('No matches');
  });

  test('abandons a search on Escape without closing the sheet', async ({ page }) => {
    await searchFor(page, 'Ben Nev');

    await page.keyboard.press('Escape');
    await expect(page.locator('#search-results')).toBeHidden();
    // Escape means "abandon this search" here, not "close the sheet I am typing into":
    // the peek row with the search field in it must survive.
    await expect(page.locator('#search-input')).toBeVisible();
  });

  test('does not answer a single letter', async ({ page }) => {
    // A one-character prefix matches a large fraction of the index, and answering it would
    // put a wall of unranked results under the field on the first keystroke.
    //
    // Backwards from a query that *did* answer, so this cannot pass merely because the
    // list starts hidden: deleting back to one letter has to take the answer away again.
    await searchFor(page, 'Ben Nev');
    await page.locator('#search-input').fill('b');
    await expect(page.locator('#search-results')).toBeHidden();
  });

  test('searches on a cold offline start', async ({ context, page }) => {
    // The C9 acceptance: index and wasm runtime both have to come out of the service
    // worker's precache, with no server to fall back to.
    await waitForServiceWorkerControl(page);
    await context.setOffline(true);

    // A fresh page, not a reload — this is the force-quit-and-relaunch case.
    const cold = await context.newPage();
    await gotoApp(cold);
    await clearConditions(cold);

    await searchFor(cold, 'Ben Nev');
    await expect(cold.locator('#search-results .result-name').first()).toHaveText(BEN_NEVIS.name);

    await cold.close();
  });
});
