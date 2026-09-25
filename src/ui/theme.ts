// Light or dark, for the chrome and the map together.
//
// The device decides until the person does. `system` is the default: an app that opens
// bright white on a phone that has been in night mode since dusk is wrong in exactly the
// situation ratmap is for, and one that opens dark on a sunlit screen is just as wrong.
// Both mistakes are avoidable, because the phone already knows.
//
// The explicit choice still wins and is still stored, because the device setting is a
// blunt instrument outdoors: dusk on a hill arrives long before the phone's schedule
// thinks it has, and the person holding it is the one who can tell. Settings carries a
// single Light theme switch; flipping it commits to that theme and stops following.

export type Theme = 'light' | 'dark';

/** What the app has been *told*, as opposed to what it shows. */
export type ThemePreference = 'system' | Theme;

const STORAGE_KEY = 'ratmap.theme';

export const DEFAULT_PREFERENCE: ThemePreference = 'system';

/**
 * The preference a stored value means.
 *
 * Unrecognised values — and no value at all — mean "follow the device", which is also
 * what a brief spell of `dark`-by-default wrote for people who never opened Settings.
 * There is no way to tell those apart from a deliberate choice of dark made in that
 * window, so this keeps an explicit `dark`: honouring a stored choice is worth more than
 * migrating people off one.
 */
export function preferenceFromStored(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : DEFAULT_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference, system: Theme): Theme {
  return preference === 'system' ? system : preference;
}

function systemTheme(): Theme {
  // Optional-chained: `matchMedia` is absent in jsdom, and a missing media-query API is
  // not evidence of anything — light is the browser default.
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStored(): ThemePreference {
  try {
    return preferenceFromStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage blocked. Following the device is the right default and
    // losing the preference is not worth failing startup over.
    return DEFAULT_PREFERENCE;
  }
}

export class ThemeController {
  private preference: ThemePreference = readStored();
  private readonly listeners = new Set<(theme: Theme) => void>();
  private readonly query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

  constructor() {
    // Always bound, not only while the preference is 'system': someone who switches back
    // to following the device should start following it again without a reload.
    this.query?.addEventListener('change', () => {
      if (this.preference === 'system') this.apply();
    });
    this.apply();
  }

  /** What is actually being shown, after resolving `system`. */
  get(): Theme {
    return resolveTheme(this.preference, systemTheme());
  }

  /** What the app has been told: `system` until someone chooses. */
  getPreference(): ThemePreference {
    return this.preference;
  }

  set(preference: ThemePreference): void {
    this.preference = preference;
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Not being able to remember it is survivable; not applying it is not.
    }
    this.apply();
  }

  /** @returns an unsubscribe function. */
  onChange(listener: (theme: Theme) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private apply(): void {
    const theme = this.get();
    // The attribute drives the CSS; `color-scheme` drives the form controls, scrollbars
    // and the canvas the browser paints behind the page, which the attribute cannot.
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;

    // Keeps the iOS status bar and the Android task-switcher chrome in step. Without it
    // a dark map sits under a white status bar.
    //
    // Graphite at night (--surface). By day, the raised graphite used for status surfaces,
    // not the bone chrome: the bar sits over the map, and with iOS's black-translucent
    // style it carries light text. Also in index.html and vite.config.ts — keep in step.
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0e1114' : '#1c2127';

    for (const listener of this.listeners) listener(theme);
  }
}
