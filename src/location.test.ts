import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';

const { MarkerMock, markerInstances } = vi.hoisted(() => {
  const markerInstances: Array<{ lngLat: unknown; removed: boolean }> = [];
  class MarkerMock {
    private record = { lngLat: null as unknown, removed: false };
    constructor() {
      markerInstances.push(this.record);
    }
    setLngLat(lngLat: unknown): this {
      this.record.lngLat = lngLat;
      return this;
    }
    addTo(): this {
      return this;
    }
    remove(): void {
      this.record.removed = true;
    }
  }
  return { MarkerMock, markerInstances };
});

vi.mock('maplibre-gl', () => ({ default: { Marker: MarkerMock } }));

const { LocationController } = await import('./location');

function fakeMap() {
  return {
    easeTo: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getSource: vi.fn().mockReturnValue(undefined),
    getLayer: vi.fn().mockReturnValue(undefined),
    removeSource: vi.fn(),
    removeLayer: vi.fn(),
    isStyleLoaded: vi.fn().mockReturnValue(true),
  } as unknown as MLMap;
}

function position(lat = 56.8, lng = -4.5, accuracy = 20): GeolocationPosition {
  return {
    coords: { latitude: lat, longitude: lng, accuracy },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

function stubGeolocation() {
  const callbacks: {
    success?: PositionCallback;
    error?: PositionErrorCallback;
  } = {};
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((success: PositionCallback, error: PositionErrorCallback) => {
    callbacks.success = success;
    callbacks.error = error;
    return 42;
  });
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch },
    configurable: true,
  });
  return { callbacks, watchPosition, clearWatch };
}

beforeEach(() => {
  markerInstances.length = 0;
});

describe('LocationController', () => {
  it('reports unavailable rather than throwing when geolocation is missing', () => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    const onStateChange = vi.fn();

    new LocationController({ map: fakeMap(), onStateChange }).start();

    expect(onStateChange.mock.lastCall?.[0]).toMatchObject({ status: 'unavailable' });
  });

  it('tracks position, renders a dot, and follows the fix', () => {
    const { callbacks } = stubGeolocation();
    const map = fakeMap();
    const controller = new LocationController({ map });

    controller.start();
    expect(controller.getState().status).toBe('locating');

    callbacks.success!(position());

    expect(controller.getState().status).toBe('tracking');
    expect(markerInstances).toHaveLength(1);
    expect(map.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-4.5, 56.8] }),
    );
  });

  it('reuses one marker across fixes instead of stacking new ones', () => {
    const { callbacks } = stubGeolocation();
    const controller = new LocationController({ map: fakeMap() });
    controller.start();

    callbacks.success!(position(56.8, -4.5));
    callbacks.success!(position(56.9, -4.4));

    expect(markerInstances).toHaveLength(1);
    expect(markerInstances[0].lngLat).toEqual([-4.4, 56.9]);
  });

  it('stops recentring after the user pans, but keeps the dot live', () => {
    const { callbacks } = stubGeolocation();
    const map = fakeMap();
    const controller = new LocationController({ map });
    controller.start();
    callbacks.success!(position());
    vi.mocked(map.easeTo).mockClear();

    controller.cancelFollow();
    callbacks.success!(position(57.0, -4.0));

    expect(controller.isFollowing()).toBe(false);
    // Dot still updates...
    expect(markerInstances[0].lngLat).toEqual([-4.0, 57.0]);
    // ...but the camera is left where the user put it.
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it('does not register a second watch when start() is called again', () => {
    const { watchPosition, callbacks } = stubGeolocation();
    const controller = new LocationController({ map: fakeMap() });

    controller.start();
    callbacks.success!(position());
    controller.start();

    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(controller.isFollowing()).toBe(true);
  });

  it('clears the watch and removes the dot on stop', () => {
    const { clearWatch, callbacks } = stubGeolocation();
    const controller = new LocationController({ map: fakeMap() });
    controller.start();
    callbacks.success!(position());

    controller.stop();

    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(markerInstances[0].removed).toBe(true);
    expect(controller.getState().status).toBe('idle');
  });

  it('surfaces permission denial distinctly from other failures', () => {
    const { callbacks } = stubGeolocation();
    const controller = new LocationController({ map: fakeMap() });
    controller.start();

    callbacks.error!({ code: 1, PERMISSION_DENIED: 1, message: 'nope' } as GeolocationPositionError);

    expect(controller.getState().status).toBe('denied');
  });

  it('reports non-permission errors as unavailable with the underlying message', () => {
    const { callbacks } = stubGeolocation();
    const controller = new LocationController({ map: fakeMap() });
    controller.start();

    callbacks.error!({
      code: 2,
      PERMISSION_DENIED: 1,
      message: 'no signal',
    } as GeolocationPositionError);

    expect(controller.getState()).toMatchObject({ status: 'unavailable', message: 'no signal' });
  });
});
