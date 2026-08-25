import { describe, expect, it } from 'vitest';
import { nextPreference, resolveTheme } from './theme';

describe('resolveTheme', () => {
  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
  });

  it('lets an explicit choice beat the system in both directions', () => {
    // Dusk on a hill arrives long before the phone's schedule thinks it has, and the
    // person holding it is the one who can tell.
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });
});

describe('nextPreference', () => {
  it('cycles back round to following the system', () => {
    expect(nextPreference('system')).toBe('light');
    expect(nextPreference('light')).toBe('dark');
    expect(nextPreference('dark')).toBe('system');
  });
});
