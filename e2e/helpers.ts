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
      // registerType is 'autoUpdate' (skipWaiting), so this normally fires promptly;
      // resolve anyway so a already-controlled edge case can't hang the suite.
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

/** Status cards cover the map and the HUD; clear them before interacting. */
export async function dismissStatusCards(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLButtonElement>('.status-dismiss').forEach((b) => b.click());
  });
}

/** Open the offline-regions sheet and wait for the catalogue to load. */
export async function openRegionsSheet(page: Page): Promise<void> {
  await page.locator('#regions-btn').click();
  await page.locator('.regions-list .region-row').first().waitFor({ state: 'visible' });
}

/**
 * Download the first region and wait for completion, i.e. the action button becoming
 * "Delete". Assumes the regions sheet is already open.
 */
export async function downloadFirstRegion(page: Page): Promise<void> {
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
