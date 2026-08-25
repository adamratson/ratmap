import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeLock } from './wake-lock';

describe('WakeLock', () => {
  let release: ReturnType<typeof vi.fn>;
  let request: ReturnType<typeof vi.fn>;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    release = vi.fn().mockResolvedValue(undefined);
    request = vi.fn().mockResolvedValue({ release });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  it('takes the lock and gives it back', async () => {
    const lock = new WakeLock();
    await lock.acquire();
    expect(request).toHaveBeenCalledWith('screen');

    await lock.release();
    expect(release).toHaveBeenCalled();
  });

  it('takes it again after the page comes back', async () => {
    // The browser drops the lock whenever the page is hidden. Without re-acquiring, one
    // glance at a notification means the screen sleeps for the rest of the walk.
    const lock = new WakeLock();
    await lock.acquire();

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    await lock.release();
  });

  it('stays released once released', async () => {
    const lock = new WakeLock();
    await lock.acquire();
    await lock.release();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    // Re-acquiring here would leave the screen on for the rest of the session.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('carries on when the browser refuses', async () => {
    // Denied on low battery, and absent entirely on some engines. The work still runs.
    request.mockRejectedValue(new Error('denied'));
    const lock = new WakeLock();

    await expect(lock.acquire()).resolves.toBeUndefined();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('does nothing where the API does not exist', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    const lock = new WakeLock();

    await expect(lock.acquire()).resolves.toBeUndefined();
  });
});
