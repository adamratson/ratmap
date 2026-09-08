import { describe, expect, it } from 'vitest';
import { parseLatLng } from './coords';

describe('parseLatLng', () => {
  it('parses a comma-separated pair', () => {
    expect(parseLatLng('56.79685, -5.00369')).toEqual({ lat: 56.79685, lng: -5.00369 });
  });

  it('parses a space-separated pair', () => {
    expect(parseLatLng('56.79685 -5.00369')).toEqual({ lat: 56.79685, lng: -5.00369 });
  });

  it('tolerates extra whitespace and no space after the comma', () => {
    expect(parseLatLng('  56.8,-5.0  ')).toEqual({ lat: 56.8, lng: -5.0 });
  });

  it('parses bare integer degrees', () => {
    expect(parseLatLng('56, -5')).toEqual({ lat: 56, lng: -5 });
  });

  it('rejects an out-of-range latitude', () => {
    expect(parseLatLng('120, -5')).toBeNull();
  });

  it('rejects an out-of-range longitude', () => {
    expect(parseLatLng('56, 200')).toBeNull();
  });

  it('rejects a single number', () => {
    expect(parseLatLng('56.8')).toBeNull();
  });

  it('rejects a named place, even one that starts with a digit', () => {
    expect(parseLatLng('56 Ben Nevis')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseLatLng('')).toBeNull();
  });
});
