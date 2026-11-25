import { describe, expect, it } from 'vitest';
import { accuracyFrom, headingFrom, trueHeading } from './heading';

describe('headingFrom', () => {
  it('takes iOS at its word — webkitCompassHeading is already a (magnetic) compass heading', () => {
    expect(headingFrom({ alpha: 123, absolute: false, webkitCompassHeading: 90 }, 0)).toBe(90);
  });

  it('ignores an uncalibrated iOS magnetometer', () => {
    // Negative accuracy means the reading is meaningless. An arrow that points
    // confidently in the wrong direction is worse than no arrow.
    expect(
      headingFrom(
        { alpha: 0, absolute: false, webkitCompassHeading: 90, webkitCompassAccuracy: -1 },
        0,
      ),
    ).toBeNull();
  });

  it('converts an absolute alpha, which runs the other way round', () => {
    expect(headingFrom({ alpha: 0, absolute: true }, 0)).toBe(0);
    expect(headingFrom({ alpha: 90, absolute: true }, 0)).toBe(270);
    expect(headingFrom({ alpha: 270, absolute: true }, 0)).toBe(90);
  });

  it('refuses a relative alpha', () => {
    // A relative reading is measured from wherever the sensor happened to start, so it
    // has no relationship to north at all.
    expect(headingFrom({ alpha: 90, absolute: false }, 0)).toBeNull();
  });

  it('corrects for the phone being held in landscape', () => {
    // The user has not turned; the page has. Without this the arrow is 90 degrees out.
    expect(headingFrom({ alpha: 0, absolute: false, webkitCompassHeading: 0 }, 90)).toBe(90);
    expect(headingFrom({ alpha: 0, absolute: true }, 90)).toBe(90);
  });

  it('wraps rather than reporting 360 or a negative', () => {
    expect(headingFrom({ alpha: 0, absolute: false, webkitCompassHeading: 350 }, 90)).toBe(80);
    expect(headingFrom({ alpha: 350, absolute: true }, 0)).toBe(10);
  });

  it('gives up when there is nothing usable', () => {
    expect(headingFrom({ alpha: null, absolute: true }, 0)).toBeNull();
  });
});

describe('accuracyFrom', () => {
  it('passes the iOS accuracy through, and nothing for an uncalibrated or absent one', () => {
    expect(accuracyFrom({ alpha: 0, absolute: false, webkitCompassHeading: 1, webkitCompassAccuracy: 15 })).toBe(15);
    expect(accuracyFrom({ alpha: 0, absolute: false, webkitCompassHeading: 1, webkitCompassAccuracy: -1 })).toBeNull();
    expect(accuracyFrom({ alpha: 0, absolute: true })).toBeNull();
  });
});

describe('trueHeading', () => {
  const field = (declination: number, horizontal = 17_000) => ({ declination, declinationPerYear: 0, horizontal });

  it('adds an easterly declination and takes off a westerly one', () => {
    // Magnetic north 10° east of true: a needle reading 0° is pointing 10° true.
    expect(trueHeading(0, field(10))).toBe(10);
    expect(trueHeading(5, field(-10))).toBe(355);
  });

  it('gives nothing without a field, or where a compass is unreliable', () => {
    expect(trueHeading(90, null)).toBeNull();
    expect(trueHeading(90, field(3, 1500))).toBeNull();
    expect(trueHeading(null, field(3))).toBeNull();
  });
});
