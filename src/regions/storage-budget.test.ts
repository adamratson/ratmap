import { describe, expect, it } from 'vitest';
import { evaluateGate, type StorageSnapshot } from './storage-budget';
import type { Region } from './manifest';

const region: Region = {
  id: 'lochaber',
  name: 'Lochaber & Ben Nevis',
  bbox: [-5.6, 56.5, -4.6, 57.1],
  totalBytes: 23_000_000,
  artifacts: [],
};

function storage(overrides: Partial<StorageSnapshot> = {}): StorageSnapshot {
  return {
    persisted: true,
    usageBytes: 0,
    quotaBytes: 1_000_000_000,
    availableBytes: 1_000_000_000,
    ...overrides,
  };
}

describe('evaluateGate (C1)', () => {
  it('allows a download when storage is persistent and there is room', () => {
    expect(evaluateGate(region, storage())).toMatchObject({ allowed: true });
  });

  it('refuses when persistence was not granted, whatever the free space', () => {
    // The whole point of C1: without persistence the browser can evict the archive with
    // no warning, and the user finds out with no signal, on a mountain.
    const gate = evaluateGate(region, storage({ persisted: false }));

    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error('expected refusal');
    expect(gate.reason).toBe('not-persisted');
    // Must explain rather than just fail.
    expect(gate.message).toMatch(/home screen|install/i);
  });

  it('refuses when the region would not fit', () => {
    const gate = evaluateGate(region, storage({ availableBytes: 10_000_000 }));

    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error('expected refusal');
    expect(gate.reason).toBe('insufficient-space');
    expect(gate.message).toContain('Lochaber');
  });

  it('keeps headroom rather than filling the quota exactly', () => {
    // Just barely enough for the raw bytes, but no slack — quota is an estimate, and
    // running out at 99% wastes the entire transfer.
    const gate = evaluateGate(region, storage({ availableBytes: region.totalBytes + 1 }));
    expect(gate.allowed).toBe(false);
  });

  it('allows, but reports unknown headroom, when estimate() is unavailable', () => {
    // Refusing everywhere estimate() is missing would block downloads that work fine.
    const gate = evaluateGate(region, storage({ availableBytes: null }));
    expect(gate).toEqual({ allowed: true, availableBytes: null });
  });

  it('checks persistence before space, so the more fundamental problem is reported', () => {
    const gate = evaluateGate(region, storage({ persisted: false, availableBytes: 0 }));
    if (gate.allowed) throw new Error('expected refusal');
    expect(gate.reason).toBe('not-persisted');
  });
});
