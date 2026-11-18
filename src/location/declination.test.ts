import { describe, expect, it } from 'vitest';
import cof from './WMM2025.COF?raw';
import testValues from './WMM2025_TestValues.txt?raw';
import {
  compassAdvice,
  declinationLine,
  decimalYear,
  describeDeclination,
  fieldAt,
  formatAngle,
  magneticField,
  magneticModel,
  parseCof,
} from './declination';

// NOAA's published check values for WMM2025, from the coefficient zip: decimal year,
// height (km), geodetic latitude and longitude, then declination (2 dp) and its rate.
const cases = testValues
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => line.trim().split(/\s+/).map(Number))
  .map(([year, height, lat, lng, declination, , horizontal, , , , , declinationPerYear]) => ({
    year: year!,
    height: height!,
    lat: lat!,
    lng: lng!,
    declination: declination!,
    horizontal: horizontal!,
    declinationPerYear: declinationPerYear!,
  }));

describe('the World Magnetic Model', () => {
  it('is the complete WMM2025 file', () => {
    expect(cof.split('\n')[0]!.trim()).toBe('2025.0            WMM-2025     11/13/2024');
    expect(magneticModel()).toEqual({ name: 'WMM-2025', validUntil: new Date(Date.UTC(2030, 0, 1)) });
  });

  it('refuses a truncated coefficient file rather than computing from it', () => {
    const truncated = cof.split('\n').slice(0, 60).join('\n');
    expect(() => parseCof(truncated)).toThrow(/complete/);
  });

  it(`matches all ${cases.length} of NOAA's test values`, () => {
    expect(cases).toHaveLength(100);
    for (const c of cases) {
      const field = fieldAt(c.lat, c.lng, c.year, c.height);
      const where = `${c.year} ${c.height} km ${c.lat},${c.lng}`;
      expect(field, where).not.toBeNull();
      // Published to two decimals; the rate and field strength to six.
      expect(Math.abs(field!.declination - c.declination), where).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(field!.declinationPerYear, where).toBeCloseTo(c.declinationPerYear, 4);
      expect(field!.horizontal, where).toBeCloseTo(c.horizontal, 2);
    }
  });

  it('gives nothing outside its five years, rather than a value that has drifted', () => {
    expect(fieldAt(56.8, -5, 2024.99)).toBeNull();
    expect(fieldAt(56.8, -5, 2029.999)).not.toBeNull();
    expect(fieldAt(56.8, -5, 2030)).toBeNull();
    expect(magneticField(56.8, -5, new Date('2030-01-01T00:00:00Z'))).toBeNull();
  });

  it('gives nothing at the geographic poles, where declination means nothing', () => {
    expect(fieldAt(90, 0, 2026)).toBeNull();
    expect(fieldAt(-90, 0, 2026)).toBeNull();
  });
});

describe('decimalYear', () => {
  it('counts whole days from the start of the year', () => {
    expect(decimalYear(new Date('2026-01-01T12:00:00Z'))).toBe(2026);
    expect(decimalYear(new Date('2026-07-02T00:00:00Z'))).toBeCloseTo(2026 + 182 / 365, 9);
    // 2028 is a leap year.
    expect(decimalYear(new Date('2028-12-31T23:00:00Z'))).toBeCloseTo(2028 + 365 / 366, 9);
  });
});

describe('describing it', () => {
  it('writes a tenth of a degree under 10°, whole degrees beyond', () => {
    expect(formatAngle(-1.43, 'E', 'W')).toBe('1.4° W');
    expect(formatAngle(12.4, 'E', 'W')).toBe('12° E');
    expect(formatAngle(9.96, 'E', 'W')).toBe('10° E');
    expect(formatAngle(0.04, 'E', 'W')).toBe('0°');
  });

  it('says which way magnetic north lies, and which way it is moving', () => {
    expect(describeDeclination({ declination: -1.43, declinationPerYear: 0.18, horizontal: 17000 })).toBe(
      'Magnetic north is 1.4° west of true north, moving 0.2° east a year.',
    );
    expect(describeDeclination({ declination: 0.01, declinationPerYear: 0.01, horizontal: 17000 })).toBe(
      'Magnetic north is the same as true north, barely moving.',
    );
  });

  it('says how to correct a map bearing: add when west, take off when east', () => {
    expect(compassAdvice({ declination: -11.02, declinationPerYear: 0.3, horizontal: 13000 })).toBe(
      'Add 11° to a bearing taken from the map before following it on a compass.',
    );
    expect(compassAdvice({ declination: 3.43, declinationPerYear: 0.1, horizontal: 22000 })).toBe(
      'Take 3.4° off a bearing taken from the map before following it on a compass.',
    );
    expect(compassAdvice({ declination: -0.28, declinationPerYear: 0.2, horizontal: 18000 })).toMatch(/^Under 1°/);
    expect(compassAdvice({ declination: -0.96, declinationPerYear: 0.2, horizontal: 18000 })).toMatch(/^Add 1\.0°/);
    expect(compassAdvice({ declination: 20, declinationPerYear: 0.5, horizontal: 1500 })).toBeNull();
  });

  it('fits on one line at the foot of a printed sheet', () => {
    expect(declinationLine({ declination: -1.14, declinationPerYear: 0.21, horizontal: 16900 })).toBe(
      'Magnetic north 1.1° W of true, moving 0.2° E a year',
    );
    expect(declinationLine({ declination: 0.43, declinationPerYear: 0.017, horizontal: 35000 })).toBe(
      'Magnetic north 0.4° E of true',
    );
    expect(declinationLine({ declination: -37.9, declinationPerYear: 1.3, horizontal: 2800 })).toBe(
      'Magnetic north 38° W of true, moving 1.3° E a year · weak field, use with caution',
    );
  });

  it('warns near the magnetic pole, and gives up at it', () => {
    expect(describeDeclination({ declination: 20, declinationPerYear: 0.5, horizontal: 4000 })).toMatch(
      /with caution\.$/,
    );
    expect(describeDeclination({ declination: 20, declinationPerYear: 0.5, horizontal: 1500 })).toBe(
      'This close to the magnetic pole a compass is unreliable.',
    );
  });
});
