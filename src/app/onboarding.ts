import type { StatusCentre } from '../ui/status';
import { createInstallWatcher, INSTALL_RATIONALE, IOS_INSTALL_STEPS, isIos } from './install';
import { bootstrapStorage, isStandalone } from './storage';

// Storage + install onboarding (C1, C2): say why downloads are off, and what fixes it.

export function startStorageOnboarding({
  status,
  showInstallSteps,
}: {
  status: Pick<StatusCentre, 'setCondition'>;
  /** Open the iOS Add to Home Screen walkthrough (see renderInstallSheet). */
  showInstallSteps: () => void;
}): void {
  const installWatcher = createInstallWatcher();
  /**
   * Why the last install prompt failed, if it did. Kept rather than shown once: a failed
   * prompt is dropped, which re-runs this check, which would otherwise replace the reason
   * a moment later with the generic "install to download" line.
   */
  let promptFailure: string | null = null;
  installWatcher.onChange(() => void renderStorageStatus());
  void renderStorageStatus();

  async function renderStorageStatus(): Promise<void> {
    const storage = await bootstrapStorage();

    // Nothing to say when it works. This used to announce "Persistent storage granted" on
    // every single launch, which is a banner over the map for a state the user never has to
    // do anything about.
    if (storage.supported && storage.persisted) {
      status.setCondition('storage', null);
      return;
    }

    if (!storage.supported) {
      status.setCondition('storage', {
        message: 'This browser can’t promise to keep downloaded maps, so downloads are off.',
        kind: 'warn',
      });
      return;
    }

    // Not persisted. Whether that's fixable depends on how this browser handles install.
    const capability = installWatcher.capability();

    if (capability.kind === 'prompt') {
      status.setCondition('storage', {
        message: 'Install ratmap to download maps for offline use.',
        kind: 'warn',
        action: {
          label: 'Install',
          onSelect: () => {
            void capability.prompt().then(
              (outcome) => {
                if (outcome === 'accepted') void renderStorageStatus();
              },
              (err: Error) => {
                promptFailure = err.message;
                void renderStorageStatus();
              },
            );
          },
        },
      });
      return;
    }

    if (capability.kind === 'manual-ios') {
      status.setCondition('storage', {
        message: 'Add ratmap to your Home Screen to download maps.',
        kind: 'warn',
        // The three Share-sheet steps are too long for a line over the map, and they used to
        // sit there permanently as an ordered list. Behind a button they are available when
        // wanted and gone the rest of the time.
        action: { label: 'How', onSelect: showInstallSteps },
      });
      return;
    }

    status.setCondition('storage', {
      message: isStandalone()
        ? isIos()
          ? IOS_STANDALONE_NOT_PERSISTED
          : 'Your browser hasn’t granted ratmap permanent storage yet, so downloads are off.'
        : promptFailure
          ? `The install prompt didn’t open (${promptFailure}). Install from the browser’s menu to download maps.`
          : 'Downloads are off until ratmap is installed.',
      kind: 'warn',
    });
  }
}

/**
 * An installed iOS app that still isn't persisted. Two causes, both seen on real iPhones:
 *
 *   - First launch after Add to Home Screen. WebKit grants persist() only to domains on its
 *     tracking-prevention exemption list (a Home Screen app's own domain is on it), but it
 *     fetches that list once and caches it for the life of the process — and on first
 *     launch the cached copy can lack the app. Asking again changes nothing; a relaunch does.
 *   - Safari's "Prevent Cross-Site Tracking" turned off. That drops the exemption list
 *     entirely, so persist() is refused for every site (iOS 26.1).
 *
 * The relaunch comes first because it's the common case and costs nothing to try.
 */
const IOS_STANDALONE_NOT_PERSISTED =
  'iOS hasn’t granted permanent storage, so downloads are off. Fully close and reopen ratmap; ' +
  'if this persists, turn on “Prevent Cross-Site Tracking” in Settings → Apps → Safari.';

/** The iOS Share → Add to Home Screen walkthrough (C2: iOS has no install prompt). */
export function renderInstallSheet(body: HTMLElement): void {
  body.innerHTML = `
    <h2>Add ratmap to your Home Screen</h2>
    <p class="sheet-lede"></p>
    <ol class="install-steps"></ol>
  `;
  body.querySelector('.sheet-lede')!.textContent = INSTALL_RATIONALE;

  const steps = body.querySelector<HTMLOListElement>('.install-steps')!;
  for (const step of IOS_INSTALL_STEPS) {
    const item = document.createElement('li');
    item.textContent = step;
    steps.append(item);
  }
}