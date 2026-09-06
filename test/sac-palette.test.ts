import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAC_GRADES } from '../src/sac';

// The grade ramp is written down twice and cannot be written down once: the map needs
// literal hex (a MapLibre paint property cannot read a CSS variable) and the sheet needs a
// variable (the dark theme lightens the ramp for text contrast). This test is what keeps
// the two copies honest — a grade recoloured in one place and not the other would show as
// a swatch that does not match the band it describes.
const CSS = readFileSync('src/style.css', 'utf8');

/** Every definition of a custom property, in file order — light first, then dark. */
function definitionsOf(name: string): string[] {
  return [...CSS.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8});`, 'g'))].map((m) => m[1]);
}

describe('the SAC palette', () => {
  it('defines a light and a dark value for every grade', () => {
    for (const entry of SAC_GRADES) {
      const values = definitionsOf(`--sac-t${entry.grade}`);
      expect(values, `--sac-t${entry.grade}`).toHaveLength(2);
      expect(values[0], `light --sac-t${entry.grade}`).toBe(entry.color);
      // Lightened, not merely different: the point of the dark value is contrast.
      expect(values[1], `dark --sac-t${entry.grade}`).not.toBe(entry.color);
    }
  });
});
