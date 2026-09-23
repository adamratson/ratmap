// Light or dark, for the chrome and the map together.
//
// Dark is the default and the app's own look (plans/signature-style.md): a full-white
// screen at last light is unpleasant, and it wrecks the night vision of someone who is
// going to need it. Light is a setting for a bright day, reached from Settings.
//
// This used to be a three-state preference — system, light, dark — cycled from a chip in
// the peek row. The device setting is gone as an input: ratmap is dark because that is
// what the app looks like, not because the phone happens to be. What is kept is the part
// that mattered, a stored explicit choice: people turn the map light on a glaring day,
// and dusk on a hill arrives long before the phone's schedule thinks it has, so the
// person holding it is the one who decides.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ratmap.theme';

export const DEFAULT_THEME: Theme = 'dark';

/**
 * The theme a stored value means, including the values the old three-state preference
 * wrote. `system` was whatever the device said at the time; it resolves to the new
 * default rather than being honoured, so upgrading lands everyone on the app's own look
 * unless they had explicitly chosen light.
 */
export function themeFromStored(raw: string | null): Theme {
  return raw === 'light' ? 'light' : DEFAULT_THEME;
}

function readStored(): Theme {
  try {
    return themeFromStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage blocked. The default is the right answer and losing the
    // preference is not worth failing startup over.
    return DEFAULT_THEME;
  }
}

export class ThemeController {
  private theme: Theme = readStored();
  private readonly listeners = new Set<(theme: Theme) => void>();

  constructor() {
    this.apply();
  }

  /** What is being shown. */
  get(): Theme {
    return this.theme;
  }

  set(theme: Theme): void {
    this.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
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
    const theme = this.theme;
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
