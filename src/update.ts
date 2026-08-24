/**
 * Keeping a running install on the latest deployed build.
 *
 * Content-hashed filenames are not a cache-busting strategy by themselves. They guarantee
 * a *new* URL exists; they do not make anything go and look for it. Once the service
 * worker controls the page (C5 — app shell only), every navigation is answered out of the
 * Cache API, so the browser's HTTP caching is no longer what decides which build you get:
 * the worker is. An installed PWA can then run one cached build for weeks, because a
 * standalone app that is resumed rather than navigated never re-fetches anything.
 *
 * Hence three parts, in order:
 *
 * 1. **Ask.** `registration.update()` on a timer, on resume, and when the network returns.
 *    Nothing else prompts an update check in an app that is never navigated.
 *
 * 2. **Stage, don't stampede.** The worker is generated with `skipWaiting: false`
 *    (vite.config.ts), so a new build installs and then *waits*. The old precache stays
 *    intact and the running page keeps working until we say otherwise. With `skipWaiting`
 *    the new worker activates immediately and its `cleanupOutdatedCaches()` deletes the
 *    precache out from under a page that is still executing the old bundle — every chunk
 *    not yet loaded then 404s. Staging is what makes the third part safe to delay.
 *
 * 3. **Apply at a safe moment.** Applying means reloading, and a reload during a multi-GB
 *    region download is destructive: C12 says those only progress in the foreground, so
 *    there is no background transfer to survive it. `isBusy` gates the swap and it is
 *    applied as soon as the app goes idle again.
 */

/** Routine poll while the app sits open. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/** Floor between checks, so app-switching in and out doesn't hammer the network. */
const MIN_CHECK_GAP_MS = 60 * 1000;

/** How often to retry applying a staged update that `isBusy` held back. */
const HELD_RECHECK_MS = 5 * 1000;

export interface AppUpdateOptions {
  /** The generated worker, e.g. `${import.meta.env.BASE_URL}sw.js`. */
  swUrl: string;
  /** Must match the worker's scope, i.e. the app's base path. */
  scope: string;
  intervalMs?: number;
  /**
   * True while a reload would destroy work in progress. A staged update is held back and
   * applied automatically once this returns false again.
   */
  isBusy?: () => boolean;
  /**
   * Called once per staged update, only when `isBusy()` held it back. `apply` lets the
   * user take it immediately rather than waiting for the app to go idle.
   */
  onUpdateHeld?: (apply: () => void) => void;
  /**
   * How the new build is taken up. Injectable only so tests can observe the swap without
   * navigating: jsdom refuses to let `location.reload` be redefined.
   */
  reload?: () => void;
}

export interface AppUpdates {
  /** Force a check now, ignoring the throttle. */
  checkNow(): Promise<void>;
  /** Apply a staged update immediately, if there is one. */
  apply(): void;
  /** True once a new build has installed and is waiting to take over. */
  isUpdateStaged(): boolean;
  dispose(): void;
}

const NOOP_UPDATES: AppUpdates = {
  checkNow: () => Promise.resolve(),
  apply: () => {},
  isUpdateStaged: () => false,
  dispose: () => {},
};

export function startAppUpdates(options: AppUpdateOptions): AppUpdates {
  if (!('serviceWorker' in navigator)) return NOOP_UPDATES;

  const {
    swUrl,
    scope,
    intervalMs = DEFAULT_INTERVAL_MS,
    isBusy,
    onUpdateHeld,
    reload = () => window.location.reload(),
  } = options;

  let registration: ServiceWorkerRegistration | null = null;
  let staged: ServiceWorker | null = null;
  let heldNotified = false;
  let applied = false;
  let reloading = false;
  let disposed = false;
  let lastCheck = 0;
  let settleTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether this page was already under a worker's control when it loaded.
   *
   * On a first-ever visit it is not, and `clientsClaim()` then fires `controllerchange`
   * for that very first worker. That is the app becoming available offline, not an
   * update — reloading on it would reload every new install, every time.
   */
  const hadController = Boolean(navigator.serviceWorker.controller);

  function reloadOnce(): void {
    if (reloading) return;
    reloading = true;
    reload();
  }

  const onControllerChange = (): void => {
    // A different worker is in charge now, so everything this page holds in memory belongs
    // to the previous build and that build's precache is being cleaned up. `applied`
    // covers the case where we asked for the swap from an uncontrolled page (a hard
    // reload), where `hadController` alone would wrongly say "first install".
    if (!hadController && !applied) return;
    reloadOnce();
  };

  function stopSettleTimer(): void {
    if (!settleTimer) return;
    clearInterval(settleTimer);
    settleTimer = null;
  }

  function apply(): void {
    if (!staged || reloading) return;
    applied = true;
    stopSettleTimer();

    if (registration?.waiting) {
      // Workbox's generated worker listens for exactly this message when built with
      // `skipWaiting: false`. The reload is left to `controllerchange`: reloading here
      // would race the activation and just load the old build again.
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }

    // Already activated on its own — a worker stops waiting once every client running the
    // old build has gone. There is nothing left to ask for, so just pick it up.
    reloadOnce();
  }

  function settle(): void {
    if (!staged || reloading || applied) return;

    if (isBusy?.()) {
      if (!heldNotified) {
        heldNotified = true;
        onUpdateHeld?.(apply);
      }
      // Poll rather than wait for the next routine check: "applies once your download
      // finishes" should mean seconds, not up to `intervalMs`.
      settleTimer ??= setInterval(settle, HELD_RECHECK_MS);
      return;
    }

    apply();
  }

  function stage(worker: ServiceWorker): void {
    if (staged === worker) return;
    staged = worker;
    settle();
  }

  function watch(reg: ServiceWorkerRegistration): void {
    // Already waiting when we registered: a previous session installed it and closed
    // before it could be applied.
    if (reg.waiting && navigator.serviceWorker.controller) stage(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;

      installing.addEventListener('statechange', () => {
        // `installed` *with* a controller means a new build is ready alongside the running
        // one. With no controller it is the first install — offline-ready, not an update.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          stage(installing);
        }
      });
    });
  }

  const ready = navigator.serviceWorker
    // `updateViaCache: 'none'` — the default ('imports') already bypasses the HTTP cache
    // for the worker script itself, but not for the workbox runtime it pulls in via
    // importScripts. Set explicitly so none of this rests on a spec default.
    .register(swUrl, { scope, updateViaCache: 'none' })
    .then((reg) => {
      if (disposed) return;
      registration = reg;
      lastCheck = Date.now();
      watch(reg);
    })
    .catch(() => {
      // No worker (unsupported, blocked, or a 404 in a non-PWA build): the app runs fine,
      // it just can't self-update. Nothing actionable to show a user standing on a hill.
    });

  async function checkNow(): Promise<void> {
    await ready;
    if (disposed || reloading || !registration) return;

    // Only trusted in the negative direction. `navigator.onLine === true` is meaningless
    // here — it stays true behind a captive portal or a dead uplink, which is why the map
    // detects offline from failed requests instead (see isNetworkFailure in main.ts). But
    // `false` does reliably mean "no link", so it's a sound reason to skip a check.
    if (navigator.onLine === false) return;

    lastCheck = Date.now();
    try {
      await registration.update();
    } catch {
      // A failed check is the expected state out of signal, not a fault.
    }
  }

  function maybeCheck(): void {
    if (Date.now() - lastCheck < MIN_CHECK_GAP_MS) return;
    void checkNow();
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    // The main path for an installed PWA: it is resumed far more often than it is loaded.
    maybeCheck();
    // Whatever was keeping the app busy may have finished while it was hidden.
    settle();
  };

  const onOnline = (): void => maybeCheck();

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  const interval = setInterval(() => {
    maybeCheck();
    settle();
  }, intervalMs);

  return {
    checkNow,
    apply,
    isUpdateStaged: () => staged !== null,
    dispose() {
      disposed = true;
      clearInterval(interval);
      stopSettleTimer();
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
    },
  };
}
