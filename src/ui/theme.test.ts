import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, themeFromStored } from './theme';

describe('themeFromStored', () => {
  it('defaults to dark, which is what the app looks like', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(themeFromStored(null)).toBe('dark');
  });

  it('keeps an explicit light choice across launches', () => {
    // People turn the map light on a glaring day and dark at dusk, and the person
    // holding it is the one who can tell — so the choice is stored, not re-derived.
    expect(themeFromStored('light')).toBe('light');
    expect(themeFromStored('dark')).toBe('dark');
  });

  it('lands anyone who was following their device on the default', () => {
    // 'system' is what the old three-state preference wrote. It is not honoured now:
    // ratmap is dark because that is the app's own look, not because a phone said so.
    expect(themeFromStored('system')).toBe('dark');
  });

  it('ignores a stored value it does not recognise', () => {
    expect(themeFromStored('')).toBe('dark');
    expect(themeFromStored('midnight')).toBe('dark');
  });
});
