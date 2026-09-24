import { describe, expect, it } from 'vitest';
import { mapInk } from '../map/flavor';
import { SAC_GRADES } from '../overlays/sac';
import { SLOPE_CLASSES } from '../overlays/avalanche';
import { TERRAIN_FEATURE_KINDS } from '../overlays/terrain-features';
import { legendRow, lineSwatch, renderLegend } from './legend-view';

function legendFor(theme: 'light' | 'dark'): HTMLElement {
  const body = document.createElement('div');
  renderLegend(body, mapInk(theme));
  return body;
}

describe('renderLegend', () => {
  it('draws its swatches in the inks the map uses for the theme showing', () => {
    // A hardcoded swatch is how the legend drifted from the map before: violet summits and
    // a blue route, long after the map had moved on.
    for (const theme of ['light', 'dark'] as const) {
      const html = legendFor(theme).innerHTML;
      const ink = mapInk(theme);
      for (const colour of [ink.peakDot, ink.pathLine, ink.contour, ink.routeLine, ink.routeStraight, ink.offRoute]) {
        expect(html).toContain(colour);
      }
    }
  });

  it('lists every SAC grade and every slope class the map can draw', () => {
    const labels = [...legendFor('dark').querySelectorAll('.legend-row-label')].map((l) => l.textContent);

    for (const entry of SAC_GRADES) expect(labels).toContain(`${entry.short} · ${entry.label}`);
    for (const entry of SLOPE_CLASSES) expect(labels).toContain(entry.label);
  });

  it('says an ungraded path is untagged, not easy', () => {
    expect(legendFor('dark').textContent).toMatch(/unbanded path is untagged, not necessarily easy/);
  });

  it('says avalanche shading is terrain, not a forecast, and where to switch it on', () => {
    const text = legendFor('dark').textContent!;
    expect(text).toMatch(/This is terrain, not a forecast/);
    expect(text).toMatch(/switch it on in Layers/);
  });

  it('uses each ground-surface kind’s own colour', () => {
    const html = legendFor('dark').innerHTML;
    for (const entry of TERRAIN_FEATURE_KINDS.slice(0, 3)) expect(html).toContain(entry.fillColor);
  });
});

describe('lineSwatch', () => {
  it('draws a casing under the line only when given one', () => {
    expect(lineSwatch('#111', 2).match(/<line/g)).toHaveLength(1);

    const cased = lineSwatch('#111', 2, { casing: '#fff' });
    expect(cased.match(/<line/g)).toHaveLength(2);
    // Casing first, so the line is drawn over it, and wider than the line it frames.
    expect(cased.indexOf('#fff')).toBeLessThan(cased.indexOf('#111'));
    expect(cased).toContain('stroke-width="5"');
  });

  it('dashes the line when asked', () => {
    expect(lineSwatch('#111', 2, { dash: '4 3' })).toContain('stroke-dasharray="4 3"');
  });
});

describe('legendRow', () => {
  it('pairs a swatch with a label and a note', () => {
    const row = document.createElement('div');
    row.innerHTML = legendRow('<svg></svg>', 'Footpath', 'Dashed.');

    expect(row.querySelector('.legend-swatch svg')).not.toBeNull();
    expect(row.querySelector('.legend-row-label')!.textContent).toBe('Footpath');
    expect(row.querySelector('.legend-row-note')!.textContent).toBe('Dashed.');
  });
});
