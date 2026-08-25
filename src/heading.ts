// Which way the phone is pointing.
//
// On a mountain the dot answers "where am I", but the question that actually matters
// standing at a junction in cloud is "which way am I facing" — without it, matching the
// map to the ground means walking twenty metres to see which way the dot moves.
//
// Built here rather than taken from MapLibre: unlike Mapbox GL JS, MapLibre GL JS v5's
// GeolocateControl has no `showUserHeading` and does not listen for device orientation at
// all (checked against the installed bundle, which contains no reference to
// `deviceorientation`).

/** Heading in degrees clockwise from true north, or null when it cannot be determined. */
export type Heading = number | null;

export type HeadingPermission = 'granted' | 'denied' | 'unsupported';

/**
 * Orientation fields this module reads, including the WebKit-only compass heading.
 *
 * Declared rather than imported: `webkitCompassHeading` is not in the DOM lib, and it is
 * the *only* reading on iOS that is relative to true north rather than to wherever the
 * page happened to be facing when the sensor started.
 */
interface OrientationReading {
  alpha: number | null;
  absolute: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/**
 * Convert a device-orientation reading into a compass heading.
 *
 * `screenAngle` is `screen.orientation.angle` — how far the *page* is rotated inside the
 * device. Without it, turning the phone to landscape reports a heading 90° out while the
 * user has not turned at all.
 */
export function headingFrom(reading: OrientationReading, screenAngle: number): Heading {
  // iOS. Already measured from true north, and the only trustworthy source there.
  if (typeof reading.webkitCompassHeading === 'number') {
    // A negative accuracy means the magnetometer is uncalibrated and the value is
    // meaningless — better no arrow than one confidently pointing the wrong way.
    if (typeof reading.webkitCompassAccuracy === 'number' && reading.webkitCompassAccuracy < 0) {
      return null;
    }
    return normalise(reading.webkitCompassHeading + screenAngle);
  }

  // Everywhere else. `alpha` only means anything against true north when the reading is
  // absolute; a relative one is measured from an arbitrary starting orientation, which
  // would draw an arrow that looks authoritative and is not.
  if (reading.absolute && typeof reading.alpha === 'number') {
    return normalise(360 - reading.alpha + screenAngle);
  }

  return null;
}

function normalise(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function screenAngle(): number {
  return screen?.orientation?.angle ?? 0;
}

/**
 * Watches the compass, asking permission first where that is required.
 *
 * iOS gates `deviceorientation` behind `DeviceOrientationEvent.requestPermission()`, which
 * must be called from a user gesture — so {@link start} has to be reached from a tap, not
 * from page load.
 */
export class HeadingWatcher {
  private readonly onChange: (heading: Heading) => void;
  private listening = false;
  private last: Heading = null;

  private readonly onOrientation = (event: Event): void => {
    const heading = headingFrom(event as unknown as OrientationReading, screenAngle());
    if (heading === null && this.last === null) return;
    // Whole degrees. The sensor jitters continuously and every change re-renders the
    // marker; sub-degree updates are noise that cost a frame each.
    if (heading !== null && this.last !== null && Math.round(heading) === Math.round(this.last)) {
      return;
    }
    this.last = heading;
    this.onChange(heading);
  };

  constructor(onChange: (heading: Heading) => void) {
    this.onChange = onChange;
  }

  async start(): Promise<HeadingPermission> {
    if (this.listening) return 'granted';
    if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';

    const requestPermission = (
      DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      }
    ).requestPermission;

    if (typeof requestPermission === 'function') {
      try {
        if ((await requestPermission()) !== 'granted') return 'denied';
      } catch {
        // Thrown when not called from a user gesture. Nothing to recover here — the
        // caller finds out that heading is simply unavailable.
        return 'denied';
      }
    }

    // `deviceorientationabsolute` is what Chromium fires with true-north-referenced
    // values; Safari fires only `deviceorientation`, carrying webkitCompassHeading. Both
    // are registered and headingFrom decides which reading it can trust.
    window.addEventListener('deviceorientationabsolute', this.onOrientation);
    window.addEventListener('deviceorientation', this.onOrientation);
    this.listening = true;
    return 'granted';
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener('deviceorientationabsolute', this.onOrientation);
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.listening = false;
    this.last = null;
    this.onChange(null);
  }
}
