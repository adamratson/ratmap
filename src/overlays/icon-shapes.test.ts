import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { ensureShapeImage, shapeImage, shapePart, shapeSwatch, type Shape } from './icon-shapes';

/** The [r, g, b, a] of one pixel. */
function pixel(image: ReturnType<typeof shapeImage>, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return Array.from(image.data.slice(at, at + 4));
}

const colors = { glyph: '#102030', rim: '#ffffff' };

describe('shapePart', () => {
  it('measures strokes by their own width, falling back to the default', () => {
    const shape: Shape = { strokes: [[4, 8, 28, 8], [4, 20, 28, 20, 6]] };
    expect(shapePart(shape, 16, 8.9)).toBe('glyph'); // inside the 1.9-wide stroke
    expect(shapePart(shape, 16, 10)).toBe('rim');
    expect(shapePart(shape, 16, 22.9)).toBe('glyph'); // inside the 6-wide stroke
    expect(shapePart(shape, 16, 14)).toBe('none'); // between, beyond both halos
  });

  it('fills polygons in the glyph and haloes them like any other mark', () => {
    const shape: Shape = {
      fills: [
        [
          [10, 10],
          [22, 10],
          [22, 22],
          [10, 22],
        ],
      ],
    };
    expect(shapePart(shape, 16, 16)).toBe('glyph');
    expect(shapePart(shape, 23.5, 16)).toBe('rim');
    expect(shapePart(shape, 26, 16)).toBe('none');
  });

  it('backs a shape with halo inside its backing polygon', () => {
    const backing = [
      [4, 4],
      [28, 4],
      [28, 28],
      [4, 28],
    ] as const;
    expect(shapePart({ discs: [[16, 16, 2]], backing }, 8, 8)).toBe('rim');
    expect(shapePart({ discs: [[16, 16, 2]] }, 8, 8)).toBe('none');
  });
});

describe('shapeImage', () => {
  const image = shapeImage({ discs: [[16, 16, 6]] }, colors, 16);

  it('is size CSS px at 2x', () => {
    expect([image.width, image.height]).toEqual([32, 32]);
    expect(shapeImage({ discs: [[16, 16, 6]] }, colors, 12).width).toBe(24);
  });

  it('draws glyph, halo and clear background', () => {
    expect(pixel(image, 15, 15)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(pixel(image, 15, 23)).toEqual([255, 255, 255, 255]);
    expect(pixel(image, 0, 0)[3]).toBe(0);
  });
});

describe('ensureShapeImage', () => {
  it('registers once per name and glyph colour', () => {
    const images = new Map<string, unknown>();
    const map = {
      hasImage: vi.fn((id: string) => images.has(id)),
      addImage: vi.fn((id: string, image: unknown) => images.set(id, image)),
    } as unknown as MLMap;
    const shape: Shape = { discs: [[16, 16, 4]] };
    expect(ensureShapeImage(map, 'x', shape, colors, 12)).toBe('x-102030');
    ensureShapeImage(map, 'x', shape, colors, 12);
    ensureShapeImage(map, 'x', shape, { glyph: '#abcdef', rim: '#000000' }, 12);
    expect([...images.keys()]).toEqual(['x-102030', 'x-abcdef']);
  });
});

describe('shapeSwatch', () => {
  it('draws every kind of mark, halo under glyph', () => {
    const svg = shapeSwatch(
      {
        strokes: [[0, 0, 4, 4]],
        discs: [[8, 8, 2]],
        fills: [
          [
            [1, 1],
            [2, 1],
            [2, 2],
          ],
        ],
      },
      colors,
    );
    expect(svg).toContain('<line');
    expect(svg).toContain('<circle');
    expect(svg).toContain('<polygon');
    expect(svg.indexOf('#ffffff')).toBeLessThan(svg.indexOf('#102030'));
  });
});
