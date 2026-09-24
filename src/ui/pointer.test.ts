import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCoarsePointer, prefersDockedSheet } from './pointer';

/** A matchMedia that answers true for exactly the queries given. */
function stubMedia(...matching: string[]): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: matching.includes(query) }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isCoarsePointer', () => {
  it('is true for a finger', () => {
    stubMedia('(pointer: coarse)');
    expect(isCoarsePointer()).toBe(true);
  });

  it('is false for a mouse', () => {
    stubMedia();
    expect(isCoarsePointer()).toBe(false);
  });

  it('answers false rather than throwing where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isCoarsePointer()).toBe(false);
  });
});

describe('prefersDockedSheet', () => {
  // Kept in step with style.css's docked-panel block by test/docked-query.test.ts.
  const DOCKED = '(pointer: fine) and (hover: hover) and (min-width: 60rem)';

  it('docks for a mouse on a wide screen', () => {
    stubMedia(DOCKED);
    expect(prefersDockedSheet()).toBe(true);
  });

  it('stays a bottom sheet otherwise', () => {
    stubMedia('(pointer: coarse)');
    expect(prefersDockedSheet()).toBe(false);
  });
});
