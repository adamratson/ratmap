import { DebugOverlay, isDebugOverlayEnabled, setDebugOverlayEnabled } from '../app/debug';
import type { ThemeController } from './theme';

// The Settings view: the theme, and the debug overlay.

/**
 * Debug overlay lifecycle. Created and destroyed with the setting, not just hidden — it
 * holds a ResizeObserver and a 500ms timer that have no reason to run for the far more
 * common case of the setting being off.
 */
let debugOverlay: DebugOverlay | null = null;

/** Unsubscribe for the listener the open settings view holds, if any. */
let viewCleanup: (() => void) | null = null;

/** Start or stop the debug overlay over `sheetElement`, to match the stored setting. */
export function syncDebugOverlay(sheetElement: HTMLElement): void {
  const enabled = isDebugOverlayEnabled();
  if (enabled && !debugOverlay) {
    debugOverlay = new DebugOverlay(sheetElement);
    debugOverlay.start();
  } else if (!enabled && debugOverlay) {
    debugOverlay.stop();
    debugOverlay = null;
  }
}

export function renderSettingsView(
  body: HTMLElement,
  { theme, sheetElement }: { theme: ThemeController; sheetElement: HTMLElement },
): void {
  body.innerHTML = `
    <h2>Settings</h2>
    <label class="settings-row">
      <span class="settings-row-text">
        <span class="settings-row-label">Light theme</span>
      </span>
      <input id="light-theme-toggle" type="checkbox" />
    </label>
    <label class="settings-row">
      <span class="settings-row-text">
        <span class="settings-row-label">Debug overlay</span>
        <span class="settings-row-note">
          Prints the sheet's on-screen geometry over the map — for tracking down
          layout bugs that only show up on a real device.
        </span>
      </span>
      <input id="debug-overlay-toggle" type="checkbox" />
    </label>
  `;
  const light = body.querySelector<HTMLInputElement>('#light-theme-toggle')!;
  // The switch shows what is on screen, not what has been chosen: until someone touches
  // it the app follows the device, and a switch sitting at "off" over a light map would
  // be lying about the state it is there to report.
  light.checked = theme.get() === 'light';
  light.addEventListener('change', () => {
    // Touching it commits: from here the app stays on the chosen theme rather than
    // following the device. Switching replaces the whole style (Protomaps ships flavours
    // as whole layer sets); main.ts's installAppLayers puts the app's own layers back —
    // see its theme.onChange. The settings view itself is untouched, so the toggle stays
    // under the finger that just moved it.
    theme.set(light.checked ? 'light' : 'dark');
  });
  // While the view is open and still following the device, a system change has to move
  // the switch with it — otherwise the next tap sends it to the theme already showing.
  const stopWatchingTheme = theme.onChange((current) => {
    light.checked = current === 'light';
  });
  // Dropped when the view is replaced, so listeners don't pile up one per open.
  viewCleanup?.();
  viewCleanup = stopWatchingTheme;

  const toggle = body.querySelector<HTMLInputElement>('#debug-overlay-toggle')!;
  toggle.checked = isDebugOverlayEnabled();
  toggle.addEventListener('change', () => {
    setDebugOverlayEnabled(toggle.checked);
    syncDebugOverlay(sheetElement);
  });
}
