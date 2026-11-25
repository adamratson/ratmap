import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { LocationControllerOptions, LocationState } from './location';
import type { StatusCentre } from '../ui/status';

const fakes = vi.hoisted(() => ({
  controller: null as null | {
    options: LocationControllerOptions;
    following: boolean;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cancelFollow: ReturnType<typeof vi.fn>;
    setHeading: ReturnType<typeof vi.fn>;
    state: LocationState;
  },
  heading: null as null | { onHeading: (degrees: number) => void; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> },
}));

vi.mock('./location', () => ({
  LocationController: class {
    options: LocationControllerOptions;
    following = false;
    start = vi.fn(() => void (this.following = true));
    stop = vi.fn(() => void (this.following = false));
    cancelFollow = vi.fn();
    setHeading = vi.fn();
    state: LocationState = { status: 'idle' };
    getState = () => this.state;
    isFollowing = () => this.following;
    constructor(options: LocationControllerOptions) {
      this.options = options;
      fakes.controller = this;
    }
  },
}));

vi.mock('./heading', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./heading')>()),
  HeadingWatcher: class {
    onHeading: (degrees: number) => void;
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor(onHeading: (degrees: number) => void) {
      this.onHeading = onHeading;
      fakes.heading = this;
    }
  },
}));

const { setUpLocation } = await import('./location-ui');
const { magneticField } = await import('./declination');

let button: HTMLButtonElement;
let status: { setCondition: Mock<StatusCentre['setCondition']> };
let onPosition: Mock<(lngLat: [number, number]) => void>;
let onDotClick: Mock<(lngLat: [number, number]) => void>;
let mapHandlers: Record<string, () => void>;

const position = (lng: number, lat: number) =>
  ({ coords: { longitude: lng, latitude: lat } }) as GeolocationPosition;
const report = (state: LocationState) => fakes.controller!.options.onStateChange!(state);

beforeEach(() => {
  button = document.createElement('button');
  status = { setCondition: vi.fn() };
  onPosition = vi.fn();
  onDotClick = vi.fn();
  mapHandlers = {};
  const map = {
    on: (event: string, handler: () => void) => void (mapHandlers[event] = handler),
    // Svalbard, where the declination is big enough to see.
    getCenter: () => ({ lng: 15.6, lat: 78.2 }),
  };
  setUpLocation({ map: map as unknown as MLMap, button, status, onPosition, onDotClick });
});

describe('the locate button', () => {
  it('starts the dot and the compass together, and stops both', () => {
    button.click();
    expect(fakes.controller!.start).toHaveBeenCalled();
    expect(fakes.heading!.start).toHaveBeenCalled();

    button.click();
    expect(fakes.controller!.stop).toHaveBeenCalled();
    expect(fakes.heading!.stop).toHaveBeenCalled();
  });

  it('turns the magnetic heading to true north for the dot, where the dot is', () => {
    // Nowhere near the map centre: the fix is what counts once there is one.
    fakes.controller!.state = { status: 'tracking', position: position(-5, 56.8) };
    fakes.heading!.onHeading(270);
    const field = magneticField(56.8, -5, new Date())!;
    expect(fakes.controller!.setHeading.mock.calls[0]![0]).toBeCloseTo(270 + field.declination, 6);
  });

  it('uses the map centre for a heading that comes before the first fix', () => {
    fakes.heading!.onHeading(0);
    const field = magneticField(78.2, 15.6, new Date())!;
    // Svalbard's declination is well over a degree, so this cannot pass by accident.
    expect(Math.abs(field.declination)).toBeGreaterThan(5);
    expect(fakes.controller!.setHeading.mock.calls[0]![0]).toBeCloseTo((field.declination + 360) % 360, 6);
  });

  it('stops following when the map is dragged, so it does not fight the user', () => {
    mapHandlers.dragstart();
    expect(fakes.controller!.cancelFollow).toHaveBeenCalled();
  });

  it('says what it will do next, as its label', () => {
    button.click();
    report({ status: 'locating' });
    expect(button.getAttribute('aria-label')).toBe('Stop following my location');
    expect(button.classList.contains('locating')).toBe(true);

    button.click();
    report({ status: 'idle' });
    expect(button.getAttribute('aria-label')).toBe('Show my location');
  });
});

describe('location states', () => {
  it('passes each fix on as [lng, lat], for route following', () => {
    report({ status: 'tracking', position: position(-5.0, 56.8) });
    expect(onPosition).toHaveBeenCalledWith([-5.0, 56.8]);
  });

  it('turns a refusal into a standing condition that says where it is blocked', () => {
    report({ status: 'denied' });
    expect(status.setCondition).toHaveBeenCalledWith(
      'location',
      expect.objectContaining({ kind: 'warn', message: expect.stringMatching(/browser settings/) }),
    );
  });

  it('says why there is no fix, and clears it once there is one', () => {
    report({ status: 'unavailable', message: 'Timeout expired' });
    expect(status.setCondition).toHaveBeenLastCalledWith(
      'location',
      expect.objectContaining({ message: 'No position fix yet: Timeout expired' }),
    );

    report({ status: 'tracking', position: position(0, 0) });
    expect(status.setCondition).toHaveBeenLastCalledWith('location', null);
  });

  it('hands a tap on the dot on as [lng, lat]', () => {
    fakes.controller!.options.onDotClick!(position(-5.0, 56.8));
    expect(onDotClick).toHaveBeenCalledWith([-5.0, 56.8]);
  });
});
