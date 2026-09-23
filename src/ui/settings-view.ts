import { DebugOverlay, isDebugOverlayEnabled, setDebugOverlayEnabled } from '../app/debug';
import type { ThemeController } from './theme';

// The Settings view: the theme, and the debug overlay.

/**
 * Debug overlay lifecycle. Created and destroyed with the setting, not just hidden — it
 * holds a ResizeObserver and a 500ms timer that have no reason to run for the far more
 * common case of the setting being off.
 */
let debugOverlay: DebugOverlay | null = null;

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
  light.checked = theme.get() === 'light';
  light.addEventListener('change', () => {
    // Switching replaces the whole style (Protomaps ships flavours as whole layer
    // sets); main.ts's installAppLayers puts the app's own layers back — see its
    // theme.onChange. The settings view itself is untouched, so the toggle stays under
    // the finger that just moved it.
    theme.set(light.checked ? 'light' : 'dark');
  });

  const toggle = body.querySelector<HTMLInputElement>('#debug-overlay-toggle')!;
  toggle.checked = isDebugOverlayEnabled();
  toggle.addEventListener('change', () => {
    setDebugOverlayEnabled(toggle.checked);
    syncDebugOverlay(sheetElement);
  });
}
