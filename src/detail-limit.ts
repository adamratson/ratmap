// Makes the catalog-only zoom ceiling (§8.2) visible instead of silently showing a
// stretched, blurry map.
//
// The world catalog holds z0-5 and the global terrain z0-4. MapLibre happily overzooms
// past those, so at hiking zoom the basemap is a z5 tile stretched ~128x and the hillshade
// a z4 tile stretched ~256x — which reads as "the app is broken", not "this data doesn't
// exist here". Same principle as C1: never let the user believe they have something they
// don't.

export interface DetailLimitState {
  /** True when the viewport is asking for more detail than any archive actually holds. */
  overzoomed: boolean;
  /** Short label for the on-map pill; null when there's nothing to say. */
  label: string | null;
  /** Longer explanation, surfaced as a tooltip. */
  detail: string | null;
}

export function describeDetailLimit(zoom: number, maxDataZoom: number): DetailLimitState {
  // Fractional zooms below the ceiling still resolve real tiles; only flag once the
  // viewport has genuinely passed it.
  if (!Number.isFinite(zoom) || zoom <= maxDataZoom + 1) {
    return { overzoomed: false, label: null, detail: null };
  }

  return {
    overzoomed: true,
    label: 'Limited detail at this zoom',
    detail:
      `The worldwide map only carries data to zoom ${maxDataZoom}, so this view is ` +
      'enlarged rather than detailed. Full-detail maps arrive with downloadable offline ' +
      'regions.',
  };
}
