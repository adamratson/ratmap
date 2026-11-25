import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { magneticField } from '../location/declination';
import { gridConvergence, nationalGrid } from '../print/grid';
import { bearingTo } from '../location/bearing';
import { formatDistance } from '../routes/geo';
import { cardinal, compassReadings, CompassView, formatBearing, type CompassPlace } from './compass-view';

const BEN_NEVIS: CompassPlace = { lng: -5.00361, lat: 56.79694 };
const NOW = new Date(Date.UTC(2026, 10, 25));

describe('formatBearing', () => {
  it('writes three figures, as a bearing is set on a compass', () => {
    expect(formatBearing(7)).toBe('007°');
    expect(formatBearing(47.4)).toBe('047°');
    expect(formatBearing(247)).toBe('247°');
  });

  it('never writes 360', () => {
    expect(formatBearing(359.6)).toBe('000°');
    expect(formatBearing(-1)).toBe('359°');
  });
});

describe('cardinal', () => {
  it('names sixteen points', () => {
    expect(cardinal(0)).toBe('N');
    expect(cardinal(22.5)).toBe('NNE');
    expect(cardinal(247.5)).toBe('WSW');
    expect(cardinal(350)).toBe('N');
  });
});

describe('compassReadings', () => {
  it('turns magnetic to true with the declination, and true to grid with the convergence', () => {
    const field = { declination: -3, declinationPerYear: 0, horizontal: 17_000 };
    const readings = compassReadings(100, BEN_NEVIS, field);
    expect(readings.magnetic).toBe(100);
    expect(readings.true).toBe(97);
    const convergence = gridConvergence(nationalGrid(), [BEN_NEVIS.lng, BEN_NEVIS.lat]);
    // West of the grid's central meridian, grid north is west of true: a grid bearing is larger.
    expect(convergence).toBeLessThan(0);
    expect(readings.grid).toBeCloseTo(97 - convergence, 9);
    expect(readings.gridName).toBe('OS National Grid');
  });

  it('leaves true and grid blank rather than guessing without a field', () => {
    const readings = compassReadings(100, BEN_NEVIS, null);
    expect(readings.true).toBeNull();
    expect(readings.grid).toBeNull();
  });

  it('names the UTM zone outside Britain', () => {
    expect(compassReadings(0, { lng: 6.86, lat: 45.83 }, null).gridName).toBe('UTM 32N');
  });
});

describe('the compass panel', () => {
  let body: HTMLElement;
  const text = (selector: string) => body.querySelector(selector)!.textContent;

  function orient(reading: Record<string, unknown>): void {
    const event = new Event('deviceorientation');
    Object.assign(event, { alpha: null, absolute: false, ...reading });
    window.dispatchEvent(event);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement('div');
    // jsdom has no DeviceOrientationEvent; a browser with one and no permission gate.
    vi.stubGlobal('DeviceOrientationEvent', class {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function opened(place: CompassPlace = BEN_NEVIS) {
    const view = new CompassView({ fix: () => ({ ...place, accuracyM: 8 }), centre: () => place, now: () => NOW, noReadingMs: 1000 });
    view.open(body);
    await vi.waitFor(() => expect(text('.compass-status')).toBe('Waiting for the compass…'));
    await Promise.resolve();
    return view;
  }

  it('shows the magnetic bearing as measured, and true and grid worked out from it', async () => {
    const view = await opened();
    orient({ webkitCompassHeading: 250, webkitCompassAccuracy: 10 });

    const field = magneticField(BEN_NEVIS.lat, BEN_NEVIS.lng, NOW)!;
    const expected = compassReadings(250, BEN_NEVIS, field);
    expect(text('.compass-heading-value')).toBe('250°');
    expect(text('.compass-heading-point')).toBe('WSW');
    expect(text('.compass-true')).toBe(formatBearing(expected.true!));
    expect(text('.compass-grid')).toBe(formatBearing(expected.grid!));
    expect(text('.compass-grid-name')).toBe('Grid (OS)');
    expect(text('.compass-accuracy')).toBe('±10°');
    expect(body.querySelector<HTMLElement>('.compass-status')!.hidden).toBe(true);
    view.close();
  });

  it('turns the card the short way past north', async () => {
    const view = await opened();
    const card = () => body.querySelector<SVGGElement>('.compass-card')!.style.transform;
    orient({ webkitCompassHeading: 359 });
    expect(card()).toBe('rotate(-359deg)');
    orient({ webkitCompassHeading: 1 });
    // Two degrees on, not 358 back.
    expect(card()).toBe('rotate(-361deg)');
    view.close();
  });

  it('says so when no reading ever arrives', async () => {
    const view = await opened();
    vi.advanceTimersByTime(1000);
    expect(text('.compass-status')).toMatch(/^No compass reading/);
    view.close();
  });

  it('asks for calibration when readings stop making sense', async () => {
    const view = await opened();
    orient({ webkitCompassHeading: 90 });
    orient({ webkitCompassHeading: 90, webkitCompassAccuracy: -1 });
    expect(text('.compass-status')).toMatch(/calibrating/);
    expect(text('.compass-heading-value')).toBe('—');
    view.close();
  });

  it('closes cleanly after the sheet has moved on to another view', async () => {
    const view = await opened();
    orient({ webkitCompassHeading: 10 });
    // SheetViews empties or replaces the body before telling the view it is gone.
    body.innerHTML = '<p>another view</p>';
    expect(() => view.close()).not.toThrow();
    expect(body.innerHTML).toBe('<p>another view</p>');
  });

  it('stops listening once closed', async () => {
    const view = await opened();
    view.close();
    orient({ webkitCompassHeading: 123 });
    expect(text('.compass-heading-value')).toBe('—');
  });

  describe('steering to a target', () => {
    const TARGET = { lng: -4.97, lat: 56.82, name: 'Carn Mòr Dearg' };
    const expected = () => bearingTo({ ...BEN_NEVIS, accuracyM: 8 }, [TARGET.lng, TARGET.lat], magneticField(BEN_NEVIS.lat, BEN_NEVIS.lng, NOW));

    it('gives the target’s magnetic bearing and distance from the fix, and marks it on the card', async () => {
      const view = await opened();
      view.setTarget(TARGET);
      const { magnetic, distanceM } = expected();
      expect(text('.compass-target-name')).toBe('Carn Mòr Dearg');
      expect(text('.compass-target-figures')).toBe(`${formatBearing(magnetic!)} · ${formatDistance(distanceM)}`);
      expect(body.querySelector<SVGGElement>('.compass-target')!.style.transform).toBe(`rotate(${magnetic}deg)`);
      view.close();
    });

    it('says which way to turn, the short way round, and when you are on it', async () => {
      const view = await opened();
      view.setTarget(TARGET);
      const target = expected().magnetic!;
      orient({ webkitCompassHeading: target - 30 });
      expect(text('.compass-steer')).toBe('Turn 30° right');
      orient({ webkitCompassHeading: target + 40 });
      expect(text('.compass-steer')).toBe('Turn 40° left');
      orient({ webkitCompassHeading: target + 3 });
      expect(text('.compass-steer')).toBe('On bearing');
      view.close();
    });

    it('waits for a fix rather than steering from the map centre', async () => {
      const view = new CompassView({ fix: () => null, centre: () => BEN_NEVIS, now: () => NOW });
      view.open(body);
      view.setTarget(TARGET);
      expect(text('.compass-target-figures')).toBe('Waiting for your position…');
      expect(body.querySelector<SVGGElement>('.compass-target')!.style.display).toBe('none');
      view.close();
    });

    it('stops steering when cleared, and keeps the target across reopening until then', async () => {
      const view = await opened();
      view.setTarget(TARGET);
      view.close();
      view.open(body);
      expect(body.querySelector<HTMLElement>('.compass-target-info')!.hidden).toBe(false);
      body.querySelector<HTMLButtonElement>('.compass-target-clear')!.click();
      expect(body.querySelector<HTMLElement>('.compass-target-info')!.hidden).toBe(true);
      expect(view.getTarget()).toBeNull();
      view.close();
    });

    it('offers no bearing to a target inside the fix’s own error', async () => {
      const view = await opened();
      view.setTarget({ ...BEN_NEVIS, name: 'Here' });
      orient({ webkitCompassHeading: 90 });
      expect(text('.compass-target-figures')).toBe('Within 10 m');
      expect(body.querySelector<HTMLElement>('.compass-steer')!.hidden).toBe(true);
      view.close();
    });
  });

  it('says when the browser has no compass at all', async () => {
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    const view = new CompassView({ fix: () => null, centre: () => BEN_NEVIS, now: () => NOW });
    view.open(body);
    await vi.waitFor(() => expect(text('.compass-status')).toMatch(/doesn’t give ratmap a compass/));
    view.close();
  });
});
