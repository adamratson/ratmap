import type { FilterSpecification, Map as MLMap, PointLike } from 'maplibre-gl';
import { OSM_ATTRIBUTION, PEAKS_MAX_ZOOM, PEAKS_PMTILES_URL } from './config';
import type { TileSourceRegistry } from './tile-source-registry';

// Summits overlay, backed by our own peaks-global.pmtiles — Protomaps v4 dropped `ele`
// from its POI layer (C6), so upstream peaks are unusable for a mountain map.
//
// `ele` arrives here already normalized to a number by infra/scripts/normalize-peaks.py;
// the raw OSM tag is free text ("~340", "1141m"). Keep the messy-input handling in the
// build pipeline, not in style expressions.

export const PEAKS_SOURCE_ID = 'peaks';
export const PEAKS_LAYER_ID = 'peaks-symbol';
export const PEAKS_SOURCE_LAYER = 'peaks';

/** The subset of properties the pipeline keeps (infra/scripts/build-peaks.sh). */
export interface PeakProperties {
  name?: string;
  /** Metres, already normalized to a number at build time. Absent if unparseable. */
  ele?: number;
  /**
   * Topographic prominence in metres, computed from the DEM at build time and quantised
   * to 20 m. Absent for peaks outside every built region. This is what the zoom filter
   * ranks on — see PEAKS_NOTABILITY_FILTER.
   */
  prom?: number;
  /** OSM's own prominence tag. Sparse; kept for reference, not used for filtering. */
  prominence?: string | number;
  wikidata?: string;
}

/** Human-readable elevation, or null when the peak has no usable one. */
export function formatElevation(ele: unknown): string | null {
  return typeof ele === 'number' && Number.isFinite(ele) ? `${Math.round(ele)} m` : null;
}

/**
 * Zoom-dependent notability filter. Without it every tagged bump renders at once and the
 * map is a solid mass of overlapping labels.
 *
 * Ranks on **topographic prominence**, not elevation. Elevation encodes an assumption
 * about local terrain and does not travel between regions: measured 2026-08-23, at
 * `ele >= 1000` Montenegro carries 268x Scotland's peaks per square degree, so any
 * threshold readable in one is unusable in the other. On prominence the same comparison
 * is 2.8x — which is a genuine difference in how mountainous the two places are, rather
 * than an artefact of the measure.
 *
 * `prom` is computed from the DEM at build time (infra/scripts/compute-prominence.py);
 * OSM's own `prominence` tag is far too sparse to filter on. Prominence also separates a
 * massif properly where elevation cannot: on Durmitor, Bobotov Kuk scores 1483 m against
 * Savin kuk's 93 m, though their elevations are 2523 m and 2313 m.
 */
export const PEAKS_NOTABILITY_FILTER = [
  'any',
  // Prominence is the primary gate. -1 is a sentinel for "no computed prominence" —
  // peaks outside every built region. The final step is -1, not 0, so those still appear
  // at the highest zoom: with a floor of 0 the sentinel never clears it and such peaks
  // would vanish from the map at every zoom rather than merely ranking last.
  [
    '>=',
    ['coalesce', ['get', 'prom'], -1],
    ['step', ['zoom'], 600, 9, 300, 11, 120, 13, 30, 15, -1],
  ],
  // `wikidata` is a tiebreaker from z9, not an override at every zoom. Applying it
  // globally floods country-level views in well-catalogued walking regions — verified
  // over the Highlands, where enough hills carry a Wikidata id to swamp z6 on their own.
  ['all', ['>=', ['zoom'], 9], ['has', 'wikidata']],
] as const;

export function addPeaksLayer(map: MLMap, registry: TileSourceRegistry): void {
  registry.addRemote(PEAKS_PMTILES_URL);

  map.addSource(PEAKS_SOURCE_ID, {
    type: 'vector',
    url: registry.sourceUrl(PEAKS_PMTILES_URL),
    // The archive only holds up to PEAKS_MAX_ZOOM; without this MapLibre requests tiles
    // that don't exist above it and the markers vanish when you zoom in.
    maxzoom: PEAKS_MAX_ZOOM,
    attribution: OSM_ATTRIBUTION,
  });

  map.addLayer({
    id: PEAKS_LAYER_ID,
    type: 'symbol',
    source: PEAKS_SOURCE_ID,
    'source-layer': PEAKS_SOURCE_LAYER,
    filter: PEAKS_NOTABILITY_FILTER as unknown as FilterSpecification,
    layout: {
      // Name on the first line, elevation on the second — dropped cleanly when either is
      // missing rather than leaving a stray separator or a blank line.
      'text-field': [
        'case',
        ['all', ['has', 'name'], ['has', 'ele']],
        ['concat', ['get', 'name'], '\n', ['to-string', ['round', ['get', 'ele']]], ' m'],
        ['has', 'name'],
        ['get', 'name'],
        ['has', 'ele'],
        ['concat', ['to-string', ['round', ['get', 'ele']]], ' m'],
        '',
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 0.6],
      'text-anchor': 'top',
      'text-optional': true,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#4a3524',
      'text-halo-color': 'rgba(255,255,255,0.9)',
      'text-halo-width': 1.2,
    },
  });

  // Separate circle layer for the marker itself — symbol layers can't draw both an icon
  // and text without a sprite image, and we don't have a peak sprite yet.
  map.addLayer(
    {
      id: `${PEAKS_LAYER_ID}-marker`,
      type: 'circle',
      source: PEAKS_SOURCE_ID,
      'source-layer': PEAKS_SOURCE_LAYER,
      // Same filter as the label layer — otherwise dots appear for peaks whose labels are
      // filtered out, which reads as a rendering bug.
      filter: PEAKS_NOTABILITY_FILTER as unknown as FilterSpecification,
      paint: {
        'circle-radius': ['step', ['zoom'], 2.5, 9, 3, 12, 4],
        'circle-color': '#7a4a2b',
        'circle-stroke-color': 'rgba(255,255,255,0.9)',
        'circle-stroke-width': 1,
      },
    },
    PEAKS_LAYER_ID,
  );
}

/**
 * Properties of the topmost peak at a screen point, or null if none is there.
 *
 * Queries only layers that currently exist: `queryRenderedFeatures` *throws* on an unknown
 * layer id rather than returning nothing. The peaks layers are added on the map's `load`
 * event, but pointer handlers are live from construction — so any mouse movement before
 * load (or after a style reload drops them) would otherwise raise "The layer
 * 'peaks-symbol' does not exist in the map's style and cannot be queried for features".
 */
export function peakAt(map: MLMap, point: PointLike): PeakProperties | null {
  const layers = [PEAKS_LAYER_ID, `${PEAKS_LAYER_ID}-marker`].filter((id) =>
    Boolean(map.getLayer(id)),
  );
  if (layers.length === 0) return null;

  const hits = map.queryRenderedFeatures(point, { layers });
  return hits.length > 0 ? (hits[0].properties as PeakProperties) : null;
}
