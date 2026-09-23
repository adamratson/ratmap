import { isStandalone } from './storage';

// C2: installation gates the storage guarantee on BOTH platforms — WebKit grants
// persist() on heuristics keyed to Home Screen install, Chromium on install + engagement.
// So this isn't discovery UI, it's a prerequisite for offline maps working at all.
//
// The asymmetry: Chromium fires `beforeinstallprompt` and can show a real install button;
// iOS has no such event, so it needs a hand-held Share → Add to Home Screen walkthrough.

/** Not in the TS DOM lib — Chromium-only, and still non-standard. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallCapability =
  /** Chromium: we captured beforeinstallprompt and can trigger a real install dialog. */
  | { kind: 'prompt'; prompt(): Promise<'accepted' | 'dismissed'> }
  /** iOS Safari: manual walkthrough only. */
  | { kind: 'manual-ios' }
  /** Already installed, or a browser that neither prompts nor supports Home Screen apps. */
  | { kind: 'none'; reason: 'installed' | 'unsupported' };

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Mac; the touch-point check disambiguates it from a desktop.
    (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Watches for beforeinstallprompt and resolves what install path is available.
 * Call once at startup, before the event would fire.
 */
export function createInstallWatcher(): {
  capability(): InstallCapability;
  onChange(listener: (capability: InstallCapability) => void): void;
} {
  let deferred: BeforeInstallPromptEvent | null = null;
  const listeners: Array<(capability: InstallCapability) => void> = [];

  const capability = (): InstallCapability => {
    if (isStandalone()) return { kind: 'none', reason: 'installed' };
    if (deferred) {
      const event = deferred;
      return {
        kind: 'prompt',
        prompt: async () => {
          await event.prompt();
          const { outcome } = await event.userChoice;
          // A prompt can only be used once; drop it either way.
          deferred = null;
          notify();
          return outcome;
        },
      };
    }
    if (isIos()) return { kind: 'manual-ios' };
    return { kind: 'none', reason: 'unsupported' };
  };

  const notify = (): void => {
    const current = capability();
    for (const listener of listeners) listener(current);
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress Chromium's own mini-infobar so the install happens through our UI, where
    // we can explain *why* it matters (offline storage) rather than a bare prompt.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });

  return {
    capability,
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

export const IOS_INSTALL_STEPS = [
  'Tap the Share button in Safari’s toolbar.',
  'Scroll down and choose “Add to Home Screen”.',
  'Tap “Add”, then open ratmap from your Home Screen.',
] as const;

export const INSTALL_RATIONALE =
  'Installing is what lets the browser guarantee your offline maps stay on the device. ' +
  'Without it, downloaded regions can be evicted with no warning — which you would only ' +
  'discover with no signal.';
