import type { BrowserContext, Page } from '@playwright/test';
import type { Map as MLMap } from 'maplibre-gl';

/**
 * Make `navigator.storage.persist()` succeed.
 *
 * Headless Chromium refuses durable storage — it grants it on site-engagement and
 * installed-PWA heuristics that don't exist in a fresh automated profile, and CDP's
 * `Browser.grantPermissions({durableStorage})` reports success while changing nothing
 * (verified). Without this, the C1 gate correctly refuses every download and no test can
 * reach the downloader at all.
 *
 * The gate's *refusal* is covered separately by unit tests over `evaluateGate`, so
 * stubbing here doesn't paper over untested behaviour.
 */
export async function simulateInstalledPwa(context: BrowserContext): Promise<void> {
  await context.addInitScript(`
    navigator.storage.persist = async () => true;
    navigator.storage.persisted = async () => true;
  `);
}

/**
 * Navigate to the app.
 *
 * Use this rather than `page.goto('/')`: a leading slash resolves against the *origin*,
 * giving `http://host/` instead of `http://host/ratmap/`. Online that survives on a
 * redirect from the preview server, but offline there is no server to redirect and the
 * origin root is outside the service worker's `/ratmap/` scope — so the navigation fails
 * with ERR_INTERNET_DISCONNECTED even though the app shell is fully cached.
 */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('./');
  await page.locator('#map').waitFor();
}

/**
 * Wait until the service worker is activated *and* controlling the page.
 *
 * Both matter before going offline. A freshly-registered worker installs but does not
 * control the page that registered it, so an offline navigation would have nothing
 * serving the app shell and fail with ERR_INTERNET_DISCONNECTED. Precaching also has to
 * finish, or the shell is only partly cached.
 */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    // Not controlling yet — wait for it to take over rather than guessing with a sleep.
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
        once: true,
      });
      // The worker is built with clientsClaim, so on a first install it claims this page
      // as soon as it activates and this fires promptly. Resolve anyway so an
      // already-controlled edge case can't hang the suite.
      if (registration.active && navigator.serviceWorker.controller) resolve();
      setTimeout(resolve, 10_000);
    });
  });

  // A reload guarantees the next navigation is served by the worker.
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
}

/** Names and sizes of everything currently in OPFS. */
export async function listOpfs(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'file') out.push(`${name}: ${(await handle.getFile()).size}`);
    }
    return out.sort();
  });
}

export async function clearOpfs(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const [name] of root.entries()) names.push(name);
    for (const name of names) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  });
}

/**
 * Clear whatever is currently over the map.
 *
 * Toasts expire on their own, so this only has to deal with conditions — which are
 * declared by the app rather than dismissed by the user, and so are cleared through the
 * status centre rather than by clicking anything.
 */
export async function clearConditions(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('#conditions .condition').forEach((el) => el.remove());
    const host = document.querySelector<HTMLElement>('#conditions');
    if (host) host.hidden = true;
  });
}

/** Open the offline-regions sheet and wait for the catalogue to load. */
export async function openRegionsSheet(page: Page): Promise<void> {
  await openChip(page, 'Offline');
  await page.locator('.regions-list .region-row').first().waitFor({ state: 'visible' });
}

/**
 * The region these tests download. Small (~54 MB) and contains Ben Nevis, which the route
 * and peak tests need.
 */
export const TEST_REGION = 'Lochaber';

/**
 * Download {@link TEST_REGION} and wait for completion, i.e. the action button becoming
 * "Delete". Assumes the regions sheet is already open.
 *
 * Searched for by name rather than taken as the first row: the catalogue is ordered by
 * what is near the map, and covers the globe, so "the first row" is a lottery whose
 * losing tickets are several hundred megabytes over the wire.
 */
export async function downloadTestRegion(page: Page): Promise<void> {
  const search = page.locator('.regions-search');
  if (await search.isVisible()) {
    await search.fill(TEST_REGION);
    await page.locator('.regions-list .region-row').first().waitFor({ state: 'visible' });
  }

  const action = page.locator('.region-action').first();
  if ((await action.textContent())?.trim() === 'Delete') return;
  await action.click();
  await action.filter({ hasText: 'Delete' }).waitFor({ timeout: 150_000 });
}

/** Read every layer id currently in the map style. */
export async function styleLayers(page: Page): Promise<Array<{ id: string; type: string }>> {
  return page.evaluate(() => {
    const map = (window as unknown as { __ratmapMap?: MLMap }).__ratmapMap;
    if (!map) return [];
    return map.getStyle().layers.map((l) => ({ id: l.id, type: l.type }));
  });
}

/**
 * Click the map at a geographic position.
 *
 * Projected through the live map rather than taking pixel coordinates, so a test says
 * where on the ground it is tapping and stays correct if the default view changes.
 */
export async function clickMapAt(page: Page, lng: number, lat: number): Promise<void> {
  const point = await page.evaluate(
    ([lngValue, latValue]) => {
      const map = (window as unknown as { __ratmapMap: MLMap }).__ratmapMap;
      const projected = map.project([lngValue, latValue]);
      return { x: projected.x, y: projected.y };
    },
    [lng, lat] as const,
  );

  await page.mouse.click(point.x, point.y);
}

/** Point the map at a bounding box, so subsequent clicks land where intended. */
export async function showArea(
  page: Page,
  bbox: [number, number, number, number],
): Promise<void> {
  await page.evaluate((box) => {
    const map = (window as unknown as { __ratmapMap: MLMap }).__ratmapMap;
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      { padding: 80, duration: 0 },
    );
  }, bbox);
  await page.waitForTimeout(300);
}

export interface PlannerProbe {
  waypoints: number;
  legKinds: Array<'snapped' | 'straight'>;
  distanceM: number;
  pending: number;
  ascentM: number | null;
  coverage: number | null;
  coordCount: number;
}

/** Read the planner's real state, rather than parsing it back out of the panel. */
export async function plannerState(page: Page): Promise<PlannerProbe> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planner = (window as any).__ratmapPlanner;
    const draft = planner.getDraft();
    const profile = planner.getProfile();
    return {
      waypoints: draft.waypointCount,
      legKinds: draft
        .getLegs()
        .filter((leg: unknown) => leg !== null)
        .map((leg: { kind: 'snapped' | 'straight' }) => leg.kind),
      distanceM: draft.totalDistanceM,
      pending: draft.pendingLegs().length,
      ascentM: profile ? profile.ascentM : null,
      coverage: profile ? profile.coverage : null,
      coordCount: draft.coordinates().length,
    };
  });
}

/** Open one of the sheet's destinations from its peek row. */
export async function openChip(page: Page, label: string): Promise<void> {
  await page.locator('#chips .chip', { hasText: label }).click();
  await page.locator('#sheet.at-content, #sheet.at-full').waitFor();
}

/** Open the routes sheet and start a fresh route. */
export async function startNewRoute(page: Page): Promise<void> {
  await openChip(page, 'Routes');
  await page.locator('.routes-toolbar button', { hasText: 'New route' }).click();
  await page.locator('.route-panel-title').waitFor({ state: 'visible' });
}
