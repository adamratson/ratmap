import { expect, test } from '@playwright/test';
import {
  clearOpfs,
  clearConditions,
  downloadTestRegion,
  listOpfs,
  openRegionsSheet,
  gotoApp,
  simulateInstalledPwa,
  styleLayers,
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
    const regionLayers = layers.filter((l) => l.id.startsWith('region-'));

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
      .poll(async () => (await styleLayers(cold)).filter((l) => l.id.startsWith('region-')).length, {
        timeout: 30_000,
      })
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

    await cold.close();
  });
});
