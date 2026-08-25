// Light or dark, for the chrome and the map together.
//
// The app was pinned light: `color-scheme: light`, `namedFlavor('light')`, and not one
// `prefers-color-scheme` query in the stylesheet. A full-white 812px screen at last light
// is unpleasant, and it wrecks the night vision of someone who is going to need it.
//
// The manual override matters more than the system setting here, which is why this is a
// stored three-state preference rather than a media query. People turn the *map* dark
// before they turn the phone dark: dusk on a hill arrives long before the phone's
// schedule thinks it has, and the person holding it is the one who can tell.

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ratmap.theme';

/** Cycles in the order the button steps through. */
export const PREFERENCE_ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'] as const;

export function nextPreference(current: ThemePreference): ThemePreference {
  const index = PREFERENCE_ORDER.indexOf(current);
  return PREFERENCE_ORDER[(index + 1) % PREFERENCE_ORDER.length];
}

function systemTheme(): Theme {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(preference: ThemePreference, system: Theme): Theme {
  return preference === 'system' ? system : preference;
}

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    // Private mode, or storage blocked. Following the system is the right default and
    // losing the preference is not worth failing startup over.
    return 'system';
  }
}

export class ThemeController {
  private preference: ThemePreference = readStored();
  private readonly listeners = new Set<(theme: Theme) => void>();
  private readonly query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

  constructor() {
    // Only meaningful while the preference is 'system', but always bound: a user who
    // switches back to 'system' should immediately start following it again.
    this.query?.addEventListener('change', () => {
      if (this.preference === 'system') this.apply();
    });
    this.apply();
  }

  getPreference(): ThemePreference {
    return this.preference;
  }

  /** What is actually being shown, after resolving 'system'. */
  get(): Theme {
    return resolveTheme(this.preference, systemTheme());
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
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0f172a' : '#1e293b';

    for (const listener of this.listeners) listener(theme);
  }
}
