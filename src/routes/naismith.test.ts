import { describe, expect, it } from 'vitest';
import { formatWalkingTime, naismithSeconds } from './naismith';

describe('naismithSeconds', () => {
  it('walks 5 km of flat in an hour', () => {
    expect(naismithSeconds(5000, 0)).toBe(3600);
  });

  it('adds an hour for every 600 m of ascent', () => {
    expect(naismithSeconds(0, 600)).toBe(3600);
    expect(naismithSeconds(10_000, 300)).toBe(2.5 * 3600);
  });

  it('prices Ben Nevis by the tourist path about as every guide does', () => {
    // ~8.5 km and ~1300 m up from the Glen Nevis visitor centre: 1.7 hr + 2.17 hr.
    expect(formatWalkingTime(naismithSeconds(8500, 1300))).toBe('3 hr 50 min');
  });

  it('ignores negative inputs rather than giving time back', () => {
    expect(naismithSeconds(5000, -100)).toBe(3600);
  });

  it('has no answer for an unknown input', () => {
    expect(naismithSeconds(NaN, 100)).toBeNaN();
    expect(formatWalkingTime(naismithSeconds(1000, Infinity))).toBe('—');
  });
});

describe('formatWalkingTime', () => {
  it('rounds to five minutes', () => {
    expect(formatWalkingTime(22 * 60)).toBe('20 min');
    expect(formatWalkingTime(23 * 60)).toBe('25 min');
  });

  it('never rounds a real route down to nothing', () => {
    expect(formatWalkingTime(60)).toBe('5 min');
    expect(formatWalkingTime(0)).toBe('0 min');
  });

  it('writes hours and minutes', () => {
    expect(formatWalkingTime(3600)).toBe('1 hr');
    expect(formatWalkingTime(3600 + 25 * 60)).toBe('1 hr 25 min');
    expect(formatWalkingTime(59 * 60)).toBe('1 hr');
  });
});
