import { expect, test } from '@playwright/test';
import {
  clearOpfs,
  waitForServiceWorkerControl,
  clickMapAt,
  clearConditions,
  openChip,
  downloadTestRegion,
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
//
// Andorra, not Ben Nevis (see TEST_REGION in helpers.ts for why): a real z15 footpath
// running from the Pas de la Casa valley up onto the ridge to its northwest. Verified
// directly against the live router before writing these thresholds — snaps to a real path,
// ~8.2 km, ~608 m of ascent, full terrain coverage, 476 vertices. Numbers below carry
// margin around those measured values, not the values themselves, so a routine basemap or
// terrain rebuild doesn't break the suite over noise.

const TRAILHEAD: [number, number] = [1.7333, 42.5425];
const RIDGE: [number, number] = [1.7, 42.575];
// Taller than the two points need, so the extra room absorbs the route sheet opening
// beneath startNewRoute() and covering the lower ~60% of the screen — otherwise a click
// meant for the map can land on the sheet instead.
const TEST_AREA: [number, number, number, number] = [1.66, 42.45, 1.76, 42.6];
/** A real vertex on the snapped route between {@link TRAILHEAD} and {@link RIDGE}. */
const ON_ROUTE_FIX: [number, number] = [1.715624, 42.548822];

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
    await showArea(page, TEST_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);

    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

    const state = await plannerState(page);
    expect(state.waypoints).toBe(2);
    expect(state.legKinds).toEqual(['straight']);
    // Straight-line distance between the two points is ~4.5 km.
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
    await downloadTestRegion(page);
    await clearConditions(page);

    await showArea(page, TEST_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);

    await expect.poll(async () => (await plannerState(page)).pending, { timeout: 30_000 }).toBe(0);

    const state = await plannerState(page);
    expect(state.legKinds).toEqual(['snapped']);

    // The real path is ~8.2 km, against ~4.5 km straight-line. A route close to the
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
    // for this number to land. The trail climbs ~608 m from the valley to the ridge.
    await openRegionsSheet(page);
    await downloadTestRegion(page);
    await clearConditions(page);

    await showArea(page, TEST_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);

    await expect
      .poll(async () => (await plannerState(page)).ascentM, { timeout: 45_000 })
      .toBeGreaterThan(400);

    const state = await plannerState(page);
    expect(state.ascentM).toBeLessThan(900);
    // Full coverage, or the totals are understated — and the panel would say so.
    expect(state.coverage).toBe(1);

    await expect(page.locator('.route-stats')).toContainText('Ascent');
    await expect(page.locator('svg.profile-chart')).toBeVisible();
  });

  test('undoes an edit', async ({ page }) => {
    await showArea(page, TEST_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);
    await clickMapAt(page, 1.71, 42.56);
    await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);

    await page.locator('.route-actions button', { hasText: 'Undo' }).click();
    await expect.poll(async () => (await plannerState(page)).waypoints).toBe(2);
  });

  test('saves a route and reopens it', async ({ page }) => {
    await showArea(page, TEST_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);
    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

    await page.locator('.route-actions button', { hasText: 'Save' }).click();
    const nameField = page.locator('.route-save-form input');
    await nameField.fill('Andorra test route');
    await page.locator('.route-save-form button').click();

    await expect(page.locator('.toast')).toContainText('Andorra test route');

    // Reopen from a fresh page: the record has to stand alone (C10), with no in-memory
    // state and no network.
    await page.reload();
    await page.locator('#map').waitFor();
    await clearConditions(page);

    await openChip(page, 'Routes');
    await expect(page.locator('.route-name')).toContainText('Andorra test route');

    await page.locator('.route-open').first().click();
    await expect.poll(async () => (await plannerState(page)).coordCount).toBeGreaterThan(1);
  });

  test('imports a GPX file and opens it for following', async ({ page }) => {
    await showArea(page, TEST_AREA);
    await openChip(page, 'Routes');

    // Fabricated track, unrelated to the downloaded catalogue — an import stands on its
    // own geometry (C10) regardless of what regions exist, so any three points will do.
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Imported walk</name><trkseg>
    <trkpt lat="42.5425" lon="1.7333"><ele>1900</ele></trkpt>
    <trkpt lat="42.56" lon="1.71"><ele>2200</ele></trkpt>
    <trkpt lat="42.575" lon="1.70"><ele>2500</ele></trkpt>
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
    await showArea(page, TEST_AREA);
    await startNewRoute(page);

    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);
    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

    await page.locator('.route-actions button', { hasText: 'Follow' }).click();
    // The mode is named in the peek row, where it stays readable with the sheet at rest —
    // a tap on the map means something different in each mode, so it must never be silent.
    await expect(page.locator('#chips .chip-mode')).toHaveText('Following');
    await expect(page.locator('.route-follow')).toBeVisible();

    // Feed a fix roughly on the line: the follower is fed from the location watch in the
    // app, so drive it the same way the watch would.
    await page.evaluate((position) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__ratmapPlanner.updatePosition(position);
    }, ON_ROUTE_FIX);

    await expect(page.locator('.follow-figures')).toContainText('Remaining');
    await expect(page.locator('.follow-progress-fill')).toBeVisible();

    // §7 has to be stated in the product, not only in the plan.
    await expect(
      page.locator('.follow-note').filter({ hasText: /screen on/i }),
    ).toBeVisible();
  });

  test('plans, profiles and follows a route with the network off', async ({ context, page }) => {
    // The Phase 4 acceptance test, end to end: no engine, no server, and no network at
    // all — only the archives already in OPFS.
    await openRegionsSheet(page);
    await downloadTestRegion(page);
    await waitForServiceWorkerControl(page);
    await context.setOffline(true);

    // A fresh page, not a reload: this is the force-quit-and-relaunch case.
    const cold = await context.newPage();
    await gotoApp(cold);
    await clearConditions(cold);
    await showArea(cold, TEST_AREA);

    await startNewRoute(cold);
    await clickMapAt(cold, ...TRAILHEAD);
    await clickMapAt(cold, ...RIDGE);

    await expect
      .poll(async () => (await plannerState(cold)).ascentM, { timeout: 60_000 })
      .toBeGreaterThan(400);

    const state = await plannerState(cold);
    // Snapped to real paths, from tiles read out of OPFS with no connection.
    expect(state.legKinds).toEqual(['snapped']);
    expect(state.distanceM).toBeGreaterThan(6000);

    await cold.locator('.route-actions button', { hasText: 'Follow' }).click();
    await cold.evaluate((position) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__ratmapPlanner.updatePosition(position);
    }, ON_ROUTE_FIX);
    await expect(cold.locator('.follow-figures')).toContainText('Remaining');

    await cold.close();
  });
});
