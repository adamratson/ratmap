import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LocationState } from './location';
import { PositionReadout } from './position-readout';

const tracking = (lng: number, lat: number, accuracy = 8): LocationState => ({
  status: 'tracking',
  position: { coords: { longitude: lng, latitude: lat, accuracy } } as GeolocationPosition,
});

describe('the position readout', () => {
  let readout: PositionReadout;
  let element: HTMLElement;
  let onSelect: Mock<(lngLat: [number, number]) => void>;

  beforeEach(() => {
    onSelect = vi.fn();
    readout = new PositionReadout({ onSelect });
    element = readout.onAdd();
  });

  it('stays hidden until there is a fix', () => {
    expect(element.hidden).toBe(true);
    readout.update({ status: 'locating' });
    expect(element.hidden).toBe(true);
  });

  it('shows the grid reference, lat/long and accuracy of the fix', () => {
    readout.update(tracking(-5.00361, 56.79694, 7.6));
    expect(element.hidden).toBe(false);
    expect(element.querySelector('.position-gridref')!.textContent).toBe('NN 1667 7129');
    expect(element.querySelector('.position-latlng')!.textContent).toBe('56.79694, -5.00361  ±8 m');
    expect(element.querySelector('button')!.getAttribute('aria-label')).toBe(
      'Your position, OS National Grid NN 1667 7129, 56.79694, -5.00361, accurate to 8 metres. Show details',
    );
  });

  it('hides again when the fix goes, rather than showing a stale one', () => {
    readout.update(tracking(-5, 56.8));
    readout.update({ status: 'idle' });
    expect(element.hidden).toBe(true);
    element.querySelector('button')!.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the fix’s details when tapped', () => {
    readout.update(tracking(-5, 56.8));
    element.querySelector('button')!.click();
    expect(onSelect).toHaveBeenCalledWith([-5, 56.8]);
  });

  it('leaves out the grid line where there is no grid', () => {
    readout.update(tracking(10, 85));
    expect(element.querySelector<HTMLElement>('.position-gridref')!.hidden).toBe(true);
    expect(element.querySelector('.position-latlng')!.textContent).toBe('85.00000, 10.00000  ±8 m');
  });
});
