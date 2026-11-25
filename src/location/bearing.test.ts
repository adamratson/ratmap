import { describe, expect, it } from 'vitest';
import { bearingTo, formatBearing, turnTo } from './bearing';

const BEN_NEVIS = { lng: -5.00361, lat: 56.79694, accuracyM: 8 };
const field = (declination: number, horizontal = 17_000) => ({ declination, declinationPerYear: 0, horizontal });

describe('bearingTo', () => {
  it('matches PROJ’s geodesic to within a fraction of a degree and a few metres', () => {
    // echo "56.79694 -5.00361 56.82 -4.97" | geod +ellps=WGS84 -I → 38.6285° 3287.698 m
    const ne = bearingTo(BEN_NEVIS, [-4.97, 56.82], null);
    expect(Math.abs(ne.true - 38.6285)).toBeLessThan(0.3);
    expect(Math.abs(ne.distanceM - 3287.698) / 3287.698).toBeLessThan(0.005);
    // … 56.78 -5.05 → -123.6180° (236.3820°) 3405.399 m
    const sw = bearingTo(BEN_NEVIS, [-5.05, 56.78], null);
    expect(Math.abs(sw.true - 236.382)).toBeLessThan(0.3);
    expect(Math.abs(sw.distanceM - 3405.399) / 3405.399).toBeLessThan(0.005);
  });

  it('turns true to magnetic with the declination at the fix', () => {
    const reading = bearingTo(BEN_NEVIS, [-4.97, 56.82], field(-1.1));
    // Magnetic north 1.1° west of true: the needle-relative bearing is 1.1° more.
    expect(reading.magnetic! - reading.true).toBeCloseTo(1.1, 9);
  });

  it('gives no magnetic bearing without a usable field', () => {
    expect(bearingTo(BEN_NEVIS, [-4.97, 56.82], null).magnetic).toBeNull();
    expect(bearingTo(BEN_NEVIS, [-4.97, 56.82], field(3, 1500)).magnetic).toBeNull();
  });

  it('calls a point inside the fix’s own error too close for a bearing', () => {
    // About 30 m north.
    const target: [number, number] = [BEN_NEVIS.lng, BEN_NEVIS.lat + 0.00027];
    expect(bearingTo({ ...BEN_NEVIS, accuracyM: 8 }, target, null).tooClose).toBe(false);
    expect(bearingTo({ ...BEN_NEVIS, accuracyM: 20 }, target, null).tooClose).toBe(true);
    // Never closer than 20 m, however good the fix claims to be.
    const near: [number, number] = [BEN_NEVIS.lng, BEN_NEVIS.lat + 0.00009];
    expect(bearingTo({ ...BEN_NEVIS, accuracyM: 1 }, near, null).tooClose).toBe(true);
  });
});

describe('formatBearing', () => {
  it('writes three figures and never 360', () => {
    expect(formatBearing(7)).toBe('007°');
    expect(formatBearing(247)).toBe('247°');
    expect(formatBearing(359.6)).toBe('000°');
    expect(formatBearing(-1)).toBe('359°');
  });
});

describe('turnTo', () => {
  it('turns the short way round', () => {
    expect(turnTo(10, 40)).toBe(30);
    expect(turnTo(40, 10)).toBe(-30);
    expect(turnTo(350, 10)).toBe(20);
    expect(turnTo(10, 350)).toBe(-20);
  });
});
