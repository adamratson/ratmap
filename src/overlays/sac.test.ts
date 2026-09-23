import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { SAC_GRADES, addSacLayers, sacGradeInfo, sacPathAt } from './sac';

function fakeMap(layerIds: string[], features: Array<Record<string, unknown>> = []) {
  return {
    getStyle: () => ({ layers: layerIds.map((id) => ({ id })) }),
    getLayer: (id: string) => (layerIds.includes(id) ? { id } : undefined),
    queryRenderedFeatures: vi.fn(() => features.map((properties) => ({ properties }))),
    addLayer: vi.fn(),
  } as unknown as MLMap & { queryRenderedFeatures: ReturnType<typeof vi.fn> };
}

describe('the scale', () => {
  it('covers T1 to T6, each with its own colour', () => {
    expect(SAC_GRADES.map((entry) => entry.grade)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(SAC_GRADES.map((entry) => entry.color)).size).toBe(6);
    expect(SAC_GRADES.map((entry) => entry.short)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
  });

  it('has no grade for a value outside the scale', () => {
    // The tiles cannot carry these — build-sac.sh drops them — and if that ever changes,
    // no grade is the right answer rather than the nearest one.
    for (const value of [0, 7, 2.5, '3', null, undefined]) {
      expect(sacGradeInfo(value)).toBeNull();
    }
    expect(sacGradeInfo(3)?.short).toBe('T3');
  });
});

describe('sacPathAt', () => {
  it('returns nothing before any region has added its layers', () => {
    // queryRenderedFeatures throws on an unknown layer id, and these layers come and go
    // with region downloads — so the tap handler must never name one blindly.
    const map = fakeMap([]);

    expect(sacPathAt(map, [10, 10])).toBeNull();
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
  });

  it('reads the grade of the path under the tap', () => {
    const map = fakeMap(['region-lochaber-sac-band'], [{ t: 4, name: 'Ledge Route' }]);

    const hit = sacPathAt(map, [10, 10], 0);

    expect(hit?.grade?.short).toBe('T4');
    expect(hit?.properties.name).toBe('Ledge Route');
  });

  it('reports the harder of two graded paths inside one tap box', () => {
    const map = fakeMap(['region-lochaber-sac-band'], [{ t: 2 }, { t: 5 }, { t: 3 }]);

    // Rounding down here would tell someone a T5 scramble is a T2 walk.
    expect(sacPathAt(map, [10, 10], 12)?.grade?.short).toBe('T5');
  });

  it('queries every downloaded region rather than one', () => {
    const map = fakeMap(
      ['region-lochaber-sac-band', 'region-cairngorms-sac-band', 'region-lochaber-sac-labels'],
      [{ t: 1 }],
    );

    sacPathAt(map, [10, 10], 0);

    expect(map.queryRenderedFeatures).toHaveBeenCalledWith(
      [10, 10],
      // The label layer is not a tap target: it is text, and the band is the wide one.
      { layers: ['region-lochaber-sac-band', 'region-cairngorms-sac-band'] },
    );
  });
});

describe('addSacLayers', () => {
  it('colours the band by grade, from the tiles own property', () => {
    const map = fakeMap([]);

    addSacLayers(map, 'region-lochaber-sac', { minzoom: 12 });

    const band = vi.mocked(map.addLayer).mock.calls[0][0] as unknown as Record<string, unknown>;
    const color = JSON.stringify((band.paint as Record<string, unknown>)['line-color']);
    for (const entry of SAC_GRADES) expect(color).toContain(entry.color);
    // A grade the ramp does not know must not borrow another grade's colour.
    expect(color).toContain('#8b8b8b');
  });
});
