import { describe, expect, it } from 'vitest';
import { layers } from '@protomaps/basemaps';
import { MAP_FONTS, ratmapFlavor } from './flavor';

// Listed, not loaded: a glob of the glyph files actually in public/fonts, grouped by
// fontstack directory. import.meta.glob rather than node:fs so the app tsconfig does not
// have to take Node's types.
const glyphFiles = Object.keys(import.meta.glob('../../public/fonts/*/*.pbf'));
const onDisk = new Map<string, string[]>();
for (const file of glyphFiles) {
  const [, stack, range] = /public\/fonts\/([^/]+)\/([^/]+)\.pbf$/.exec(file)!;
  onDisk.set(stack, [...(onDisk.get(stack) ?? []), range]);
}

/** Every fontstack name a `text-font` value can resolve to, including inside expressions. */
function fontstacks(value: unknown, into = new Set<string>()): Set<string> {
  if (!Array.isArray(value)) return into;
  // A `literal` or a plain array of names: every string in it is a font name.
  const names = value[0] === 'literal' ? value[1] : value;
  if (Array.isArray(names) && names.length > 0 && names.every((v) => typeof v === 'string')) {
    const isExpression = ['get', 'case', 'step', 'match', 'coalesce', '==', 'in', '<=', 'has'].includes(names[0]);
    if (!isExpression) names.forEach((name) => into.add(name));
  }
  value.forEach((child) => fontstacks(child, into));
  return into;
}

describe('map fontstacks', () => {
  // C7 in its sharpest form: a fontstack the style names but public/fonts does not have
  // renders the map with no labels at all, offline and with no error on screen.
  it.each(['light', 'dark'] as const)(
    'has glyphs on disk for every stack the %s basemap requests',
    (theme) => {
      const requested = new Set<string>();
      for (const layer of layers('basemap', ratmapFlavor(theme), { lang: 'en' })) {
        const layout = (layer as { layout?: Record<string, unknown> }).layout;
        fontstacks(layout?.['text-font'], requested);
      }
      // The app's own label layers (peaks, SAC grades, contour heights).
      Object.values(MAP_FONTS).forEach((name) => requested.add(name));

      expect(requested.size).toBeGreaterThan(0);
      for (const stack of requested) {
        const ranges = onDisk.get(stack) ?? [];
        expect(ranges, `public/fonts/${stack}`).toContain('0-255');
        // One file per 256-codepoint block, 0..65535: a partial set drops whole scripts.
        expect(ranges).toHaveLength(256);
      }
    },
  );

  it('asks only for the Barlow stacks, so no other glyph set needs shipping', () => {
    const requested = new Set<string>();
    for (const layer of layers('basemap', ratmapFlavor('light'), { lang: 'en' })) {
      fontstacks((layer as { layout?: Record<string, unknown> }).layout?.['text-font'], requested);
    }
    expect([...requested].sort()).toEqual([...new Set(Object.values(MAP_FONTS))].sort());
  });
});
