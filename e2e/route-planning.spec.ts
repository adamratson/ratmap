import { expect, test } from '@playwright/test';
import {
  clearOpfs,
  waitForServiceWorkerControl,
  clickMapAt,
  clearConditions,
  downloadFirstRegion,
  gotoApp,
  openRegionsSheet,
  plannerState,
  showArea,
  simulateInstalledPwa,
  startNewRoute,
  styleLayers,
} from './helpers';

// Phase 4 acceptance, run against the production build with no routing engine anywhere in
// the picture: the network comes out of the downloaded region's own basemap tiles and the
// elevation out of its terrain tiles.

/** Ben Nevis: the Achintee end of the Mountain Path, and the summit. */
const ACHINTEE: [number, number] = [-5.0765, 56.8094];
const SUMMIT: [number, number] = [-5.0037, 56.7969];
const BEN_NEVIS_AREA: [number, number, number, number] = [-5.1, 56.78, -4.98, 56.82];

test.describe('route planning', () => {
  test.beforeEach(async ({ context, page }) => {
    await simulateInstalledPwa(context);
    await gotoApp(page);
    await clearOpfs(page);
    await clearConditions(page);
  });

  test('places waypoints and draws a route with no region downloaded', async ({ page }) => {
    // C11: waypoint placement must not require a successful snap. With no region there is
    // no network to snap to at all, and editing still has to work.
    await showArea(page, BEN_NEVIS_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...ACHINTEE);
    await clickMapAt(page, ...SUMMIT);

    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

    const state = await plannerState(page);
    expect(state.waypoints).toBe(2);
    expect(state.legKinds).toEqual(['straight']);
    expect(state.distanceM).toBeGreaterThan(4000);

    // The straight leg is drawn, and flagged in the panel rather than passed off as a path.
    const layers = await styleLayers(page);
    expect(layers.some((l) => l.id === 'route-line')).toBe(true);
    // Filtered rather than a bare locator: with no region the panel also warns that the
    // profile needs one, so two notes are on screen and both are correct.
    await expect(
      page.locator('.route-note.warn').filter({ hasText: /straight lines, not paths/i }),
    ).toBeVisible();
  });

  test('routes along real paths from the downloaded region', async ({ page }) => {
    await openRegionsSheet(page);
    await downloadFirstRegion(page);
    await clearConditions(page);

    await showArea(page, BEN_NEVIS_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...ACHINTEE);
    await clickMapAt(page, ...SUMMIT);

    await expect.poll(async () => (await plannerState(page)).pending, { timeout: 30_000 }).toBe(0);

    const state = await plannerState(page);
    expect(state.legKinds).toEqual(['snapped']);

    // The pony track is ~7.5 km, against ~4.6 km straight-line. A route close to the
    // straight-line distance would mean it fell back without saying so.
    expect(state.distanceM).toBeGreaterThan(6000);
    expect(state.distanceM).toBeLessThan(12_000);
    // A snapped route follows tile geometry, so it has hundreds of vertices, not two.
    expect(state.coordCount).toBeGreaterThan(100);
  });

  test('computes an elevation profile offline from the region terrain archive', async ({
    page,
  }) => {
    // The headline Phase 4 capability, and the one that is easy to get subtly wrong: the
    // terrarium decode, the tile maths and the ascent filter all have to be right at once
    // for this number to land. Ben Nevis is 1345 m from a start near sea level.
    await openRegionsSheet(page);
    await downloadFirstRegion(page);
    await clearConditions(page);

    await showArea(page, BEN_NEVIS_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...ACHINTEE);
    await clickMapAt(page, ...SUMMIT);

    await expect
      .poll(async () => (await plannerState(page)).ascentM, { timeout: 45_000 })
      .toBeGreaterThan(1100);

    const state = await plannerState(page);
    expect(state.ascentM).toBeLessThan(1700);
    // Full coverage, or the totals are understated — and the panel would say so.
    expect(state.coverage).toBe(1);

    await expect(page.locator('.route-stats')).toContainText('Ascent');
    await expect(page.locator('svg.profile-chart')).toBeVisible();
  });

  test('undoes an edit', async ({ page }) => {
    await showArea(page, BEN_NEVIS_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...ACHINTEE);
    await clickMapAt(page, ...SUMMIT);
    await clickMapAt(page, -5.02, 56.81);
    await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);

    await page.locator('.route-actions button', { hasText: 'Undo' }).click();
    await expect.poll(async () => (await plannerState(page)).waypoints).toBe(2);
  });

  test('saves a route and reopens it', async ({ page }) => {
    await showArea(page, BEN_NEVIS_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...ACHINTEE);
    await clickMapAt(page, ...SUMMIT);
    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

    await page.locator('.route-actions button', { hasText: 'Save' }).click();
    const nameField = page.locator('.route-save-form input');
    await nameField.fill('Ben Nevis test route');
    await page.locator('.route-save-form button').click();

    await expect(page.locator('.toast')).toContainText('Ben Nevis test route');

    // Reopen from a fresh page: the record has to stand alone (C10), with no in-memory
    // state and no network.
    await page.reload();
    await page.locator('#map').waitFor();
    await clearConditions(page);

    await page.locator('#routes-btn').click();
    await expect(page.locator('.route-name')).toContainText('Ben Nevis test route');

    await page.locator('.route-open').first().click();
    await expect.poll(async () => (await plannerState(page)).coordCount).toBeGreaterThan(1);
  });

  test('imports a GPX file and opens it for following', async ({ page }) => {
    await showArea(page, BEN_NEVIS_AREA);
    await page.locator('#routes-btn').click();

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Imported walk</name><trkseg>
    <trkpt lat="56.8094" lon="-5.0765"><ele>30</ele></trkpt>
    <trkpt lat="56.8030" lon="-5.0400"><ele>600</ele></trkpt>
    <trkpt lat="56.7969" lon="-5.0037"><ele>1345</ele></trkpt>
  </trkseg></trk>
</gpx>`;

    await page.locator('.route-import input[type=file]').setInputFiles({
      name: 'imported-walk.gpx',
      mimeType: 'application/gpx+xml',
      buffer: Buffer.from(gpx),
    });

    await expect(page.locator('.toast')).toContainText('Imported walk');
    await expect.poll(async () => (await plannerState(page)).coordCount).toBe(3);

    // An import must not be re-routed — the imported geometry is the route (C10).
    const state = await plannerState(page);
    expect(state.legKinds).toEqual(['snapped']);
    expect(state.distanceM).toBeGreaterThan(4000);
  });

  test('follows a route against a simulated position', async ({ context, page }) => {
    await context.grantPermissions(['geolocation']);
    await showArea(page, BEN_NEVIS_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...ACHINTEE);
    await clickMapAt(page, ...SUMMIT);
    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

    await page.locator('.route-actions button', { hasText: 'Follow' }).click();
    await expect(page.locator('.route-panel-title')).toHaveText('Following');

    // Feed a fix roughly on the line: the follower is fed from the location watch in the
    // app, so drive it the same way the watch would.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__ratmapPlanner.updatePosition([-5.04, 56.803]);
    });

    await expect(page.locator('.route-stats')).toContainText('Remaining');
    await expect(page.locator('.route-progress-fill')).toBeVisible();

    // §7 has to be stated in the product, not only in the plan.
    await expect(
      page.locator('.route-note').filter({ hasText: /screen is on/i }),
    ).toBeVisible();
  });

  test('plans, profiles and follows a route with the network off', async ({ context, page }) => {
    // The Phase 4 acceptance test, end to end: no engine, no server, and no network at
    // all — only the archives already in OPFS.
    await openRegionsSheet(page);
    await downloadFirstRegion(page);
    await waitForServiceWorkerControl(page);
    await context.setOffline(true);

    // A fresh page, not a reload: this is the force-quit-and-relaunch case.
    const cold = await context.newPage();
    await gotoApp(cold);
    await clearConditions(cold);
    await showArea(cold, BEN_NEVIS_AREA);

    await startNewRoute(cold);
    await clickMapAt(cold, ...ACHINTEE);
    await clickMapAt(cold, ...SUMMIT);

    await expect
      .poll(async () => (await plannerState(cold)).ascentM, { timeout: 60_000 })
      .toBeGreaterThan(1100);

    const state = await plannerState(cold);
    // Snapped to real paths, from tiles read out of OPFS with no connection.
    expect(state.legKinds).toEqual(['snapped']);
    expect(state.distanceM).toBeGreaterThan(6000);

    await cold.locator('.route-actions button', { hasText: 'Follow' }).click();
    await cold.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__ratmapPlanner.updatePosition([-5.04, 56.803]);
    });
    await expect(cold.locator('.route-stats')).toContainText('Remaining');

    await cold.close();
  });
});
