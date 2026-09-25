import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCE, preferenceFromStored, resolveTheme } from './theme';

describe('preferenceFromStored', () => {
  it('follows the device when nothing has been chosen', () => {
    expect(DEFAULT_PREFERENCE).toBe('system');
    expect(preferenceFromStored(null)).toBe('system');
  });

  it('keeps an explicit choice across launches, in both directions', () => {
    // The device setting is a blunt instrument outdoors: dusk on a hill arrives long
    // before the phone's schedule thinks it has.
    expect(preferenceFromStored('light')).toBe('light');
    expect(preferenceFromStored('dark')).toBe('dark');
  });

  it('reads an old stored "system" as following the device', () => {
    expect(preferenceFromStored('system')).toBe('system');
  });

  it('ignores a stored value it does not recognise', () => {
    expect(preferenceFromStored('')).toBe('system');
    expect(preferenceFromStored('midnight')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('takes the device theme only when following it', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
  });

  it('lets an explicit choice beat the device in both directions', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });
});
