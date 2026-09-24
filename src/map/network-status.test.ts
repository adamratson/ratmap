import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { PEAKS_SOURCE_ID } from '../overlays/peaks';
import { isNetworkFailure, watchMapHealth } from './network-status';

describe('isNetworkFailure', () => {
  it('recognises how each engine reports a fetch that could not reach the network', () => {
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true); // Chrome
    expect(isNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true); // Firefox
    expect(isNetworkFailure(new TypeError('Load failed'))).toBe(true); // Safari
  });

  it('does not mistake a real fault for a lost connection', () => {
    // A TypeError is also what a genuine style or data bug throws; calling that "no
    // connection" would hide it.
    expect(isNetworkFailure(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isNetworkFailure(new Error("layer 'x' does not exist"))).toBe(false);
    expect(isNetworkFailure(undefined)).toBe(false);
  });
});

describe('watchMapHealth', () => {
  const handlers: Record<string, (e: unknown) => void> = {};
  const status = { setCondition: vi.fn() };

  beforeEach(() => {
    status.setCondition.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const map = { on: (event: string, handler: (e: unknown) => void) => void (handlers[event] = handler) };
    watchMapHealth(map as unknown as MLMap, status);
  });

  const tileArrived = (sourceId: string, state = 'loaded') =>
    handlers.sourcedata({ sourceId, tile: { state } });

  it('says "no connection" once as a condition, however many tiles fail', () => {
    for (let i = 0; i < 30; i++) handlers.error({ error: new TypeError('Failed to fetch') });

    const keys = new Set(status.setCondition.mock.calls.map(([key]) => key));
    expect(keys).toEqual(new Set(['offline']));
    expect(status.setCondition).toHaveBeenLastCalledWith('offline', expect.objectContaining({ kind: 'warn' }));
  });

  it('reports a genuine fault as an error, with what went wrong', () => {
    handlers.error({ error: new Error("layer 'x' does not exist") });

    expect(status.setCondition).toHaveBeenCalledWith(
      'map-error',
      expect.objectContaining({ kind: 'error', message: expect.stringContaining("layer 'x'") }),
    );
  });

  it('takes the notice down when a tile actually arrives over the network', () => {
    for (const source of ['basemap', 'terrain', PEAKS_SOURCE_ID]) {
      status.setCondition.mockClear();
      tileArrived(source);
      expect(status.setCondition).toHaveBeenCalledWith('offline', null);
    }
  });

  it('keeps it up when only a downloaded region’s tiles load — they work offline', () => {
    tileArrived('region-lochaber-basemap');
    expect(status.setCondition).not.toHaveBeenCalled();
  });

  it('keeps it up when a source merely stops asking, with nothing loaded', () => {
    tileArrived('basemap', 'errored');
    handlers.sourcedata({ sourceId: 'basemap', isSourceLoaded: true, tile: null });
    expect(status.setCondition).not.toHaveBeenCalled();
  });
});
