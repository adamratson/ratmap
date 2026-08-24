import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAppUpdates } from './update';

/**
 * Stand-ins for the service worker registration graph. jsdom implements none of it, and
 * the behaviour worth testing is entirely about *which* transitions count as an update —
 * which is exactly what a real worker makes hard to drive on demand.
 */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];

  constructor(state: ServiceWorkerState = 'installing') {
    super();
    this.state = state;
  }

  postMessage(data: unknown): void {
    this.messages.push(data);
  }

  setState(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  update = vi.fn(() => Promise.resolve());

  /** Begin an install. `installing` is set before the event, as the browser does. */
  startInstall(): FakeWorker {
    const worker = new FakeWorker('installing');
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
    return worker;
  }

  /** Finish it. The worker moves to `waiting` before `statechange` fires. */
  finishInstall(worker: FakeWorker): void {
    this.installing = null;
    this.waiting = worker;
    worker.setState('installed');
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  readonly registration = new FakeRegistration();
  register = vi.fn((_url: string, _options?: RegistrationOptions) =>
    Promise.resolve(this.registration),
  );

  takeControl(worker: FakeWorker): void {
    this.controller = worker;
    this.dispatchEvent(new Event('controllerchange'));
  }
}

/** @param controlled whether a worker is already running the page, i.e. not a first visit. */
function installContainer(controlled: boolean): FakeContainer {
  const container = new FakeContainer();
  if (controlled) container.controller = new FakeWorker('activated');
  Object.defineProperty(navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  });
  return container;
}

/** Let the registration promise settle — nothing is watched until it does. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const OPTIONS = { swUrl: '/ratmap/sw.js', scope: '/ratmap/' };

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startAppUpdates', () => {
  it('registers the worker with the HTTP cache bypassed', async () => {
    const container = installContainer(true);
    const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });
    await flush();

    expect(container.register).toHaveBeenCalledWith('/ratmap/sw.js', {
      scope: '/ratmap/',
      updateViaCache: 'none',
    });
    updates.dispose();
  });

  it('does nothing where service workers are unsupported', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });

    await expect(updates.checkNow()).resolves.toBeUndefined();
    expect(updates.isUpdateStaged()).toBe(false);
  });

  describe('a first install', () => {
    it('is not treated as an update', async () => {
      const container = installContainer(false);
      const reload = vi.fn();
      const updates = startAppUpdates({ ...OPTIONS, reload });
      await flush();

      const worker = container.registration.startInstall();
      container.registration.finishInstall(worker);

      // Nothing to replace: this is the app becoming available offline, and staging it
      // would post SKIP_WAITING at a worker that is not waiting for anything.
      expect(updates.isUpdateStaged()).toBe(false);
      expect(worker.messages).toEqual([]);
      updates.dispose();
    });

    it('does not reload when clientsClaim takes control of the page', async () => {
      const container = installContainer(false);
      const reload = vi.fn();
      const updates = startAppUpdates({ ...OPTIONS, reload });
      await flush();

      const worker = container.registration.startInstall();
      container.registration.finishInstall(worker);
      container.takeControl(worker);

      // Reloading here would reload every visitor on their very first visit, forever.
      expect(reload).not.toHaveBeenCalled();
      updates.dispose();
    });
  });

  describe('an update to a controlled page', () => {
    it('asks the waiting worker to take over, and reloads only once it has', async () => {
      const container = installContainer(true);
      const reload = vi.fn();
      const updates = startAppUpdates({ ...OPTIONS, reload });
      await flush();

      const next = container.registration.startInstall();
      container.registration.finishInstall(next);

      expect(updates.isUpdateStaged()).toBe(true);
      expect(next.messages).toEqual([{ type: 'SKIP_WAITING' }]);
      // Reloading before the swap would just load the old build out of the old precache.
      expect(reload).not.toHaveBeenCalled();

      container.takeControl(next);
      expect(reload).toHaveBeenCalledTimes(1);
      updates.dispose();
    });

    it('reloads once, however many times control changes', async () => {
      const container = installContainer(true);
      const reload = vi.fn();
      const updates = startAppUpdates({ ...OPTIONS, reload });
      await flush();

      const next = container.registration.startInstall();
      container.registration.finishInstall(next);
      container.takeControl(next);
      container.takeControl(next);

      expect(reload).toHaveBeenCalledTimes(1);
      updates.dispose();
    });

    it('picks up a worker left waiting by an earlier session', async () => {
      const container = installContainer(true);
      const waiting = new FakeWorker('installed');
      container.registration.waiting = waiting;

      const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });
      await flush();

      expect(updates.isUpdateStaged()).toBe(true);
      expect(waiting.messages).toEqual([{ type: 'SKIP_WAITING' }]);
      updates.dispose();
    });
  });

  describe('while the app is busy', () => {
    it('holds the update back and applies it as soon as the app is idle', async () => {
      vi.useFakeTimers();
      const container = installContainer(true);
      const onUpdateHeld = vi.fn();
      let busy = true;

      const updates = startAppUpdates({
        ...OPTIONS,
        reload: vi.fn(),
        isBusy: () => busy,
        onUpdateHeld,
      });
      await flush();

      const next = container.registration.startInstall();
      container.registration.finishInstall(next);

      // A reload here aborts an in-flight region download (C12): nothing carries it on.
      expect(next.messages).toEqual([]);
      expect(onUpdateHeld).toHaveBeenCalledTimes(1);

      // Still busy some time later: told once, not once per retry.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(next.messages).toEqual([]);
      expect(onUpdateHeld).toHaveBeenCalledTimes(1);

      busy = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(next.messages).toEqual([{ type: 'SKIP_WAITING' }]);
      updates.dispose();
    });

    it('applies immediately when the user asks for it anyway', async () => {
      const container = installContainer(true);
      let applyNow: (() => void) | null = null;

      const updates = startAppUpdates({
        ...OPTIONS,
        reload: vi.fn(),
        isBusy: () => true,
        onUpdateHeld: (apply) => {
          applyNow = apply;
        },
      });
      await flush();

      const next = container.registration.startInstall();
      container.registration.finishInstall(next);
      expect(next.messages).toEqual([]);

      applyNow!();
      expect(next.messages).toEqual([{ type: 'SKIP_WAITING' }]);
      updates.dispose();
    });
  });

  describe('checking for a new build', () => {
    it('checks on demand', async () => {
      const container = installContainer(true);
      const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });

      await updates.checkNow();

      expect(container.registration.update).toHaveBeenCalledTimes(1);
      updates.dispose();
    });

    it('survives a check that fails out of signal', async () => {
      const container = installContainer(true);
      container.registration.update.mockRejectedValue(new Error('Failed to fetch'));
      const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });

      // Out of signal is the normal state of this app, not a fault to propagate.
      await expect(updates.checkNow()).resolves.toBeUndefined();
      updates.dispose();
    });

    it('skips the check when the link is known to be down', async () => {
      const container = installContainer(true);
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });

      await updates.checkNow();

      expect(container.registration.update).not.toHaveBeenCalled();
      updates.dispose();
    });

    it('checks when the app is resumed, but not on every flick between apps', async () => {
      vi.useFakeTimers();
      const container = installContainer(true);
      const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn() });
      await flush();

      const visibility = vi.spyOn(document, 'visibilityState', 'get');

      // Registration has just checked, so an immediate resume has nothing to ask about.
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(container.registration.update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(61_000);
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(container.registration.update).toHaveBeenCalledTimes(1);

      updates.dispose();
    });

    it('stops checking once disposed', async () => {
      vi.useFakeTimers();
      const container = installContainer(true);
      const updates = startAppUpdates({ ...OPTIONS, reload: vi.fn(), intervalMs: 1_000 });
      await flush();

      updates.dispose();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(container.registration.update).not.toHaveBeenCalled();
    });
  });
});
