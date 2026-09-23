import type { Map as MLMap } from 'maplibre-gl';
import type { StatusCentre } from '../ui/status';
import { HeadingWatcher } from './heading';
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
}

export function setUpLocation({ map, button, status, onPosition, onDotClick }: LocationUiOptions): LocationController {
  const location: LocationController = new LocationController({
    map,
    onStateChange: (state) => renderLocationState(state),
    onDotClick: (position) => onDotClick([position.coords.longitude, position.coords.latitude]),
  });

  /**
   * The compass.
   *
   * Started from the button tap rather than at load, because iOS gates device orientation
   * behind a permission prompt that must be raised from a user gesture — asked for on page
   * load it is refused outright, and asked for before the user has shown any interest in
   * their own position it is a prompt with no context.
   */
  const heading = new HeadingWatcher((degrees) => location.setHeading(degrees));

  button.addEventListener('click', () => {
    if (location.isFollowing()) {
      location.stop();
      heading.stop();
    } else {
      location.start();
      // Not awaited and not reported: a missing compass costs the cone and nothing else,
      // and the dot is the thing that was actually asked for.
      void heading.start();
    }
  });

  // Any deliberate pan drops follow mode, so the map doesn't fight the user.
  map.on('dragstart', () => location.cancelFollow());

  function renderLocationState(state: LocationState): void {
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
        status.setCondition('location', {
          message: 'ratmap cannot see your location. Allow it in your browser settings.',
          kind: 'warn',
        });
        break;
      case 'unavailable':
        status.setCondition('location', {
          message: `No position fix yet: ${state.message}`,
          kind: 'warn',
        });
        break;
      default:
        status.setCondition('location', null);
    }
  }

  return location;
}
