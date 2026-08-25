/**
 * Keeps the screen awake while something needs the app in the foreground.
 *
 * Two things do. A region download only progresses in the foreground on iOS, where there
 * is no Background Fetch (C12). And following a route means, in the spec's own words,
 * "app foregrounded and screen on" — there is no background geolocation on any platform,
 * so a screen that sleeps every thirty seconds is not a limitation of the API, it is the
 * feature not working.
 *
 * Re-acquires on visibilitychange: the lock is released automatically whenever the page
 * is hidden, so without this a user who glances away loses it permanently.
 */
export class WakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private held = false;

  private readonly onVisibilityChange = (): void => {
    // `held` rather than `sentinel`: the sentinel is gone by the time this fires, and
    // re-acquiring for a caller that has already released would leave the screen on for
    // the rest of the session.
    if (this.held && document.visibilityState === 'visible') void this.request();
  };

  async acquire(): Promise<void> {
    this.held = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    await this.request();
  }

  async release(): Promise<void> {
    this.held = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    try {
      await this.sentinel?.release();
    } catch {
      // Already released.
    }
    this.sentinel = null;
  }

  private async request(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Denied (low battery, unsupported). The work still runs, it just needs the screen
      // kept on by hand — not worth failing over.
    }
  }
}
