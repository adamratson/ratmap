import { describe, expect, it } from 'vitest';
import { coordsGestureUsed, coordsHint, markCoordsGestureUsed } from './hints';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe('the coordinates tip', () => {
  it('shows until the gesture has been used once, then never again', () => {
    const storage = memoryStorage();
    expect(coordsGestureUsed(storage)).toBe(false);
    markCoordsGestureUsed(storage);
    expect(coordsGestureUsed(storage)).toBe(true);
  });

  it('shows, rather than breaking, where storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(coordsGestureUsed(blocked)).toBe(false);
    expect(() => markCoordsGestureUsed(blocked)).not.toThrow();
  });

  it('names the gesture for the pointer in hand', () => {
    expect(coordsHint(true)).toMatch(/press and hold/);
    expect(coordsHint(false)).toMatch(/right-click/);
  });
});
