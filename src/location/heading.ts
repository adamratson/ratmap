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
//
// **Every reading here is magnetic.** Both engines report the magnetometer's north and
// neither corrects for declination (checked 2026-11-25, §2):
// - WebKit fills `webkitCompassHeading` from `CLHeading.magneticHeading`, never
//   `trueHeading` (Source/WebCore/platform/ios/WebCoreMotionManager.mm).
// - Chromium on Android backs absolute orientation with `TYPE_ROTATION_VECTOR`, or an
//   accelerometer + magnetometer fusion (services/device/generic_sensor/), whose Y axis
//   Android documents as pointing "towards magnetic north"; nothing there applies a
//   `GeomagneticField`.
// The map is drawn to true north, so anything drawn on it goes through {@link trueHeading}.

import { COMPASS_UNRELIABLE_NT, type MagneticField } from './declination';

/** Heading in degrees clockwise from magnetic north, or null when it cannot be determined. */
export type Heading = number | null;

export type HeadingPermission = 'granted' | 'denied' | 'unsupported';

/**
 * Orientation fields this module reads, including the WebKit-only compass heading.
 *
 * Declared rather than imported: `webkitCompassHeading` is not in the DOM lib, and it is
 * the *only* reading on iOS that is relative to north at all rather than to wherever the
 * page happened to be facing when the sensor started.
 */
interface OrientationReading {
  alpha: number | null;
  absolute: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/**
 * Convert a device-orientation reading into a magnetic compass heading.
 *
 * `screenAngle` is `screen.orientation.angle` — how far the *page* is rotated inside the
 * device. Without it, turning the phone to landscape reports a heading 90° out while the
 * user has not turned at all.
 */
export function headingFrom(reading: OrientationReading, screenAngle: number): Heading {
  // iOS. Already a compass heading, from magnetic north, and the only trustworthy source there.
  if (typeof reading.webkitCompassHeading === 'number') {
    // A negative accuracy means the magnetometer is uncalibrated and the value is
    // meaningless — better no arrow than one confidently pointing the wrong way.
    if (typeof reading.webkitCompassAccuracy === 'number' && reading.webkitCompassAccuracy < 0) {
      return null;
    }
    return normalise(reading.webkitCompassHeading + screenAngle);
  }

  // Everywhere else. `alpha` only means anything against north when the reading is
  // absolute; a relative one is measured from an arbitrary starting orientation, which
  // would draw an arrow that looks authoritative and is not.
  if (reading.absolute && typeof reading.alpha === 'number') {
    return normalise(360 - reading.alpha + screenAngle);
  }

  return null;
}

/**
 * How far either way the iOS heading may be out, in degrees: CLHeading's own
 * `headingAccuracy`, passed through untouched by WebKit. Null where the platform gives
 * none (Chromium) or the reading is uncalibrated.
 */
export function accuracyFrom(reading: OrientationReading): number | null {
  const accuracy = reading.webkitCompassAccuracy;
  return typeof accuracy === 'number' && accuracy >= 0 ? accuracy : null;
}

/**
 * A magnetic heading turned to true north, for drawing on the map.
 *
 * Null without a field to correct by — an expired model, or the poles — and where the
 * field is too weak for a compass to mean anything: an arrow that is quietly a
 * declination out is the failure this exists to stop.
 */
export function trueHeading(magnetic: Heading, field: MagneticField | null): Heading {
  if (magnetic === null || field === null) return null;
  if (field.horizontal < COMPASS_UNRELIABLE_NT) return null;
  return normalise(magnetic + field.declination);
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
  private readonly onChange: (heading: Heading, accuracy: number | null) => void;
  private listening = false;
  private last: Heading = null;

  private readonly onOrientation = (event: Event): void => {
    const reading = event as unknown as OrientationReading;
    const heading = headingFrom(reading, screenAngle());
    if (heading === null && this.last === null) return;
    // Whole degrees. The sensor jitters continuously and every change re-renders the
    // marker; sub-degree updates are noise that cost a frame each.
    if (heading !== null && this.last !== null && Math.round(heading) === Math.round(this.last)) {
      return;
    }
    this.last = heading;
    this.onChange(heading, heading === null ? null : accuracyFrom(reading));
  };

  constructor(onChange: (heading: Heading, accuracy: number | null) => void) {
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
    this.onChange(null, null);
  }
}
