import { expect, test, type Page, type Route } from '@playwright/test';
import {
  clearConditions,
  clearOpfs,
  focusTestRegionRow,
  gotoApp,
  openRegionsSheet,
  opfsFileSize,
  simulateInstalledPwa,
} from './helpers';

// C12: region downloads are chunked and resumable, and must survive exactly the
// conditions a real hike puts on a phone's connection — a deliberate pause, a stalled
// request, a flaky signal, and a connection that drops out entirely. Each of those is a
// distinct failure mode in downloader.ts (cancellation, the per-chunk timeout, ordinary
// fetch rejection, and retry exhaustion) and each is exercised here against the real
// browser network stack — a real hung fetch racing a real timer — which is exactly what
// downloader.test.ts's mocked fetch cannot stand in for.
//
// TEST_REGION's two artifacts, measured against the live manifest (2026-09-04):
//   andorra-basemap.pmtiles  7,101,792 bytes
//   andorra-terrain.pmtiles  8,837,636 bytes
// downloadRegion() requests region.artifacts in manifest order — basemap, then terrain —
// so intercepting requests to the basemap file targets the download's first artifact.
// Re-check these if the fixture region is ever rebuilt; see TEST_REGION in helpers.ts.
const BASEMAP_FILE = 'andorra-basemap.pmtiles';
const BASEMAP_URL = '**/regions/andorra/andorra-basemap.pmtiles';
const BASEMAP_BYTES = 7_101_792;
const TERRAIN_URL = '**/regions/andorra/andorra-terrain.pmtiles';

/** Parse `Range: bytes=<start>-<end>` off a request. */
function rangeOf(route: Route): { start: number; end: number } {
  const header = route.request().headers().range ?? '';
  const match = /bytes=(\d+)-(\d+)/.exec(header);
  if (!match) throw new Error(`Request to ${route.request().url()} carried no Range header`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

async function startTestRegionDownload(page: Page): Promise<void> {
  await focusTestRegionRow(page);
  await page.locator('.region-action').first().click();
}

const action = (page: Page) => page.locator('.region-action').first();

test.describe('pausing a download', () => {
  test.beforeEach(async ({ context, page }) => {
    await simulateInstalledPwa(context);
    await gotoApp(page);
    await clearOpfs(page);
    await clearConditions(page);
  });

  test('resumes from the byte it stopped at, not from the start', async ({ page }) => {
    // Every request's Range, tagged by whether it happened before the pause or after the
    // resume — the load-bearing assertion below is about the second group only.
    const ranges: Array<{ start: number; end: number; phase: 'before' | 'after' }> = [];
    let phase: 'before' | 'after' = 'before';

    await page.route(BASEMAP_URL, async (route) => {
      const { start, end } = rangeOf(route);
      ranges.push({ start, end, phase });
      // Hold the artifact's last chunk open indefinitely. Its first chunk (below) is left
      // to complete at real network speed, so there is always a clean window — the first
      // chunk on disk, the second still pending — in which to cancel: this test needs a
      // genuinely partial `.part` file, not a lucky race against however fast the wire
      // happens to be today.
      if (end === BASEMAP_BYTES - 1 && phase === 'before') return; // never resolves
      await route.continue();
    });

    await openRegionsSheet(page);
    await startTestRegionDownload(page);

    // The window described above: the first chunk has landed, the second is the one held
    // open by the route handler.
    await expect
      .poll(async () => opfsFileSize(page, `${BASEMAP_FILE}.part`), { timeout: 20_000 })
      .not.toBeNull();
    const pausedAt = (await opfsFileSize(page, `${BASEMAP_FILE}.part`))!;
    expect(pausedAt).toBeGreaterThan(0);
    expect(pausedAt).toBeLessThan(BASEMAP_BYTES);

    await action(page).click(); // Cancel
    await expect(page.locator('.toast.warn', { hasText: /progress is kept/i })).toBeVisible();
    await expect(action(page)).toHaveText('Resume');

    // Cancelling must not lose what was already on disk.
    expect(await opfsFileSize(page, `${BASEMAP_FILE}.part`)).toBe(pausedAt);

    phase = 'after';
    await action(page).click(); // Resume
    await expect(action(page)).toHaveText('Delete', { timeout: 60_000 });

    // The actual proof: nothing requested after the resume reached back before the byte
    // the pause left off at. A restart-from-zero would show up here as a `start: 0` entry
    // in the "after" phase.
    const afterResume = ranges.filter((r) => r.phase === 'after');
    expect(afterResume.length).toBeGreaterThan(0);
    for (const r of afterResume) expect(r.start).toBeGreaterThanOrEqual(pausedAt);

    expect(await opfsFileSize(page, BASEMAP_FILE)).toBe(BASEMAP_BYTES);
  });

  test('survives a relaunch and still resumes from the same byte', async ({ page }) => {
    // The realistic version of a pause: the app isn't merely backgrounded, it's actually
    // closed — force-quit on a phone, or the tab reloaded — and reopened later with the
    // partial download just sitting in OPFS. C12 promises resume across exactly this, not
    // only across an in-session Cancel.
    let sawRequestAfterReload = false;
    let firstRangeAfterReload: number | null = null;

    await page.route(BASEMAP_URL, async (route) => {
      const { start, end } = rangeOf(route);
      if (sawRequestAfterReload && firstRangeAfterReload === null) firstRangeAfterReload = start;
      if (end === BASEMAP_BYTES - 1 && !sawRequestAfterReload) return; // held open, as above
      await route.continue();
    });

    await openRegionsSheet(page);
    await startTestRegionDownload(page);
    await expect
      .poll(async () => opfsFileSize(page, `${BASEMAP_FILE}.part`), { timeout: 20_000 })
      .not.toBeNull();
    const pausedAt = (await opfsFileSize(page, `${BASEMAP_FILE}.part`))!;
    expect(pausedAt).toBeGreaterThan(0);

    await action(page).click(); // Cancel
    await expect(action(page)).toHaveText('Resume');

    // Force-quit and relaunch: a reload, not a resumed session. Route handlers on `page`
    // survive a reload in Playwright, so the last-chunk hold is still armed here — the
    // flag below lets it through once the resumed download actually reaches it.
    await page.reload();
    await page.locator('#map').waitFor();
    await clearConditions(page);
    expect(await opfsFileSize(page, `${BASEMAP_FILE}.part`)).toBe(pausedAt);

    await openRegionsSheet(page);
    // The row starts however the catalogue was last searched before the reload; refocus.
    await focusTestRegionRow(page);
    await expect(action(page)).toHaveText('Resume');

    sawRequestAfterReload = true;
    await action(page).click(); // Resume, post-relaunch
    await expect(action(page)).toHaveText('Delete', { timeout: 60_000 });

    // The same proof as the in-session case, across the reload boundary: the first byte
    // requested after relaunching was not byte zero.
    expect(firstRangeAfterReload).not.toBeNull();
    expect(firstRangeAfterReload!).toBeGreaterThanOrEqual(pausedAt);
    expect(await opfsFileSize(page, BASEMAP_FILE)).toBe(BASEMAP_BYTES);
  });
});

test.describe('a poor connection', () => {
  test.beforeEach(async ({ context, page }) => {
    await simulateInstalledPwa(context);
    await gotoApp(page);
    await clearOpfs(page);
    await clearConditions(page);
  });

  test('recovers a stalled request through its own timeout, without user action', async ({
    page,
  }) => {
    // The failure mode the CHUNK_TIMEOUT_MS comment in downloader.ts describes as
    // observed in the field: a request that neither resolves nor rejects, which a mocked
    // fetch in a unit test cannot reproduce because there is no real timer racing a real
    // pending promise. Left genuinely unresolved here, once, so the app's own 20 s timeout
    // is what has to notice and retry — nothing in this test drives that itself.
    let firstAttemptSeen = false;
    await page.route(BASEMAP_URL, async (route) => {
      const { start } = rangeOf(route);
      if (start === 0 && !firstAttemptSeen) {
        firstAttemptSeen = true;
        return; // never resolves — the app's CHUNK_TIMEOUT_MS has to catch this
      }
      await route.continue();
    });

    await openRegionsSheet(page);
    await startTestRegionDownload(page);

    // No failure toast while this plays out — a timeout-and-retry is not, from the
    // user's side, an error at all.
    await expect(page.locator('.toast.error')).toHaveCount(0);
    // >20s: the app's own retry has to actually fire, this test doesn't shortcut it.
    await expect(action(page)).toHaveText('Delete', { timeout: 45_000 });

    expect(await opfsFileSize(page, BASEMAP_FILE)).toBe(BASEMAP_BYTES);
  });

  test('finishes a download despite every chunk dropping once', async ({ page }) => {
    // The other kind of bad connection: not a hang, a request that just fails outright —
    // what `route.abort()` produces is exactly what a real dropped connection produces,
    // `fetch()` rejecting rather than hanging. Every chunk across both artifacts is made
    // to fail its first attempt, forcing the app's retry-with-backoff to actually run, in
    // a real browser, for every single chunk — not the one chunk downloader.test.ts mocks.
    const seen = new Set<string>();
    let failuresInjected = 0;

    const flaky = async (route: Route): Promise<void> => {
      const key = route.request().headers().range ?? route.request().url();
      if (!seen.has(key)) {
        seen.add(key);
        failuresInjected += 1;
        await route.abort('failed');
        return;
      }
      await route.continue();
    };
    await page.route(BASEMAP_URL, flaky);
    await page.route(TERRAIN_URL, flaky);

    await openRegionsSheet(page);
    await startTestRegionDownload(page);

    await expect(action(page)).toHaveText('Delete', { timeout: 60_000 });
    await expect(page.locator('.toast.error')).toHaveCount(0);

    // Every chunk actually failed once and still recovered — not a vacuously-passing test
    // where the route handler never ran.
    expect(failuresInjected).toBeGreaterThan(0);
    expect(await opfsFileSize(page, BASEMAP_FILE)).toBe(BASEMAP_BYTES);
  });

  test('fails cleanly when the connection drops entirely, and resumes once it returns', async ({
    context,
    page,
  }) => {
    // Not flaky, gone: MAX_CHUNK_ATTEMPTS worth of retries exhausted with nothing coming
    // back at all. This is the one failure real users hit hiking out of signal mid
    // download, and the contract is specific — a clear error, not a silent stall or a
    // lost download, and progress kept so Resume actually means something once back in
    // range.
    //
    // The last chunk gets a real, finite delay — not held open like the other tests here
    // — so there is a guaranteed window to go offline while genuinely partway through:
    // on a fast connection the whole 16 MB region can otherwise finish inside the time it
    // takes to poll for a `.part` file, leaving nothing left to interrupt.
    await page.route(BASEMAP_URL, async (route) => {
      const { end } = rangeOf(route);
      if (end === BASEMAP_BYTES - 1) await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });

    await openRegionsSheet(page);
    await startTestRegionDownload(page);

    // Some real progress first, so there is something worth resuming.
    await expect
      .poll(async () => opfsFileSize(page, `${BASEMAP_FILE}.part`), { timeout: 20_000 })
      .not.toBeNull();
    const beforeOffline = (await opfsFileSize(page, `${BASEMAP_FILE}.part`)) ?? 0;
    expect(beforeOffline).toBeLessThan(BASEMAP_BYTES);

    await context.setOffline(true);

    await expect(
      page.locator('.toast.error', { hasText: /Download failed/ }),
    ).toBeVisible({ timeout: 30_000 });

    // The bytes already on disk before the connection dropped must survive the failure —
    // a failed download is not a deleted one. Checked before touching the sheet again:
    // the catalogue itself is fetched over the network with no offline cache of its own
    // (unlike the startup restore path, which does have one — see restoreRegions in
    // main.ts), so the failure's own refresh leaves the regions list empty and the search
    // box hidden while still offline. That is a real, separate constraint from anything
    // about the download, which is why it's asserted here rather than routed around.
    expect(await opfsFileSize(page, `${BASEMAP_FILE}.part`)).toBeGreaterThanOrEqual(
      beforeOffline,
    );
    await expect(page.locator('.regions-search')).toBeHidden();

    // Back in signal: close and reopen the sheet, the way someone actually would after
    // finding it blank, rather than reload — the point is that the *same session*
    // recovers once the catalogue is reachable again.
    //
    // Not `openChip` for the close step: it waits for the sheet to reach an *open*
    // detent, which a click that closes an already-open view can never satisfy — that
    // combination hung this test for its full timeout the first time round.
    await context.setOffline(false);
    await page.locator('#chips .chip', { hasText: 'Offline' }).click();
    await page.locator('#sheet.at-peek').waitFor();
    await openRegionsSheet(page);
    await focusTestRegionRow(page);
    await expect(action(page)).toHaveText('Resume');

    await action(page).click(); // Resume
    await expect(action(page)).toHaveText('Delete', { timeout: 60_000 });

    expect(await opfsFileSize(page, BASEMAP_FILE)).toBe(BASEMAP_BYTES);
  });
});
