import { describe, expect, it } from 'vitest';
import { RateEstimator } from './downloader';

const MB = 1_000_000;

/** Feed steady progress: `chunks` samples of `bytes` each, one per `seconds`. */
function steady(estimator: RateEstimator, chunks: number, bytes: number, seconds: number): number {
  let total = 0;
  let at = 0;
  estimator.update(total, at);
  for (let i = 0; i < chunks; i += 1) {
    total += bytes;
    at += seconds * 1000;
    estimator.update(total, at);
  }
  return total;
}

describe('RateEstimator', () => {
  it('reports nothing until it has settled', () => {
    const estimator = new RateEstimator();
    estimator.update(0, 0);
    estimator.update(4 * MB, 1000);

    // One sample is not an estimate. Quoting "4 hours" here and "30 seconds" a tick later
    // is how an ETA teaches people to ignore it.
    expect(estimator.bytesPerSecond).toBeNull();
    expect(estimator.secondsRemaining(4 * MB, 100 * MB)).toBeNull();
  });

  it('converges on a steady rate', () => {
    const estimator = new RateEstimator();
    steady(estimator, 8, 4 * MB, 1); // 4 MB/s

    expect(estimator.bytesPerSecond).toBeCloseTo(4 * MB, -4);
  });

  it('derives remaining time from the rate', () => {
    const estimator = new RateEstimator();
    const received = steady(estimator, 8, 4 * MB, 1); // 4 MB/s

    // 100 MB total, 32 MB done, 68 MB left at ~4 MB/s -> ~17s.
    expect(estimator.secondsRemaining(received, 100 * MB)).toBeCloseTo(17, 0);
  });

  it('tracks a slowdown instead of averaging it away', () => {
    const estimator = new RateEstimator();
    steady(estimator, 8, 8 * MB, 1); // fast: 8 MB/s
    const fast = estimator.bytesPerSecond!;

    // Same estimator, now crawling. A lifetime average would still be quoting the fast
    // rate long after the download stopped achieving it.
    let total = 64 * MB;
    let at = 8000;
    for (let i = 0; i < 12; i += 1) {
      total += 1 * MB;
      at += 1000;
      estimator.update(total, at);
    }

    expect(estimator.bytesPerSecond!).toBeLessThan(fast / 2);
  });

  it('ignores the instant jump when resuming a part-downloaded region', () => {
    const estimator = new RateEstimator();
    // Resume reports the bytes already in OPFS immediately — 30 MB in no time at all.
    estimator.update(0, 0);
    estimator.update(30 * MB, 1);

    // Then real transfer at 2 MB/s.
    let total = 30 * MB;
    let at = 1;
    for (let i = 0; i < 8; i += 1) {
      total += 2 * MB;
      at += 1000;
      estimator.update(total, at);
    }

    // Without discarding that jump the rate would be wildly inflated and the ETA absurdly
    // short; it must reflect the 2 MB/s actually being achieved.
    expect(estimator.bytesPerSecond).toBeCloseTo(2 * MB, -5);
  });

  it('ignores an artifact skipped because it was already in OPFS', () => {
    const estimator = new RateEstimator();
    steady(estimator, 6, 2 * MB, 1); // 2 MB/s
    const before = estimator.bytesPerSecond!;

    // A completed artifact is reported in one go, with no time elapsed.
    estimator.update(12 * MB + 40 * MB, 6000);

    expect(estimator.bytesPerSecond).toBeCloseTo(before, -5);
  });

  it('has no answer once there is nothing left to transfer', () => {
    const estimator = new RateEstimator();
    const received = steady(estimator, 8, 4 * MB, 1);
    expect(estimator.secondsRemaining(received, received)).toBeNull();
  });

  it('survives repeated samples with no progress', () => {
    const estimator = new RateEstimator();
    steady(estimator, 6, 4 * MB, 1);

    // A stalled transfer still emits progress events; they must not divide by zero or
    // report a nonsense rate.
    for (let i = 0; i < 5; i += 1) estimator.update(24 * MB, 6000 + i * 1000);

    expect(estimator.bytesPerSecond).toBeGreaterThan(0);
    expect(Number.isFinite(estimator.secondsRemaining(24 * MB, 100 * MB)!)).toBe(true);
  });
});
