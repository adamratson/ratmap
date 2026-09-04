import { expect, test, type Page } from '@playwright/test';
import {
  clearConditions,
  clearSavedData,
  clickMapAt,
  gotoApp,
  openChip,
  plannerState,
  preferFileDownloads,
  showArea,
  startNewRoute,
  styleLayers,
} from './helpers';

// The saved-route library and the follow screen. Neither needs a downloaded region: a
// route with no network to snap to is drawn from straight legs (C11) and saved as a
// complete coordinate array (C10), which is exactly what has to survive export, deletion
// and a relaunch.
//
// Same Andorra fixture as route-planning.spec.ts — see the comment there for how these
// coordinates were chosen and verified against the live router.

const TRAILHEAD: [number, number] = [1.7333, 42.5425];
const RIDGE: [number, number] = [1.7, 42.575];
const TEST_AREA: [number, number, number, number] = [1.66, 42.45, 1.76, 42.6];

// Unlike route-planning.spec.ts, this file's "following" tests never download a region
// (same as before this fixture changed — see the file-level comment), so C11's straight-
// line fallback is what actually renders here, not the real snapped path. These fixes are
// measured against *that* line — the snapped-route vertices used in route-planning.spec.ts
// would read as ~740 m off a straight line between the same two endpoints.
/** The line's own arithmetic midpoint. */
const ON_ROUTE_FIX: [number, number] = [1.71665, 42.55875];
/** ~2 km off the line, west of it. */
const OFF_ROUTE_FIX: [number, number] = [1.69, 42.55];
/** A quarter of the way from {@link TRAILHEAD} to {@link RIDGE}, for a "further along" fix. */
const QUARTER_ROUTE_FIX: [number, number] = [1.724975, 42.550625];

/** Plan a two-waypoint route and save it under `name`. */
async function planAndSave(page: Page, name: string): Promise<void> {
  await showArea(page, TEST_AREA);
  await startNewRoute(page);
  await clickMapAt(page, ...TRAILHEAD);
  await clickMapAt(page, ...RIDGE);
  await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

  await page.locator('.route-actions button', { hasText: 'Save' }).click();
  await page.locator('.route-save-form input').fill(name);
  await page.locator('.route-save-form button').click();
  // Filtered rather than a bare locator: toasts stack, and by the second save there is
  // more than one success on screen — both of them correct.
  await expect(page.locator('.toast.ok', { hasText: `Saved “${name}”` })).toBeVisible();
}

test.describe('saved routes', () => {
  test.beforeEach(async ({ context, page }) => {
    await preferFileDownloads(context);
    await gotoApp(page);
    await clearSavedData(page);
    await clearConditions(page);
  });

  test('exports a route as GPX', async ({ page }) => {
    await planAndSave(page, 'Export test');
    await openChip(page, 'Routes');

    const download = page.waitForEvent('download');
    await page.locator('.route-row-actions button', { hasText: 'GPX' }).click();
    const file = await download;

    expect(file.suggestedFilename()).toBe('export-test.gpx');

    const stream = await file.createReadStream();
    const gpx = (await stream.toArray()).join('');

    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('<name>Export test</name>');
    // Every coordinate of the saved geometry, not a reference to it (C10) — an export
    // that leaned on a route id would be unopenable in anything else.
    const points = gpx.match(/<trkpt /g) ?? [];
    expect(points.length).toBe((await plannerState(page)).coordCount);
    // Waypoints ride along, so reopening the file elsewhere keeps the named ends.
    expect((gpx.match(/<wpt /g) ?? []).length).toBe(2);

    await expect(page.locator('.toast.ok', { hasText: 'export-test.gpx' })).toBeVisible();
  });

  test('exports a route as GeoJSON', async ({ page }) => {
    await planAndSave(page, 'Export test');
    await openChip(page, 'Routes');

    const download = page.waitForEvent('download');
    await page.locator('.route-row-actions button', { hasText: 'GeoJSON' }).click();
    const file = await download;

    expect(file.suggestedFilename()).toBe('export-test.geojson');

    const stream = await file.createReadStream();
    const parsed = JSON.parse((await stream.toArray()).join('')) as {
      type: string;
      features: Array<{ geometry: { type: string; coordinates: unknown[] }; properties: { name?: string } }>;
    };

    expect(parsed.type).toBe('FeatureCollection');
    const track = parsed.features.find((f) => f.geometry.type === 'LineString');
    expect(track).toBeDefined();
    expect(track!.properties.name).toBe('Export test');
    expect(track!.geometry.coordinates.length).toBe((await plannerState(page)).coordCount);
  });

  test('shows what a saved route is, without opening it', async ({ page }) => {
    await planAndSave(page, 'Straight test');
    await openChip(page, 'Routes');

    await expect(page.locator('.route-name')).toHaveText('Straight test');
    // C11 again, at rest: a route that fell back to straight lines says so in the list,
    // rather than only while it is open in the planner.
    await expect(page.locator('.route-meta')).toContainText('has straight sections');
    await expect(page.locator('.route-meta')).toContainText(/\d/);
  });

  test('updates the route it has open rather than saving a second copy', async ({ page }) => {
    await planAndSave(page, 'First name');

    // Saving reopens the stored record, so the planner is now editing it rather than a
    // copy — otherwise every Save writes another route with almost the same name.
    await page.locator('.route-actions button', { hasText: 'Save' }).click();
    await page.locator('.route-save-form input').fill('Second name');
    await page.locator('.route-save-form button').click();
    await expect(page.locator('.toast.ok', { hasText: 'Saved “Second name”' })).toBeVisible();

    await openChip(page, 'Routes');
    await expect(page.locator('.route-row')).toHaveCount(1);
    await expect(page.locator('.route-name')).toHaveText('Second name');
  });

  test('deletes a route immediately, and takes it back on Undo', async ({ page }) => {
    await planAndSave(page, 'Doomed route');
    await openChip(page, 'Routes');

    await page.locator('.route-row-actions .place-delete').click();
    await expect(page.locator('.route-row')).toHaveCount(0);
    await expect(page.locator('.places-empty')).toBeVisible();

    const undo = page.locator('.toast .toast-action', { hasText: 'Undo' });
    await expect(undo).toBeVisible();
    await undo.click();

    // Restored, not re-created: one row, same name.
    await expect(page.locator('.route-row')).toHaveCount(1);
    await expect(page.locator('.route-name')).toHaveText('Doomed route');
  });
});

test.describe('following', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await clearSavedData(page);
    await clearConditions(page);

    await showArea(page, TEST_AREA);
    await startNewRoute(page);
    await clickMapAt(page, ...TRAILHEAD);
    await clickMapAt(page, ...RIDGE);
    await expect.poll(async () => (await plannerState(page)).pending).toBe(0);
    await page.locator('.route-actions button', { hasText: 'Follow' }).click();
  });

  /**
   * How many pieces of off-route line the map is actually drawing.
   *
   * Pieces, not lines: `queryRenderedFeatures` answers per tile, so one line across a tile
   * boundary comes back twice. Only "some" versus "none" is meaningful here.
   */
  async function offRouteLinePieces(page: Page): Promise<number> {
    return page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__ratmapMap;
      if (!map.getLayer('route-off-route-line')) return 0;
      return map.queryRenderedFeatures({ layers: ['route-off-route-line'] }).length;
    });
  }

  /** Feed a fix the way the location watch would. */
  async function fix(page: Page, at: [number, number]): Promise<void> {
    await page.evaluate((position) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__ratmapPlanner.updatePosition(position);
    }, at);
  }

  test('says plainly whether you are still on the line', async ({ page }) => {
    // "Am I still on the path" is the whole question on a hill in poor visibility, so it
    // is the loudest thing on the screen and it is never left implicit.
    await fix(page, ON_ROUTE_FIX);
    await expect(page.locator('.follow-state.on')).toContainText('On route');

    await fix(page, OFF_ROUTE_FIX);
    await expect(page.locator('.follow-state.off')).toContainText('Off route');
    await expect(page.locator('.follow-note', { hasText: /dashed red line/ })).toBeVisible();

    // The way back is drawn, not just described. Asked of the rendered map rather than of
    // the source, because "the line exists in a GeoJSON blob" is not the claim the note
    // makes to someone looking at the screen.
    await expect
      .poll(async () => (await styleLayers(page)).map((l) => l.id))
      .toContain('route-off-route-line');
    await expect.poll(async () => offRouteLinePieces(page)).toBeGreaterThan(0);

    await fix(page, ON_ROUTE_FIX);
    await expect(page.locator('.follow-state.on')).toBeVisible();
    // And taken away again once you are back on it — a stale line pointing at where you
    // used to be off route is worse than none.
    await expect.poll(async () => offRouteLinePieces(page)).toBe(0);
  });

  test('counts down what is left, and waits before claiming anything', async ({ page }) => {
    // Before any fix there is nothing honest to report — a distance of "0 m remaining"
    // from a position we do not have would be worse than saying nothing.
    await expect(page.locator('.follow-waiting')).toContainText(/Waiting for a position fix/);

    await fix(page, TRAILHEAD);
    await expect(page.locator('.follow-figures')).toContainText('Remaining');
    await expect(page.locator('.follow-figures')).toContainText('Done');

    const nearStart = await page.locator('.follow-progress-fill').evaluate((el) => el.style.width);

    await fix(page, QUARTER_ROUTE_FIX);
    await expect
      .poll(async () => page.locator('.follow-progress-fill').evaluate((el) => el.style.width))
      .not.toBe(nearStart);
  });

  test('returns to planning when following stops', async ({ page }) => {
    await fix(page, ON_ROUTE_FIX);
    await expect(page.locator('#chips .chip-mode')).toHaveText('Following');

    await page.locator('.route-actions button', { hasText: 'Stop following' }).click();

    // Back to the planner with the route intact, not back to an empty map.
    await expect(page.locator('#chips .chip-mode')).toHaveText('Planning');
    await expect(page.locator('.route-panel-body')).toBeVisible();
    expect((await plannerState(page)).waypoints).toBe(2);
  });
});
