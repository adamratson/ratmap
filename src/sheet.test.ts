import { describe, expect, it } from 'vitest';
import { FLICK_PROJECTION_MS, snapDetent } from './sheet';

// Offsets are "how far down from fully open", so peek is the largest and full is zero.
const OFFSETS = { peek: 700, half: 400, full: 0 } as const;

describe('snapDetent', () => {
  it('settles on the nearest detent when the finger is not moving', () => {
    expect(snapDetent(690, 0, OFFSETS)).toBe('peek');
    expect(snapDetent(420, 0, OFFSETS)).toBe('half');
    expect(snapDetent(40, 0, OFFSETS)).toBe('full');
  });

  it('honours a flick that has barely moved', () => {
    // 40px down from fully open is nearest to `full`, but a fast downward flick is
    // unmistakably a request to get the map back.
    const fastDown = (OFFSETS.half - 40) / FLICK_PROJECTION_MS + 0.1;
    expect(snapDetent(40, fastDown, OFFSETS)).not.toBe('full');
  });

  it('opens on an upward flick from rest', () => {
    const fastUp = -((OFFSETS.peek - OFFSETS.half) / FLICK_PROJECTION_MS + 0.1);
    expect(snapDetent(OFFSETS.peek, fastUp, OFFSETS)).not.toBe('peek');
  });

  it('does not overshoot past the ends', () => {
    expect(snapDetent(OFFSETS.peek, 10, OFFSETS)).toBe('peek');
    expect(snapDetent(0, -10, OFFSETS)).toBe('full');
  });

  it('ignores a slow drift, which is a hesitant drag rather than a flick', () => {
    expect(snapDetent(410, 0.02, OFFSETS)).toBe('half');
    expect(snapDetent(410, -0.02, OFFSETS)).toBe('half');
  });

  it('picks the midpoint detent when the sheet is dragged there and let go', () => {
    const midway = (OFFSETS.peek + OFFSETS.half) / 2;
    expect(snapDetent(midway - 1, 0, OFFSETS)).toBe('half');
    expect(snapDetent(midway + 1, 0, OFFSETS)).toBe('peek');
  });
});
