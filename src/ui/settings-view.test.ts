import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeController } from './theme';

const debug = vi.hoisted(() => ({
  enabled: false,
  instances: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../app/debug', () => ({
  isDebugOverlayEnabled: () => debug.enabled,
  setDebugOverlayEnabled: (value: boolean) => void (debug.enabled = value),
  DebugOverlay: class {
    start = vi.fn();
    stop = vi.fn();
    constructor() {
      debug.instances.push(this);
    }
  },
}));

let settings: typeof import('./settings-view');

let body: HTMLElement;
let sheetElement: HTMLElement;
let theme: {
  preference: 'system' | 'light' | 'dark';
  getPreference: () => 'system' | 'light' | 'dark';
  set: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.resetModules();
  settings = await import('./settings-view');
  debug.enabled = false;
  debug.instances = [];
  body = document.createElement('div');
  sheetElement = document.createElement('div');
  theme = {
    preference: 'system',
    getPreference: () => theme.preference,
    set: vi.fn((next) => void (theme.preference = next)),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

const render = () =>
  settings.renderSettingsView(body, { theme: theme as unknown as ThemeController, sheetElement });
const toggle = (id: string) => {
  const input = body.querySelector<HTMLInputElement>(id)!;
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change'));
};

describe('the settings view', () => {
  const themeRadio = (value: string) =>
    body.querySelector<HTMLInputElement>(`input[name="theme"][value="${value}"]`)!;
  const choose = (value: string) => {
    const radio = themeRadio(value);
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  };

  it('starts on Device when nothing has been chosen', () => {
    render();
    expect(themeRadio('system').checked).toBe(true);
    expect(themeRadio('light').checked).toBe(false);
    expect(themeRadio('dark').checked).toBe(false);
  });

  it('shows a stored manual choice', () => {
    theme.preference = 'light';
    render();
    expect(themeRadio('light').checked).toBe(true);
    expect(themeRadio('system').checked).toBe(false);
  });

  it('sets a manual light or dark theme', () => {
    render();
    choose('light');
    expect(theme.set).toHaveBeenLastCalledWith('light');
    choose('dark');
    expect(theme.set).toHaveBeenLastCalledWith('dark');
  });

  it('hands a manual choice back to the device', () => {
    // The old single switch could only ever commit; there was no way back.
    theme.preference = 'dark';
    render();
    choose('system');
    expect(theme.set).toHaveBeenLastCalledWith('system');
  });

  it('is one labelled radio group', () => {
    render();
    const group = body.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('theme-label');
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it('starts the debug overlay when switched on, and stops it when switched off', () => {
    render();

    toggle('#debug-overlay-toggle');
    expect(debug.instances).toHaveLength(1);
    expect(debug.instances[0].start).toHaveBeenCalled();

    toggle('#debug-overlay-toggle');
    expect(debug.instances[0].stop).toHaveBeenCalled();
  });
});

describe('syncDebugOverlay', () => {
  it('creates nothing while the setting is off — its timer has no reason to run', () => {
    settings.syncDebugOverlay(sheetElement);
    expect(debug.instances).toHaveLength(0);
  });

  it('never starts a second overlay on top of the first', () => {
    debug.enabled = true;
    settings.syncDebugOverlay(sheetElement);
    settings.syncDebugOverlay(sheetElement);
    expect(debug.instances).toHaveLength(1);
  });
});
