import { describe, expect, it } from 'vitest';
import { describeDetailLimit } from './detail-limit';

const MAX_DATA_ZOOM = 5;

describe('describeDetailLimit', () => {
  it('stays quiet while the viewport is within the archive zoom range', () => {
    for (const zoom of [0, 3, 5]) {
      expect(describeDetailLimit(zoom, MAX_DATA_ZOOM).overzoomed).toBe(false);
    }
  });

  it('tolerates one level of overzoom before complaining', () => {
    // Tiles still look reasonable one level past their source, and a pill that flickers
    // on every fractional zoom nudge would be noise rather than information.
    expect(describeDetailLimit(5.5, MAX_DATA_ZOOM).overzoomed).toBe(false);
    expect(describeDetailLimit(6, MAX_DATA_ZOOM).overzoomed).toBe(false);
    expect(describeDetailLimit(6.5, MAX_DATA_ZOOM).overzoomed).toBe(true);
  });

  it('flags the badly-stretched hiking zooms the user actually notices', () => {
    const state = describeDetailLimit(12, MAX_DATA_ZOOM);
    expect(state.overzoomed).toBe(true);
    expect(state.label).toBeTruthy();
  });

  it('explains the cause and names the real zoom ceiling, rather than just saying "limited"', () => {
    const state = describeDetailLimit(12, MAX_DATA_ZOOM);
    expect(state.detail).toContain('zoom 5');
    // Must point at the actual remedy (offline regions), not imply the map is broken.
    expect(state.detail).toMatch(/offline region/i);
  });

  it('reports no limit for a non-finite zoom instead of showing a bogus notice', () => {
    expect(describeDetailLimit(Number.NaN, MAX_DATA_ZOOM).overzoomed).toBe(false);
  });

  it('tracks whatever ceiling it is given, not a hardcoded one', () => {
    // Phase 4 region archives raise this per region.
    expect(describeDetailLimit(12, 13).overzoomed).toBe(false);
    expect(describeDetailLimit(12, 5).detail).toContain('zoom 5');
    expect(describeDetailLimit(15, 13).detail).toContain('zoom 13');
  });
});
