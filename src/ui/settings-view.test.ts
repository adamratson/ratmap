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
  current: 'light' | 'dark';
  listeners: Set<(theme: 'light' | 'dark') => void>;
  get: () => 'light' | 'dark';
  set: ReturnType<typeof vi.fn>;
  onChange: (listener: (theme: 'light' | 'dark') => void) => () => void;
  /** Stand in for the device flipping to dark or light while the view is open. */
  systemChange: (next: 'light' | 'dark') => void;
};

beforeEach(async () => {
  vi.resetModules();
  settings = await import('./settings-view');
  debug.enabled = false;
  debug.instances = [];
  body = document.createElement('div');
  sheetElement = document.createElement('div');
  theme = {
    current: 'dark',
    listeners: new Set(),
    get: () => theme.current,
    set: vi.fn((next) => void (theme.current = next)),
    onChange: (listener) => {
      theme.listeners.add(listener);
      return () => theme.listeners.delete(listener);
    },
    systemChange: (next) => {
      theme.current = next;
      for (const listener of theme.listeners) listener(next);
    },
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
  it('shows the current theme', () => {
    theme.current = 'light';
    render();
    expect(body.querySelector<HTMLInputElement>('#light-theme-toggle')!.checked).toBe(true);
  });

  it('moves with the device while the app is still following it', () => {
    // Until someone uses the switch the app follows the device, so a switch that sat
    // where it was left would misreport the map — and the next tap would then ask for
    // the theme already on screen.
    render();
    expect(body.querySelector<HTMLInputElement>('#light-theme-toggle')!.checked).toBe(false);

    theme.systemChange('light');
    expect(body.querySelector<HTMLInputElement>('#light-theme-toggle')!.checked).toBe(true);
    // Reacting to the device is not choosing: nothing was stored.
    expect(theme.set).not.toHaveBeenCalled();
  });

  it('drops its theme listener when the view is rendered again', () => {
    render();
    render();
    expect(theme.listeners.size).toBe(1);
  });

  it('switches the theme from the toggle', () => {
    render();
    toggle('#light-theme-toggle');
    expect(theme.set).toHaveBeenCalledWith('light');

    toggle('#light-theme-toggle');
    expect(theme.set).toHaveBeenLastCalledWith('dark');
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
