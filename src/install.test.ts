import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isStandaloneMock = vi.hoisted(() => vi.fn());
vi.mock('./storage', () => ({ isStandalone: isStandaloneMock }));

const { createInstallWatcher, isIos } = await import('./install');

function stubUserAgent(ua: string, maxTouchPoints = 0): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true,
  });
}

/** A stand-in for Chromium's non-standard beforeinstallprompt event. */
function firePrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  window.dispatchEvent(event);
  return { prompt, event };
}

beforeEach(() => {
  isStandaloneMock.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isIos', () => {
  it('detects iPhone/iPad user agents', () => {
    stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(isIos()).toBe(true);
  });

  it('detects iPadOS 13+, which reports itself as a Mac', () => {
    // The only thing distinguishing it from a desktop Safari is touch points.
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5);
    expect(isIos()).toBe(true);
  });

  it('does not mistake a real desktop Mac for iOS', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0);
    expect(isIos()).toBe(false);
  });
});

describe('createInstallWatcher', () => {
  it('reports "installed" when already running standalone, regardless of platform', () => {
    isStandaloneMock.mockReturnValue(true);
    stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');

    const watcher = createInstallWatcher();

    expect(watcher.capability()).toEqual({ kind: 'none', reason: 'installed' });
  });

  it('falls back to the manual iOS walkthrough, since iOS never fires beforeinstallprompt', () => {
    stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');

    const watcher = createInstallWatcher();

    expect(watcher.capability().kind).toBe('manual-ios');
  });

  it('reports unsupported on a desktop browser that never prompts', () => {
    stubUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0');

    const watcher = createInstallWatcher();

    expect(watcher.capability()).toEqual({ kind: 'none', reason: 'unsupported' });
  });

  it('upgrades to a real install prompt once beforeinstallprompt fires', async () => {
    stubUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120');
    const watcher = createInstallWatcher();
    expect(watcher.capability().kind).toBe('none');

    const { prompt } = firePrompt('accepted');

    const capability = watcher.capability();
    expect(capability.kind).toBe('prompt');
    if (capability.kind !== 'prompt') throw new Error('expected prompt capability');
    await expect(capability.prompt()).resolves.toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('suppresses the browser mini-infobar so install happens through our own UI', () => {
    stubUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120');
    createInstallWatcher();

    const { event } = firePrompt();

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not offer a stale prompt twice — the event is single-use', async () => {
    stubUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120');
    const watcher = createInstallWatcher();
    firePrompt('dismissed');

    const first = watcher.capability();
    if (first.kind !== 'prompt') throw new Error('expected prompt capability');
    await first.prompt();

    // Consumed: Android falls back to "unsupported" rather than re-offering a dead event.
    expect(watcher.capability().kind).toBe('none');
  });

  it('notifies listeners when install capability changes', () => {
    stubUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120');
    const watcher = createInstallWatcher();
    const listener = vi.fn();
    watcher.onChange(listener);

    firePrompt();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.lastCall?.[0].kind).toBe('prompt');
  });
});
