import type { Map as MLMap } from 'maplibre-gl';
import { PEAKS_SOURCE_ID } from '../overlays/peaks';
import type { StatusCentre } from '../ui/status';

// What the map says when drawing goes wrong: lost connection (an expected state for this
// app, said once) versus a genuine fault.

/**
 * A tile request that failed because the network is unreachable, as opposed to a genuine
 * map/style fault.
 *
 * Deliberately keyed off the error rather than `navigator.onLine`: that flag reports the
 * OS link state, not whether requests actually succeed, so it stays `true` behind a
 * captive portal, a dead uplink, or a dropped connection mid-hike — precisely this app's
 * situation. Verified during Phase 3 testing, where a fully offline map still reported
 * `navigator.onLine === true` and produced the wrong banner.
 */
export function isNetworkFailure(error: Error | undefined): boolean {
  // Matched on message, not on `name === 'TypeError'`: a real style or data bug throws
  // TypeErrors too, and misreporting those as "no connection" would hide actual faults.
  // These three messages are how Chrome, Firefox and Safari respectively report a failed
  // fetch.
  return /failed to fetch|networkerror|load failed/i.test(error?.message ?? '');
}

/**
 * The sources whose tiles actually come over the network.
 *
 * An allow-list rather than "anything that is not a geojson source": a downloaded region's
 * archives are ordinary vector and raster-dem sources read out of OPFS, and their tiles
 * load perfectly well with the radio off — which is precisely the situation the banner
 * exists to describe. Clearing it on those would take the warning away from the one user
 * who has most reason to see it.
 */
const REMOTE_SOURCE_IDS = new Set(['basemap', 'terrain', PEAKS_SOURCE_ID]);

export function watchMapHealth(map: MLMap, status: Pick<StatusCentre, 'setCondition'>): void {
  map.on('error', (e) => {
    console.error('MapLibre error', e.error);

    // MapLibre raises one error per failed tile, so an offline map produces dozens within a
    // second. As a condition rather than a message, re-reporting is free: the twentieth
    // failed tile replaces the first instead of stacking a twentieth banner.
    //
    // Losing signal is an expected state for this app, not a fault: say it once, plainly,
    // and take it back down when tiles start arriving again.
    if (isNetworkFailure(e.error)) {
      status.setCondition('offline', {
        message: 'No connection. Downloaded areas still work; everywhere else is blank.',
        kind: 'warn',
      });
      return;
    }

    status.setCondition('map-error', {
      message: `Something went wrong drawing the map: ${e.error?.message ?? 'unknown error'}`,
      kind: 'error',
    });
  });

  // Tiles arriving again is the only reliable signal that the connection is back:
  // `navigator.onLine` reports the OS link state and stays true behind a dead uplink, which
  // is exactly this app's situation (see isNetworkFailure above).
  map.on('sourcedata', (e) => {
    // A tile that actually *arrived*, rather than a source that has merely stopped asking.
    // This used to test `isSourceLoaded`, which flips true as soon as a source has no
    // outstanding requests — including when every one of them failed — and which the app's
    // own in-memory geojson sources (route geometry, the off-route line, the coverage
    // outlines) report unconditionally on every pan. Measured offline: the "No connection"
    // line went up and was retracted 2 ms later by the basemap reporting itself "loaded"
    // with nothing loaded at all, so in practice the banner was never visible.
    if (e.tile?.state !== 'loaded') return;
    if (!REMOTE_SOURCE_IDS.has(e.sourceId)) return;
    status.setCondition('offline', null);
  });
}
