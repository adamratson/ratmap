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
 * How long to wait for {@link TEST_REGION} to come down.
 *
 * Generous, because the wire is the slow part and not under our control: network
 * conditions in CI or on a slow connection vary, and no timeout makes an actually-stuck
 * download pass, so the point of the limit is to fail promptly and say why, not to outlast
 * a real hang. (Previously sized around the R2 `.r2.dev` dev URL's documented rate limit —
 * Krystal's bucket carries no equivalent documented throttle, but the generous budget is
 * kept for the same reason: the wire, not the app, is usually the slow part.)
 */
const DOWNLOAD_TIMEOUT_MS = 240_000;

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

  try {
    await action.filter({ hasText: 'Delete' }).waitFor({ timeout: DOWNLOAD_TIMEOUT_MS });
  } catch (cause) {
    // A bare Playwright timeout here reads as "the button never changed", which sends you
    // looking for a UI bug. It is almost always the bucket. The downloader keeps its
    // running total in the button's title, so report how far it actually got — a download
    // stuck at 2 MB of 53 MB is a throughput problem, one stuck at 0 is not.
    const progress = (await action.getAttribute('title')) ?? 'no progress reported';
    throw new Error(
      `${TEST_REGION} did not finish downloading within ${DOWNLOAD_TIMEOUT_MS / 1000}s ` +
        `(${progress}). Check bucket/network throughput before treating this as an app ` +
        'failure.',
      { cause },
    );
  }
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
  await page.locator('.route-panel-body').waitFor({ state: 'visible' });
}

/**
 * Empty the local record stores — saved places and saved routes.
 *
 * The stores are cleared rather than the database deleted: the app holds an open
 * connection from startup, and `deleteDatabase` against a live connection blocks
 * indefinitely rather than failing, which would hang the suite instead of failing it.
 */
export async function clearSavedData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      // Same name and version as src/db.ts. Opening at a *lower* version than the app
      // uses would throw; opening at the same one just joins the existing database.
      const request = indexedDB.open('ratmap', 2);
      // This usually runs before the app has opened the database at all, and creating it
      // empty would leave the app holding a v2 connection with no stores in it — every
      // read and write then fails with NotFoundError and no upgrade is ever triggered to
      // repair it. So mirror src/db.ts's schema here.
      request.onupgradeneeded = () => {
        const created = request.result;
        for (const [store, index] of [
          ['saved-places', 'savedAt'],
          ['routes', 'updatedAt'],
        ] as const) {
          if (created.objectStoreNames.contains(store)) continue;
          created.createObjectStore(store, { keyPath: 'id' }).createIndex(index, index);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const stores = [...db.objectStoreNames].filter((name) =>
      ['saved-places', 'routes'].includes(name),
    );
    if (stores.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(stores, 'readwrite');
        for (const store of stores) transaction.objectStore(store).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }
    db.close();
  });
}

/** Where the map is pointed right now. */
export async function mapView(page: Page): Promise<{ lng: number; lat: number; zoom: number }> {
  return page.evaluate(() => {
    const map = (window as unknown as { __ratmapMap: MLMap }).__ratmapMap;
    const centre = map.getCenter();
    return { lng: centre.lng, lat: centre.lat, zoom: map.getZoom() };
  });
}

/** Move the map without a fitBounds, for tests about what a given zoom shows. */
export async function jumpTo(
  page: Page,
  centre: [number, number],
  zoom: number,
): Promise<void> {
  await page.evaluate(
    ([lng, lat, z]) => {
      const map = (window as unknown as { __ratmapMap: MLMap }).__ratmapMap;
      map.jumpTo({ center: [lng, lat], zoom: z });
    },
    [centre[0], centre[1], zoom] as const,
  );
}

export interface PeakOnScreen {
  name: string;
  /** Metres, or null for a summit the archive carries no usable elevation for. */
  ele: number | null;
  lng: number;
  lat: number;
  /** Where that summit currently projects to, in CSS pixels. */
  x: number;
  y: number;
}

/**
 * A named summit currently drawn on the map, and where it is on screen.
 *
 * Found from the live style rather than hardcoded, so these tests say "tap a summit" and
 * stay true when the peaks archive is rebuilt — the notability filter decides which hills
 * render at a given zoom, and pinning a test to one of them makes a rebuild look like a
 * regression.
 *
 * Queried on the circle layer, not the labels: a symbol is only returned once its label
 * has actually been placed, and `text-allow-overlap: false` means a summit in a crowded
 * corrie has a marker you can tap and no label at all.
 */
export async function waitForPeak(page: Page): Promise<PeakOnScreen> {
  const handle = await page.waitForFunction(
    () => {
      const map = (window as unknown as { __ratmapMap?: MLMap }).__ratmapMap;
      if (!map?.getLayer('peaks-symbol-marker')) return null;

      const canvas = map.getCanvas();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      for (const feature of map.queryRenderedFeatures({ layers: ['peaks-symbol-marker'] })) {
        const name = feature.properties?.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        if (feature.geometry?.type !== 'Point') continue;

        const [lng, lat] = feature.geometry.coordinates as [number, number];
        const point = map.project([lng, lat]);
        // Keep clear of the furniture: the sheet along the bottom, and the detail notice
        // and rail at the top — a tap there hits a control rather than the map.
        if (point.x < 80 || point.x > width - 80) continue;
        if (point.y < 100 || point.y > height * 0.5) continue;

        const ele = feature.properties?.ele;
        return {
          name,
          ele: typeof ele === 'number' ? ele : null,
          lng,
          lat,
          x: point.x,
          y: point.y,
        };
      }
      return null;
    },
    null,
    { timeout: 30_000 },
  );

  const peak = await handle.jsonValue();
  // `waitForFunction` only resolves once the predicate returns something truthy, so this
  // is unreachable — it narrows the type rather than handling a real case.
  if (!peak) throw new Error('no summit rendered on screen');
  return peak;
}

/** Tap a summit and return which one was tapped. */
export async function clickPeak(page: Page): Promise<PeakOnScreen> {
  const peak = await waitForPeak(page);
  await page.mouse.click(peak.x, peak.y);
  return peak;
}

/**
 * Type into the search field and wait for it to answer.
 *
 * Focused first because the index loads on focus — the app deliberately does not pull
 * the SQLite runtime at startup, so a test that only fills the field races the load.
 */
export async function searchFor(page: Page, query: string): Promise<void> {
  const input = page.locator('#search-input');
  await input.click();
  await input.fill(query);
  await page.locator('#search-results:not([hidden])').waitFor({ timeout: 30_000 });
}

/**
 * Make exports take the download path rather than the OS share sheet.
 *
 * `shareOrDownload` prefers `navigator.share` where it can share files, which is right on
 * a phone and untestable here: a native share sheet has nothing on the other side of it
 * in a headless browser, and the promise never settles. Removing the API exercises the
 * same function's documented fallback rather than a special case built for tests.
 */
export async function preferFileDownloads(context: BrowserContext): Promise<void> {
  await context.addInitScript(`
    delete navigator.canShare;
    delete navigator.share;
  `);
}

/** How much of the screen the sheet is currently taking, in px. */
export async function sheetHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-visible')),
  );
}

/**
 * The layers a *downloaded region's own archives* put on the map.
 *
 * Not simply everything whose id starts with `region-`: the coverage outlines are
 * `region-footprints-*` and are drawn for regions nobody has downloaded, so counting those
 * would make "the region is on the map" true before any download and still true after a
 * delete. Archive layers are `region-<id>-<kind>-…`.
 */
export async function regionArchiveLayers(
  page: Page,
): Promise<Array<{ id: string; type: string }>> {
  const layers = await styleLayers(page);
  return layers.filter(
    (layer) => layer.id.startsWith('region-') && !layer.id.startsWith('region-footprints-'),
  );
}
