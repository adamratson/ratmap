import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  clearConditions,
  clearOpfs,
  downloadTestRegion,
  focusTestRegionRow,
  gotoApp,
  openRegionsSheet,
  searchFor,
  simulateInstalledPwa,
} from './helpers';

// A region's search index comes down with the region, and search covers what is on the
// device: the global fallback shipped with the app holds only cities, towns and the
// best-known summits, and a village is findable once its region is downloaded.
//
// The live catalogue publishes Andorra's index, and then the whole region, index included,
// is the real bucket's, so the download itself is exactly the app's. Only if the catalogue
// has no index does the test add one from e2e/fixtures: a real one, built from Andorra's
// OSM extract by infra/scripts/build-places.sh (2026-09-28), listed the way build-manifest
// publishes it.
//
// Never the fixture in place of a published index: the catalogue then lists the bucket's
// file, a different size, and the download of a fixture that ends short of it never
// completes — how this test failed once the catalogue began shipping the index
// (2026-10-28).

const INDEX_FILE = 'andorra-places-1.sqlite';
const INDEX = readFileSync(new URL(`./fixtures/${INDEX_FILE}`, import.meta.url));
/** An Andorran village: in the region's index, and in no fallback index. */
const VILLAGE = 'Arinsal';
const NO_REGION_HINT = 'No matches. Villages and smaller summits come with a downloaded region.';

/** Serve `body` for a request with a Range header, as the bucket does (206, ETag). */
async function fulfilRange(route: Route, body: Buffer): Promise<void> {
  const match = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range ?? '');
  if (!match) {
    await route.fulfill({ status: 200, body, headers: { 'Content-Type': 'application/octet-stream' } });
    return;
  }
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), body.length - 1);
  await route.fulfill({
    status: 206,
    body: body.subarray(start, end + 1),
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Accept-Ranges': 'bytes',
      ETag: '"andorra-places-fixture"',
      'Access-Control-Expose-Headers': 'ETag, Content-Range',
    },
  });
}

/** Publish the fixture index as one of Andorra's artifacts, unless the catalogue has one. */
async function publishIndex(page: Page): Promise<void> {
  await page.route('**/regions/manifest.json', async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    const andorra = manifest.regions.find((region: { id: string }) => region.id === 'andorra');
    const artifacts: Array<{ kind: string }> = andorra.artifacts;
    if (!artifacts.some((artifact) => artifact.kind === 'places')) {
      artifacts.push({
        kind: 'places',
        filename: INDEX_FILE,
        path: `regions/andorra/${INDEX_FILE}`,
        bytes: INDEX.length,
      } as { kind: string });
      andorra.totalBytes += INDEX.length;
      // Routed before the catalogue is answered, so it is in place before any download.
      await page.route(`**/regions/andorra/${INDEX_FILE}`, (indexRoute) =>
        fulfilRange(indexRoute, INDEX),
      );
    }
    await route.fulfill({ response, json: manifest });
  });
}

test.describe('search across downloaded regions', () => {
  test.beforeEach(async ({ context, page }) => {
    await simulateInstalledPwa(context);
    await publishIndex(page);
    await gotoApp(page);
    await clearOpfs(page);
    await clearConditions(page);
  });

  test('finds a village once its region is downloaded, and not after it is deleted', async ({ page }) => {
    await searchFor(page, VILLAGE);
    await expect(page.locator('#search-results')).toHaveText(NO_REGION_HINT);
    await page.keyboard.press('Escape');

    await openRegionsSheet(page);
    await downloadTestRegion(page);

    await searchFor(page, VILLAGE);
    // Among the results, not necessarily first: they are ordered by distance from the map
    // centre, and Port d'Arinsal, the pass above the village, matches too.
    const village = page.locator('#search-results li').filter({
      has: page.locator('.result-name', { hasText: new RegExp(`^${VILLAGE}$`) }),
    });
    await expect(village.locator('.result-meta')).toHaveText(/^village · /);
    // The first Escape dismisses the results, the second the regions sheet still open
    // behind them — reopening it from its chip would otherwise toggle it shut.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Delete is two taps: the second confirms.
    await openRegionsSheet(page);
    await focusTestRegionRow(page);
    const action = page.locator('.region-action').first();
    await action.click();
    await action.click();
    await expect(action).toHaveText(/Download/);

    await searchFor(page, VILLAGE);
    await expect(page.locator('#search-results')).toHaveText(NO_REGION_HINT);
  });
});
