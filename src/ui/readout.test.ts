import { describe, expect, it } from 'vitest';
import { fillReadout } from './readout';

function render(text: string): HTMLElement {
  const target = document.createElement('dd');
  fillReadout(target, text);
  return target;
}

describe('fillReadout', () => {
  it('splits a figure into value and unit', () => {
    const el = render('12.34 km');
    expect(el.querySelector('.readout-value')?.textContent).toBe('12.34');
    expect(el.querySelector('.readout-unit')?.textContent).toBe('km');
  });

  it("keeps textContent identical to the formatter's output", () => {
    for (const text of ['1046 m', '12.34 km', '45%', '1.3 GB', '-20 m', '25 min', '3 hr 20 min']) {
      expect(render(text).textContent).toBe(text);
    }
  });

  it('splits a figure written in two units into both', () => {
    const el = render('3 hr 20 min');
    expect([...el.querySelectorAll('.readout-value')].map((n) => n.textContent)).toEqual(['3', '20']);
    expect([...el.querySelectorAll('.readout-unit')].map((n) => n.textContent)).toEqual(['hr', 'min']);
  });

  it('writes anything that is not a figure as plain text', () => {
    for (const text of ['—', 'T3', 'Elevation unknown', 'less than a minute', '3 hr to go']) {
      const el = render(text);
      expect(el.textContent).toBe(text);
      expect(el.querySelector('.readout-value')).toBeNull();
    }
  });

  it('replaces what was there before, so re-rendering does not duplicate', () => {
    const target = document.createElement('p');
    fillReadout(target, '100 m');
    fillReadout(target, '200 m');
    expect(target.textContent).toBe('200 m');
    expect(target.classList.contains('readout')).toBe(true);
  });
});
