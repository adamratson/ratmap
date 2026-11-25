import { describe, expect, it } from 'vitest';
import { gridReference } from './grid-ref';

describe('gridReference', () => {
  it('writes an eight-figure OS reference in Great Britain', () => {
    // Ben Nevis summit: E 216671, N 771291 (grid.test.ts, checked against PROJ).
    expect(gridReference(-5.00361, 56.79694)).toEqual({
      system: 'OS National Grid',
      text: 'NN 1667 7129',
    });
  });

  it('truncates rather than rounds, as the OS does', () => {
    // N 122408.7 is in the square 2240, not 2241: rounding would name the one north of it.
    expect(gridReference(-1.5, 51.0)!.text).toBe('SU 3518 2240');
  });

  it('pads figures that start with zeros', () => {
    // E 100596, N 856566: just inside NG (E 100-200 km), 00596 into it, written 0059.
    expect(gridReference(-7.0, 57.5)!.text).toBe('NG 0059 5656');
  });

  it('uses UTM outside Great Britain, with the latitude band', () => {
    // cs2cs +proj=longlat +datum=WGS84 +to +proj=utm +zone=32 +datum=WGS84
    //   6.86517 45.83265 → 334198.59 5077670.21
    expect(gridReference(6.86517, 45.83265)).toEqual({
      system: 'UTM 32N',
      text: '32T 334198E 5077670N',
    });
  });

  it('carries the false northing south of the equator', () => {
    // cs2cs … +proj=utm +zone=19 +south: -70 -33 → 406582.22 6348269.03
    expect(gridReference(-70, -33)).toEqual({ system: 'UTM 19S', text: '19H 406582E 6348269N' });
  });

  it('puts Ireland on UTM, as the printed sheet does', () => {
    expect(gridReference(-6.26, 53.35)!.system).toBe('UTM 29N');
  });

  it('wraps a longitude from a repeated world copy', () => {
    expect(gridReference(-5.00361 + 360, 56.79694)!.text).toBe('NN 1667 7129');
  });

  it('gives nothing beyond UTM’s limits', () => {
    expect(gridReference(0, 85)).toBeNull();
    expect(gridReference(0, -81)).toBeNull();
  });

  it('runs band X to 84° N', () => {
    expect(gridReference(15.6, 78.2)!.text).toMatch(/^33X /);
  });
});
