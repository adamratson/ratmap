import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// "Is the sheet docked?" is asked twice: by style.css, which lays the docked panel out, and
// by src/ui/pointer.ts, which decides how the sheet behaves. Written down twice because a
// stylesheet cannot export a constant — so this test keeps the two copies the same. If
// they drift, the sheet behaves as a bottom sheet while drawn as a panel, or the reverse.
const CSS = readFileSync('src/style.css', 'utf8');
const POINTER = readFileSync('src/ui/pointer.ts', 'utf8');

describe('the docked-panel media query', () => {
  it('is the same in the stylesheet and in the code', () => {
    const inCode = /prefersDockedSheet[\s\S]*?matchMedia\?\.\('([^']+)'\)/.exec(POINTER)?.[1];

    expect(inCode).toBeDefined();
    expect(CSS).toContain(`@media ${inCode} {`);
  });
});
