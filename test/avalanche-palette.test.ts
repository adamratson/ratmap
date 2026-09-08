import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SLOPE_CLASSES } from '../src/avalanche';

// Same hazard as the SAC ramp next door, and the same guard: the palette is written down
// twice and cannot be written down once. The map paints literal hex (a MapLibre paint
// property cannot read a CSS variable) and the sheet paints a variable (the dark theme
// lightens it for contrast against the dark surface).
//
// Unlike the SAC ramp, the light value here is deliberately *not* the map's own hex: the
// map fills a slope class at 50% opacity over terrain, where a pale yellow reads well,
// while the legend swatch sits on a light sheet where the same yellow is invisible. So
// this asserts both values exist and neither is the transparent-looking pale fill —
// it cannot assert equality without forcing one of the two surfaces to be wrong.
const CSS = readFileSync('src/style.css', 'utf8');

function definitionsOf(name: string): string[] {
  return [...CSS.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8});`, 'g'))].map((m) => m[1]);
}

describe('the avalanche terrain palette', () => {
  it('defines a light and a dark value for every slope class', () => {
    for (const entry of SLOPE_CLASSES) {
      const values = definitionsOf(`--avalanche-c${entry.from}`);
      expect(values, `--avalanche-c${entry.from}`).toHaveLength(2);
      expect(values[0], `light --avalanche-c${entry.from}`).toMatch(/^#[0-9a-f]{6}$/i);
      // Lightened for the dark sheet, not merely repeated.
      expect(values[1], `dark --avalanche-c${entry.from}`).not.toBe(values[0]);
    }
  });

  it('has a class for every step of the ramp and no orphan variables', () => {
    const declared = [...CSS.matchAll(/--avalanche-c(\d+):/g)].map((m) => Number(m[1]));
    const expected = SLOPE_CLASSES.map((c) => c.from);
    expect([...new Set(declared)].sort((a, b) => a - b)).toEqual(expected);
  });
});
