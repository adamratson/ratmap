import { describe, expect, it } from 'vitest';
import { headingFrom } from './heading';

describe('headingFrom', () => {
  it('takes iOS at its word — webkitCompassHeading is already true north', () => {
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
