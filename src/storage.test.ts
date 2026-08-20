import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapStorage, isStandalone } from './storage';

function stubNavigatorStorage(value: unknown): void {
  Object.defineProperty(navigator, 'storage', { value, configurable: true });
}

afterEach(() => {
  // @ts-expect-error test cleanup — navigator.storage isn't optional in the lib types
  delete navigator.storage;
  // @ts-expect-error test cleanup — legacy iOS flag
  delete navigator.standalone;
  vi.unstubAllGlobals();
});

describe('bootstrapStorage (C1)', () => {
  it('reports unsupported when the Storage Manager API is absent', async () => {
    stubNavigatorStorage(undefined);
    await expect(bootstrapStorage()).resolves.toEqual({ supported: false });
  });

  it('requests persistence and reports the granted result', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(true);
    stubNavigatorStorage({ persist, persisted });

    await expect(bootstrapStorage()).resolves.toEqual({ supported: true, persisted: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it('reports denial so callers can refuse to start a region download (C1)', async () => {
    stubNavigatorStorage({
      persist: vi.fn().mockResolvedValue(undefined),
      persisted: vi.fn().mockResolvedValue(false),
    });

    await expect(bootstrapStorage()).resolves.toEqual({ supported: true, persisted: false });
  });
});

describe('isStandalone (C2)', () => {
  function stubMatchMedia(matches: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches }) as unknown as typeof window.matchMedia,
    );
  }

  it('is true when the display-mode: standalone media query matches', () => {
    stubMatchMedia(true);
    expect(isStandalone()).toBe(true);
  });

  it('is true via the legacy iOS navigator.standalone flag even if matchMedia does not match', () => {
    stubMatchMedia(false);
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });

    expect(isStandalone()).toBe(true);
  });

  it('is false when neither signal indicates standalone', () => {
    stubMatchMedia(false);
    expect(isStandalone()).toBe(false);
  });
});
