import { expect, test } from '@playwright/test';
import {
  clearOpfs,
  clearConditions,
  downloadTestRegion,
  jumpTo,
  listOpfs,
  openRegionsSheet,
  gotoApp,
  simulateInstalledPwa,
  regionArchiveLayers,
  styleLayers,
  TEST_REGION,
  waitForServiceWorkerControl,
} from './helpers';

test.describe('offline regions', () => {
  test.beforeEach(async ({ context, page }) => {
    await simulateInstalledPwa(context);
    await gotoApp(page);
    await clearOpfs(page);
    await clearConditions(page);
  });

  test('a downloaded region does not black out the rest of the map', async ({ page }) => {
    // Regression: Protomaps' layers() emits a viewport-filling `background` layer. The
    // region layer code copied all of them, so a downloaded region added its *own*
    // background on top of the global basemap and painted flat #cccccc over everything
    // outside the region — the map appeared to go grey after a successful download.
    await openRegionsSheet(page);
    await downloadTestRegion(page);

    const layers = await styleLayers(page);
    const regionLayers = await regionArchiveLayers(page);

    expect(regionLayers.length).toBeGreaterThan(0);
    expect(regionLayers.filter((l) => l.type === 'background')).toEqual([]);

    // Exactly one background in the whole style, from the global basemap.
    expect(layers.filter((l) => l.type === 'background')).toHaveLength(1);
  });

  test('keeps labels above the region relief and contours', async ({ page }) => {
    // Regression: region artifacts were all inserted at the peaks layer, which stacks each
    // on top of the last. Artifacts load basemap → contours → terrain, so the hillshade
    // ended up over the basemap's own labels and washed out gully and corrie names.
    await openRegionsSheet(page);
    await downloadTestRegion(page);

    const layers = await styleLayers(page);
    const ids = layers.map((l) => l.id);
    const firstRegionLabel = layers.findIndex(
      (l) => l.type === 'symbol' && l.id.startsWith('region-'),
    );
    expect(firstRegionLabel).toBeGreaterThan(-1);

    for (const l of layers) {
      if (l.type !== 'hillshade' && !l.id.endsWith('contours-lines')) continue;
      if (!l.id.startsWith('region-')) continue;
      expect(ids.indexOf(l.id)).toBeLessThan(firstRegionLabel);
    }
  });

  test('downloads every artifact the manifest declares, into OPFS', async ({ page }) => {
    await openRegionsSheet(page);
    await downloadTestRegion(page);

    const files = await listOpfs(page);

    // C16: artifacts are open-ended, so assert on what the row advertises rather than a
    // hardcoded list — adding a new artifact kind must not require editing this test.
    const advertised = (await page.locator('.region-meta').first().textContent()) ?? '';
    for (const kind of ['basemap', 'terrain', 'contours']) {
      if (!advertised.includes(kind)) continue;
      expect(files.some((f) => f.includes(`-${kind}.pmtiles`))).toBe(true);
    }

    // C3: OPFS keys are the unique artifact filenames, region-prefixed.
    for (const file of files) {
      expect(file).toMatch(/^[a-z0-9-]+-(basemap|terrain|contours)\.pmtiles: \d+$/);
    }
  });

  test('leaves no stray writable swap files behind', async ({ page }) => {
    // Regression: an interrupted OPFS write stranded Chromium's "<name>.N.crswap" swap
    // file, leaking megabytes into the exact storage this feature exists to manage.
    await openRegionsSheet(page);
    await downloadTestRegion(page);

    const files = await listOpfs(page);
    expect(files.filter((f) => f.includes('.crswap'))).toEqual([]);
    expect(files.filter((f) => f.includes('.part'))).toEqual([]);
  });

  test('deletes a region only on a second, deliberate tap', async ({ page }) => {
    await openRegionsSheet(page);
    await downloadTestRegion(page);

    const action = page.locator('.region-action').first();

    // Two taps, not one. This button sits in the slot every other row uses for
    // "Download", and the mistake costs re-downloading the whole region — which on a hill
    // is not a mistake you can undo.
    await action.click();
    // The second tap names the size, so the cost is visible at the moment of confirming.
    await expect(action).toHaveText(/^Delete [\d.]+ MB\?$/);

    // An armed delete left sitting there is a trap for the next tap, and the next tap is
    // often someone scrolling back to this row — so it disarms itself.
    await expect(action).toHaveText('Delete', { timeout: 15_000 });
    expect(await listOpfs(page)).not.toEqual([]);

    await action.click();
    await expect(action).toHaveText(/\?$/);
    await action.click();

    await expect(page.locator('.toast.ok', { hasText: /^Deleted / })).toBeVisible();

    // Gone from the device and off the map, not merely delisted.
    await expect.poll(async () => listOpfs(page)).toEqual([]);
    await expect.poll(async () => (await regionArchiveLayers(page)).length).toBe(0);
    await expect(page.locator('.region-action').first()).toHaveText('Download');
  });

  test('renders the region from OPFS after an offline cold start', async ({ context, page }) => {
    await openRegionsSheet(page);
    await downloadTestRegion(page);

    // The app shell has to be cached and the worker in control before the network goes,
    // or the offline navigation has nothing serving it.
    await waitForServiceWorkerControl(page);
    await context.setOffline(true);

    // A fresh page, not a reload — this is the force-quit-and-relaunch case.
    const cold = await context.newPage();
    await gotoApp(cold);

    // Region layers must be restored with no user action and no network.
    await expect
      .poll(async () => (await regionArchiveLayers(cold)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);

    await cold.close();
  });

  test('reports lost connection once, not once per failed tile', async ({ context, page }) => {
    await waitForServiceWorkerControl(page);
    await context.setOffline(true);
    const cold = await context.newPage();
    await gotoApp(cold);

    // MapLibre raises one error per failed tile; without deduping these buried the map.
    // As a keyed condition, the twentieth failure replaces the first rather than adding
    // a twentieth banner.
    const offline = cold.locator('#conditions .condition', { hasText: /no connection/i });
    await expect(offline).toHaveCount(1, { timeout: 30_000 });

    // And it stays up. It used to be retracted within a couple of milliseconds by a
    // source reporting itself "loaded" having loaded nothing — so a banner that is
    // present once is not evidence that anyone could read it.
    await cold.waitForTimeout(3000);
    await expect(offline).toHaveCount(1);

    await cold.close();
  });

  test('takes the notice back down when tiles actually arrive again', async ({
    context,
    page,
  }) => {
    // The other half of the same contract: the warning has to go when the signal returns,
    // or the fix above would just be a banner that never leaves.
    await context.setOffline(true);
    await jumpTo(page, [10.0, 46.0], 5);

    const offline = page.locator('#conditions .condition', { hasText: /no connection/i });
    await expect(offline).toHaveCount(1, { timeout: 30_000 });

    await context.setOffline(false);
    // Ground this page has not asked for before: MapLibre does not retry a tile it has
    // already given up on, so panning back over the failures would prove nothing.
    await jumpTo(page, [-70.0, -33.0], 4);

    await expect(offline).toHaveCount(0, { timeout: 30_000 });
  });
});

test.describe('the region catalogue', () => {
  test.beforeEach(async ({ context, page }) => {
    await simulateInstalledPwa(context);
    await gotoApp(page);
    await clearOpfs(page);
    await clearConditions(page);
  });

  test('offers what covers the ground you are looking at', async ({ page }) => {
    await openRegionsSheet(page);

    // The catalogue covers the globe, so listing it is not a list — it is a wall. What
    // someone opening this sheet almost always wants is the ground on screen, so before
    // anything is typed the list is the handful of regions nearest the map, not all 391.
    const nearScotland = await page.locator('.region-name').allTextContents();
    expect(nearScotland.length).toBeGreaterThan(0);
    expect(nearScotland.length).toBeLessThan(20);

    // And it follows the map: panning to the valley you want to download has to change
    // the answer, or the list is only ever answering for wherever the sheet was opened.
    await jumpTo(page, [11.35, 46.5], 8);
    await expect
      .poll(async () => page.locator('.region-name').allTextContents())
      .not.toEqual(nearScotland);
  });

  test('searches the rest of the catalogue by name', async ({ page }) => {
    await openRegionsSheet(page);

    await page.locator('.regions-search').fill(TEST_REGION);
    await expect(page.locator('.regions-hint')).toHaveText('1 match.');
    await expect(page.locator('.region-name')).toHaveText(/Lochaber/);
    // Size and artifacts up front: this is a decision about megabytes on a phone.
    await expect(page.locator('.region-meta')).toHaveText(/MB · .*basemap/);

    await page.locator('.regions-search').fill('zzzznowhere');
    await expect(page.locator('.regions-hint')).toHaveText('No region matches that name.');
    await expect(page.locator('.region-row')).toHaveCount(0);
  });
});

test.describe('without persistent storage (C1)', () => {
  // Deliberately no simulateInstalledPwa: this is the real headless behaviour, and it is
  // the same state a user is in before installing to their home screen.
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearOpfs(page);
  });

  test('says why downloads are off, and refuses to start one', async ({ page }) => {
    // A condition rather than a toast: it is currently true and stays true until the user
    // does something about it.
    await expect(
      page.locator('#conditions .condition', { hasText: /can’t keep maps safely/ }),
    ).toBeVisible();

    await openRegionsSheet(page);
    await page.locator('.regions-search').fill(TEST_REGION);
    await page.locator('.region-action').first().click();

    // Refused with a reason, never a silent no-op and never a download that the browser
    // may evict without warning — the user would find that out with no signal, on a hill.
    await expect(
      page.locator('.toast.warn', { hasText: /Persistent storage has not been granted/ }),
    ).toBeVisible();
    await expect(page.locator('.region-action').first()).toHaveText('Download');
    expect(await listOpfs(page)).toEqual([]);
  });
});
