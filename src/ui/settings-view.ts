import { DebugOverlay, isDebugOverlayEnabled, setDebugOverlayEnabled } from '../app/debug';
import type { ThemeController, ThemePreference } from './theme';

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

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function renderSettingsView(
  body: HTMLElement,
  { theme, sheetElement }: { theme: ThemeController; sheetElement: HTMLElement },
): void {
  body.innerHTML = `
    <h2>Settings</h2>
    <div class="settings-row settings-row-static">
      <span class="settings-row-text">
        <span class="settings-row-label" id="theme-label">Theme</span>
        <span class="settings-row-note">
          Device follows your phone’s light or dark mode.
        </span>
      </span>
      <div class="segmented" role="radiogroup" aria-labelledby="theme-label">
        ${THEME_OPTIONS.map(
          ({ value, label }) => `
          <label>
            <input type="radio" name="theme" value="${value}" />
            <span>${label}</span>
          </label>`,
        ).join('')}
      </div>
    </div>
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
  // Three choices rather than one switch. A single Light switch could only ever commit to
  // a theme: once touched there was no way back to following the device, and anyone who
  // had picked up a stored `dark` was stuck on it in daylight. These show what has been
  // chosen, not what is on screen, so they never move under the person by themselves.
  for (const radio of body.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.checked = radio.value === theme.getPreference();
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      // Switching replaces the whole style (Protomaps ships flavours as whole layer
      // sets); main.ts's installAppLayers puts the app's own layers back — see its
      // theme.onChange. The settings view itself is untouched, so the control stays
      // under the finger that just moved it.
      theme.set(radio.value as ThemePreference);
    });
  }

  const toggle = body.querySelector<HTMLInputElement>('#debug-overlay-toggle')!;
  toggle.checked = isDebugOverlayEnabled();
  toggle.addEventListener('change', () => {
    setDebugOverlayEnabled(toggle.checked);
    syncDebugOverlay(sheetElement);
  });
}
