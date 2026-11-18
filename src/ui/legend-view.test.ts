import { describe, expect, it } from 'vitest';
import { mapInk } from '../map/flavor';
import { SAC_GRADES } from '../overlays/sac';
import { SLOPE_CLASSES } from '../overlays/avalanche';
import { legendRow, lineSwatch, magneticNote, renderLegend } from './legend-view';

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

  it('says avalanche shading is off by default', () => {
    expect(legendFor('dark').textContent).toMatch(/Off by default/);
  });

  it('draws ground surface in the theme’s own ink, and never as individual boulders', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ink = mapInk(theme);
      const html = legendFor(theme).innerHTML;
      expect(html).toContain(ink.terrainDot);
      expect(html).toContain(ink.terrainRock);
    }
    expect(legendFor('dark').textContent).not.toMatch(/boulder\b(?! field)/i);
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

describe('magnetic north', () => {
  const now = new Date('2026-11-18T12:00:00Z');

  it('is worked out for the map centre, with what to do about it', () => {
    // Ben Nevis: 1.1° W in late 2026 (WMM2025).
    expect(magneticNote({ lat: 56.797, lng: -5.004, now })).toBe(
      'At the map centre, today. The map is drawn to true north. ' +
        'Magnetic north is 1.1° west of true north, moving 0.2° east a year. ' +
        'Add 1.1° to a bearing taken from the map before following it on a compass.',
    );
  });

  it('says the model has run out, rather than showing a value gone stale', () => {
    expect(magneticNote({ lat: 56.797, lng: -5.004, now: new Date('2030-03-01T00:00:00Z') })).toBe(
      'The magnetic model in this version of ratmap ran out on 1 January 2030. Update the app for current values.',
    );
  });

  it('has a section only when the legend knows where the map is', () => {
    const body = document.createElement('div');
    renderLegend(body, mapInk('light'));
    expect(body.querySelector('.legend-magnetic')).toBeNull();
    renderLegend(body, mapInk('light'), { lat: 46.02, lng: 7.75, now });
    expect(body.querySelector('.legend-magnetic')!.textContent).toContain('3.4° east of true north');
  });
});
