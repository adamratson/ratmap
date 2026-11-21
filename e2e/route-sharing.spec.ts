import { expect, test, type Page } from '@playwright/test';
import {
  clearConditions,
  clearSavedData,
  clickMapAt,
  discardRoute,
  gotoApp,
  mapView,
  openChip,
  plannerState,
  showArea,
  startNewRoute,
  waitForServiceWorkerControl,
} from './helpers';

// Route links, plans/route-sharing.md Stage B. None of this downloads a region: what a link
// has to do is work for the person who does not have the map yet. Waypoints with no network
// under them make straight legs (C11), which is also what has to survive the trip.

const TRAILHEAD: [number, number] = [1.7333, 42.5425];
const MIDDLE: [number, number] = [1.72, 42.56];
const RIDGE: [number, number] = [1.7, 42.575];
const TEST_AREA: [number, number, number, number] = [1.66, 42.45, 1.76, 42.6];

/** Plan a three-waypoint route and read its link off the Share dialog. */
async function linkFromPlanner(page: Page, { keep = false } = {}): Promise<string> {
  await showArea(page, TEST_AREA);
  await startNewRoute(page);
  await clickMapAt(page, ...TRAILHEAD);
  await clickMapAt(page, ...MIDDLE);
  await clickMapAt(page, ...RIDGE);
  await expect.poll(async () => (await plannerState(page)).pending).toBe(0);

  await page.locator('.route-actions button', { hasText: 'Share' }).click();
  await expect(page.locator('.share-dialog')).toContainText('can’t be taken back');

  // Headless Chromium has no share sheet, so this lands on the clipboard stub.
  await page.locator('.share-actions button', { hasText: 'Send link' }).click();
  await expect(page.locator('.toast.ok', { hasText: 'Copied link' })).toBeVisible();
  const link = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
  // Off the map, and so not brought back on the next load: these tests are about what the
  // link opens, not the route the app keeps across a reload.
  if (!keep) await discardRoute(page);
  return link;
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __copied: string }).__copied = text;
        },
      },
    });
  });
  await gotoApp(page);
  await clearSavedData(page);
  await clearConditions(page);
});

test('a link opens the same route, with the same leg kinds and the exact distance', async ({
  page,
}) => {
  const link = await linkFromPlanner(page, { keep: true });
  expect(link).toMatch(/#r=[A-Za-z0-9_-]+$/);
  const sent = await plannerState(page);
  await discardRoute(page);

  await page.goto('about:blank');
  await page.goto(link);

  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);
  const received = await plannerState(page);
  expect(received.legKinds).toEqual(sent.legKinds);
  expect(received.distanceM).toBeCloseTo(sent.distanceM, 0);

  await expect(page.locator('.route-received')).toContainText('Shared route');
  await expect(page.locator('.route-received button', { hasText: 'Save as GPX' })).toBeVisible();
  await expect(page.locator('.route-received button', { hasText: 'Copy link' })).toBeVisible();
});

test('the fragment is cleared once read, so a reload does not open the route again', async ({
  page,
}) => {
  const link = await linkFromPlanner(page);
  await page.goto('about:blank');
  await page.goto(link);
  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);

  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await page.locator('#map').waitFor();
  expect((await plannerState(page)).waypoints).toBe(0);
});

test('the map moves to a route opened from a link', async ({ page }) => {
  const link = await linkFromPlanner(page);
  await page.goto('about:blank');
  await page.goto(link);
  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);

  await expect
    .poll(async () => {
      const { lng, lat } = await mapView(page);
      return Math.abs(lng - MIDDLE[0]) < 0.2 && Math.abs(lat - MIDDLE[1]) < 0.2;
    })
    .toBe(true);
});

test('a link opens on an offline cold start', async ({ page, context }) => {
  const link = await linkFromPlanner(page);
  await waitForServiceWorkerControl(page);

  await page.goto('about:blank');
  await context.setOffline(true);
  await page.goto(link);

  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);
  await expect(page.locator('.route-received')).toContainText('Shared route');
});

test('a damaged link says so and loads nothing', async ({ page }) => {
  const link = await linkFromPlanner(page);
  await page.goto('about:blank');
  await page.goto(link.slice(0, -5));

  await expect(page.locator('.toast', { hasText: 'damaged' })).toBeVisible();
  expect((await plannerState(page)).waypoints).toBe(0);
});

test('a link from a later ratmap asks for an update, and stays in the address', async ({ page }) => {
  // Version byte 2, whatever follows: refused on the version alone. "Ag" is that byte in
  // base64url, padded out past the minimum length.
  await page.goto('about:blank');
  await page.goto('/ratmap/#r=AgEAAAAAAAAAAAAA');

  await expect(page.locator('.toast', { hasText: 'newer version of ratmap' })).toBeVisible();
  expect((await plannerState(page)).waypoints).toBe(0);
  expect(new URL(page.url()).hash).toContain('r=');
});

test('a link into a running app replaces the plan, and Undo brings it back', async ({ page }) => {
  const link = await linkFromPlanner(page);

  await page.goto('about:blank');
  await gotoApp(page);
  await showArea(page, TEST_AREA);
  await startNewRoute(page);
  await clickMapAt(page, ...TRAILHEAD);
  await clickMapAt(page, ...RIDGE);
  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(2);

  await page.evaluate((hash) => {
    location.hash = hash;
  }, new URL(link).hash);

  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);
  await page.locator('.toast button', { hasText: 'Undo' }).click();
  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(2);
});

test('a link pasted into the Routes sheet opens the route', async ({ page }) => {
  const link = await linkFromPlanner(page);
  await page.goto('about:blank');
  await gotoApp(page);

  await openChip(page, 'Routes');
  await page.locator('.routes-toolbar button', { hasText: 'Paste a route' }).click();
  await page.locator('.route-paste-form textarea').fill(link);
  await page.locator('.route-paste-form button').click();

  await expect.poll(async () => (await plannerState(page)).waypoints).toBe(3);
});
