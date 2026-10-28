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

/**
 * `fromRegion` says whose ceiling `maxDataZoom` is: a downloaded region's, or the worldwide
 * map's. Past a region's own ceiling there is nothing further to download, and the
 * explanation must not send the user off looking for one.
 */
export function describeDetailLimit(
  zoom: number,
  maxDataZoom: number,
  { fromRegion = false }: { fromRegion?: boolean } = {},
): DetailLimitState {
  // Fractional zooms below the ceiling still resolve real tiles; only flag once the
  // viewport has genuinely passed it.
  if (!Number.isFinite(zoom) || zoom <= maxDataZoom + 1) {
    return { overzoomed: false, label: null, detail: null };
  }

  if (fromRegion) {
    return {
      overzoomed: true,
      label: 'Limited detail at this zoom',
      detail:
        `This downloaded region’s data stops at zoom ${maxDataZoom}; this view is enlarged.`,
    };
  }

  return {
    overzoomed: true,
    label: 'Limited detail at this zoom',
    detail:
      `Worldwide map data stops at zoom ${maxDataZoom}; offline regions have full detail.`,
  };
}
