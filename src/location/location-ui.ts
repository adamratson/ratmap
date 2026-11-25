import type { Map as MLMap } from 'maplibre-gl';
import type { StatusCentre } from '../ui/status';
import { fieldNear } from './declination';
import { HeadingWatcher, trueHeading } from './heading';
import type { ViewInset } from '../map/view-inset';
import { LocationController, type LocationState } from './location';

// The rail's locate button: the dot, follow mode, the compass cone, and what to say when
// there is no fix.

export interface LocationUiOptions {
  map: MLMap;
  button: HTMLButtonElement;
  status: Pick<StatusCentre, 'setCondition'>;
  /** Every fix while tracking, as [lng, lat]. */
  onPosition: (lngLat: [number, number]) => void;
  /** The location dot was tapped. */
  onDotClick: (lngLat: [number, number]) => void;
  viewInset?: () => ViewInset;
  /** No fix is coming: location refused, or failing. */
  onPositionUnavailable?: () => void;
  /** Every change of state, for whatever shows the fix itself (the position readout). */
  onStateChange?: (state: LocationState) => void;
}

export interface LocationUi {
  location: LocationController;
  /**
   * Show the dot and follow it, as the button does — and the compass with it. Call from a
   * tap: iOS only asks for the compass from one.
   */
  start(): void;
  /** Show the dot and fix the position, leaving the map where it is (LocationController.watch). */
  watch(): void;
}

export function setUpLocation({
  map,
  button,
  status,
  onPosition,
  onDotClick,
  viewInset,
  onPositionUnavailable,
  onStateChange,
}: LocationUiOptions): LocationUi {
  const location: LocationController = new LocationController({
    map,
    onStateChange: (state) => renderLocationState(state),
    onDotClick: (position) => onDotClick([position.coords.longitude, position.coords.latitude]),
    ...(viewInset ? { viewInset } : {}),
  });

  /**
   * The compass.
   *
   * Started from the button tap rather than at load, because iOS gates device orientation
   * behind a permission prompt that must be raised from a user gesture — asked for on page
   * load it is refused outright, and asked for before the user has shown any interest in
   * their own position it is a prompt with no context.
   */
  //
  // The sensor reads magnetic north and the map is drawn to true (heading.ts), so the cone
  // is turned by the declination where the dot is — or where the map is looking, for a
  // heading that arrives before the first fix.
  const heading = new HeadingWatcher((magnetic) => {
    const state = location.getState();
    const { lng, lat } =
      state.status === 'tracking'
        ? { lng: state.position.coords.longitude, lat: state.position.coords.latitude }
        : map.getCenter();
    location.setHeading(trueHeading(magnetic, fieldNear(lat, lng)));
  });

  const start = (): void => {
    location.start();
    // Not awaited and not reported: a missing compass costs the cone and nothing else,
    // and the dot is the thing that was actually asked for.
    void heading.start();
  };

  button.addEventListener('click', () => {
    if (location.isFollowing()) {
      location.stop();
      heading.stop();
    } else {
      start();
    }
  });

  // Any deliberate pan drops follow mode, so the map doesn't fight the user.
  map.on('dragstart', () => location.cancelFollow());

  function renderLocationState(state: LocationState): void {
    onStateChange?.(state);
    button.classList.toggle('active', location.isFollowing());

    // Route following runs off the same watch as the location dot rather than starting a
    // second one: two concurrent watchPosition calls double the GPS wake-ups for no extra
    // information, and battery is the binding constraint on a long day out.
    if (state.status === 'tracking') {
      onPosition([state.position.coords.longitude, state.position.coords.latitude]);
    }

    // A location failure is a state, not an event: it stays true until the permission or
    // the fix changes, and watchPosition re-reports it on every retry. As a toast that
    // meant a new banner every few seconds.
    // The rail button is an icon, and its state is carried by a class rather than by
    // rewriting its label — a control that changes width as it changes state shifts
    // everything next to it, and this one sits under a thumb.
    button.classList.toggle('locating', state.status === 'locating');
    button.setAttribute(
      'aria-label',
      location.isFollowing() ? 'Stop following my location' : 'Show my location',
    );

    switch (state.status) {
      case 'locating':
        status.setCondition('location', null);
        break;
      case 'tracking':
        status.setCondition('location', null);
        break;
      case 'denied':
        onPositionUnavailable?.();
        status.setCondition('location', {
          message: 'Location access is blocked in browser settings.',
          kind: 'warn',
        });
        break;
      case 'unavailable':
        onPositionUnavailable?.();
        status.setCondition('location', {
          message: `No position fix yet: ${state.message}`,
          kind: 'warn',
        });
        break;
      default:
        status.setCondition('location', null);
    }
  }

  return { location, start, watch: () => location.watch() };
}
