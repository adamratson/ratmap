import { describe, expect, it } from 'vitest';
import { gridReference, parseGridReference } from './grid-ref';

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

describe('parseGridReference', () => {
  it('reads a six-figure OS reference to the middle of its 100 m square', () => {
    const ref = parseGridReference('NN 166 712')!;
    expect(ref.text).toBe('NN 166 712');
    expect(ref.precisionM).toBe(100);
    // The centre, E 216650 N 771250, written back as eight figures.
    expect(gridReference(ref.lng, ref.lat)!.text).toBe('NN 1665 7125');
  });

  it('takes it however it is typed', () => {
    const want = parseGridReference('NN 166 712');
    expect(parseGridReference('nn166712')).toEqual(want);
    expect(parseGridReference('  NN166 712 ')).toEqual(want);
  });

  it('reads every precision from 1 km to 1 m', () => {
    expect(parseGridReference('NN 16 71')!.precisionM).toBe(1000);
    expect(parseGridReference('NN 1667 7129')!.precisionM).toBe(10);
    const metre = parseGridReference('NN 16671 71291')!;
    expect(metre.precisionM).toBe(1);
    // Ben Nevis, against PROJ through grid.ts (grid.test.ts): back within a metre.
    expect(metre.lng).toBeCloseTo(-5.00361, 4);
    expect(metre.lat).toBeCloseTo(56.79694, 4);
  });

  it('round-trips what the position readout shows', () => {
    const shown = gridReference(-1.5, 51.0)!.text; // "SU 3518 2240"
    const back = parseGridReference(shown)!;
    expect(gridReference(back.lng, back.lat)!.text).toBe(shown);
  });

  it('refuses what is not a reference, so place names still search', () => {
    expect(parseGridReference('NN 166 71')).toBeNull(); // uneven halves
    expect(parseGridReference('NN 16671')).toBeNull(); // odd figures
    expect(parseGridReference('NN')).toBeNull();
    expect(parseGridReference('IN 166 712')).toBeNull(); // no I in the grid
    expect(parseGridReference('Ben Nevis')).toBeNull();
    expect(parseGridReference('NN 123456 123456')).toBeNull(); // six-figure halves
  });

  it('reads the UTM form ratmap writes, with or without E and N', () => {
    const ref = parseGridReference('32T 334198E 5077670N')!;
    expect(ref.system).toBe('UTM 32N');
    expect(ref.lng).toBeCloseTo(6.86517, 4);
    expect(ref.lat).toBeCloseTo(45.83265, 4);
    expect(parseGridReference('32t 334198 5077670')!.lat).toBeCloseTo(45.83265, 4);
  });

  it('round-trips a southern UTM reference', () => {
    const back = parseGridReference(gridReference(-70, -33)!.text)!;
    expect(back.lng).toBeCloseTo(-70, 4);
    expect(back.lat).toBeCloseTo(-33, 4);
  });

  it('refuses a UTM band that does not match the northing', () => {
    // 5077670 m north is band T (45.8° N); band C is 80° S.
    expect(parseGridReference('32C 334198E 5077670N')).toBeNull();
  });
});
