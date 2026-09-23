import { describe, expect, it } from 'vitest';
import {
  AVALANCHE_ENCODING,
  ASPECT_OCTANTS,
  SLOPE_CLASSES,
  SLOPE_FLOOR_DEG,
  aspectName,
  avalancheColorRamp,
  slopeClassFor,
} from './avalanche';

describe('slope classes', () => {
  it('places a slope in the band that contains it, at both edges', () => {
    expect(slopeClassFor(25)?.label).toBe('25–29°');
    expect(slopeClassFor(29.9)?.label).toBe('25–29°');
    expect(slopeClassFor(30)?.label).toBe('30–34°');
    expect(slopeClassFor(38)?.label).toBe('35–39°');
    expect(slopeClassFor(44.9)?.label).toBe('40–44°');
    expect(slopeClassFor(45)?.label).toBe('45°+');
    expect(slopeClassFor(90)?.label).toBe('45°+');
  });

  it('reports nothing below the floor rather than an easiest class', () => {
    // A7: the raster stores 0 for "below the threshold this layer draws", which is not
    // the same fact as "flat". Returning the gentlest class here would turn every
    // unshaded cell into a positive claim about the ground.
    expect(slopeClassFor(24.99)).toBeNull();
    expect(slopeClassFor(0)).toBeNull();
    expect(slopeClassFor(Number.NaN)).toBeNull();
  });

  it('covers the range continuously, with no gap between bands', () => {
    for (let d = SLOPE_FLOOR_DEG; d <= 90; d += 0.5) {
      expect(slopeClassFor(d), `no class for ${d}`).not.toBeNull();
    }
  });
});

describe('aspect octants', () => {
  it('names the eight compass directions, and nothing for 0', () => {
    expect(aspectName(1)).toBe('N');
    expect(aspectName(3)).toBe('E');
    expect(aspectName(5)).toBe('S');
    expect(aspectName(8)).toBe('NW');
    // 0 is what the pipeline writes wherever slope is below the floor.
    expect(aspectName(0)).toBeNull();
    expect(aspectName(9)).toBeNull();
    expect(ASPECT_OCTANTS).toHaveLength(8);
  });
});

describe('color-relief ramp', () => {
  const ramp = avalancheColorRamp() as unknown[];

  it('is an interpolate expression over elevation', () => {
    // Not cosmetic. MapLibre's _createColorRamp() only reads stops from an Interpolate;
    // a `step` expression leaves the ramp empty and the layer renders fully transparent
    // with no error anywhere. This test is the guard against someone "simplifying" it.
    expect(ramp[0]).toBe('interpolate');
    expect(ramp[1]).toEqual(['linear']);
    expect(ramp[2]).toEqual(['elevation']);
  });

  it('has strictly ascending stops', () => {
    const inputs = ramp.slice(3).filter((_, i) => i % 2 === 0) as number[];
    for (let i = 1; i < inputs.length; i++) {
      expect(inputs[i], `stop ${i} (${inputs[i]}) after ${inputs[i - 1]}`).toBeGreaterThan(
        inputs[i - 1],
      );
    }
  });

  it('is transparent below the floor and paints every class above it', () => {
    const stops = new Map<number, string>();
    for (let i = 3; i < ramp.length; i += 2) {
      stops.set(ramp[i] as number, ramp[i + 1] as string);
    }
    expect(stops.get(0)).toBe('rgba(0,0,0,0)');
    expect(stops.get(SLOPE_FLOOR_DEG - 0.01)).toBe('rgba(0,0,0,0)');
    for (const entry of SLOPE_CLASSES) {
      expect(stops.get(entry.from), `${entry.label} start`).toBe(entry.color);
    }
  });

  it('duplicates each class colour so bands are hard-edged', () => {
    // The interpolation only ever happens inside the 0.01 gap between one band's top and
    // the next band's bottom, which stored integer values can never land in.
    for (const entry of SLOPE_CLASSES) {
      const top = entry.to === null ? 90 : entry.to - 0.01;
      const index = ramp.indexOf(top);
      expect(index, `${entry.label} has no closing stop`).toBeGreaterThan(-1);
      expect(ramp[index + 1]).toBe(entry.color);
    }
  });
});

describe('raster-dem encoding', () => {
  it('uses no zero factor', () => {
    // A11, and the reason this whole channel layout looks the way it does. MapLibre packs
    // the ramp's own elevation stops with packDEMData(), which computes
    // `minScale = min(red, green, blue)` and divides by it — one zero factor makes every
    // stop NaN and the shader's binary search collapses, rendering nothing, with no error.
    // The obvious layout (slope in G, red and blue zeroed) fails exactly here.
    expect(AVALANCHE_ENCODING.redFactor).not.toBe(0);
    expect(AVALANCHE_ENCODING.greenFactor).not.toBe(0);
    expect(AVALANCHE_ENCODING.blueFactor).not.toBe(0);
  });

  it('decodes the red channel as slope in whole degrees', () => {
    const { redFactor, greenFactor, blueFactor, baseShift } = AVALANCHE_ENCODING;
    const decode = (r: number, g: number, b: number) =>
      r * redFactor + g * greenFactor + b * blueFactor - baseShift;

    expect(decode(38, 0, 0)).toBe(38);
    // The other channels ride underneath and must never move the value into a
    // neighbouring class: worst case is aspect 8 plus a full runout byte.
    expect(decode(38, 8, 90)).toBeGreaterThanOrEqual(38);
    expect(decode(38, 8, 90)).toBeLessThan(38.05);
    // Which is to say: a cell on a class boundary still reads as its own class.
    expect(Math.floor(decode(35, 8, 90))).toBe(35);
  });
});
