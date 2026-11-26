import type { ExpressionSpecification, Map as MLMap } from 'maplibre-gl';
import { MAP_FONTS, type MapInk } from '../map/flavor';
import { ensureShapeImage, type Shape } from './icon-shapes';

// Named walking routes: the West Highland Way, the GR and Wanderland routes, the E-paths,
// a village's waymarked loop. OSM route relations, which neither the Protomaps basemap nor
// our paths artifact carries, so they ride on their own artifact,
// `<region>-routes-1.pmtiles`, built by infra/scripts/build-routes.sh and cut per region
// like the huts (C16).
//
// Each feature is a route's ways joined end to end (infra/scripts/tools/cmd/normalize-routes),
// each way drawn as the most important route it is on: `network`, OSM's level — iwn, nwn,
// rwn or lwn — and `name`, the route's name, its parent trail's for a stage, or its ref
// where it has no name (Italy's CAI trails are numbered rather than named).
//
// **The level is OSM's, and means different things in different countries.** Switzerland's
// 24,494 local routes are its whole signposted network cut signpost to signpost; Montenegro
// tags its numbered trails national. So the map draws three tiers and says no more than
// that: international and national routes, regional ones, and local ones from z12 only.
//
// National and international routes are a chain of violet diamonds along the path, the
// OS Explorer's mark for a long-distance trail, from z8 down: the one way of marking a
// route that cannot be mistaken for anything else on the map. Regional and local routes,
// far more of them, are quieter. From z12, where the paths are drawn, a route is a pale
// tint around its path — the corridor a paper map shades along a trail — wider than the
// SAC grade band, so a graded path on a named route shows both. Below z12, where no path
// is drawn, it is a plain line: the trail is what is worth seeing while choosing one.
//
// Not a line beside the path: a route's ways run in whatever direction each was mapped, so
// an offset line would swap sides at every join. And not translucent: MapLibre draws every
// join of a line as its own fan, and where a path's vertices crowd together the overlapping
// fans of a translucent line built up into dark starbursts (seen along the West Highland
// Way at z12, 2026-11-18). So the tint is opaque, and lies under the hillshade and contours,
// which still read across it.

export const ROUTES_SOURCE_LAYER = 'routes';

/** The tiers the map draws, most important first. */
export type RouteTier = 'national' | 'regional' | 'local';

export interface RouteLegendEntry {
  tier: RouteTier;
  label: string;
  note: string;
}

export const ROUTES_LEGEND: readonly RouteLegendEntry[] = [
  {
    tier: 'national',
    label: 'National or international route',
    note: 'Long-distance trails such as the West Highland Way or the E-paths, marked with diamonds as on OS maps. From zoom 8.',
  },
  {
    tier: 'regional',
    label: 'Regional route',
    note: 'From zoom 8.',
  },
  {
    tier: 'local',
    label: 'Local route',
    note: 'Waymarked local walks. From zoom 12; in some countries every signposted path.',
  },
];

/** From z8, the routes archive's own floor (build-routes.sh's -Z8). */
export const ROUTES_MIN_ZOOM = 8;

/** Where paths start being drawn, and the line becomes a tint around them. */
const HALO_ZOOM = 12;

export function routesLineLayerId(sourceId: string): string {
  return `${sourceId}-line`;
}

export function routesLabelLayerId(sourceId: string): string {
  return `${sourceId}-labels`;
}

export function routesDiamondLayerId(sourceId: string): string {
  return `${sourceId}-diamonds`;
}

/** The diamond, on the icon grid: a square on its point. */
const DIAMOND: Shape = { fills: [[[16, 5], [27, 16], [16, 27], [5, 16]]] };
/** CSS px the diamond image is drawn at; icon-size scales it with the zoom. */
const DIAMOND_SIZE = 14;

function diamondColors(ink: MapInk) {
  return { glyph: ink.walkNational, rim: ink.landmarkRim };
}

const tier: ExpressionSpecification = [
  'match',
  ['get', 'network'],
  ['iwn', 'nwn'],
  'national',
  'rwn',
  'regional',
  'local',
];

/** A value per tier, for paint and layout expressions. */
function byTier(national: number, regional: number, local: number): ExpressionSpecification {
  return ['match', tier, 'national', national, 'regional', regional, local];
}

/**
 * The route line or corridor (regional and local routes), the diamonds (national ones), and
 * the route names along them.
 *
 * The diamonds go with the labels' anchor, above every line, so a path never strikes
 * through one; they never collide with anything, so they take no label's place.
 *
 * Names from z11 for national and regional routes, z14 for local ones: a Swiss local
 * route's name is often just the next signpost ("Grosse Scheidegg - Schreckfeld"), useful
 * close in and noise further out. National names place first.
 */
export function addRoutesLayers(
  map: MLMap,
  sourceId: string,
  {
    minzoom,
    ink,
    beforeLine,
    beforeLabels,
  }: { minzoom: number; ink: MapInk; beforeLine?: string; beforeLabels?: string },
): void {
  map.addLayer(
    {
      id: routesLineLayerId(sourceId),
      type: 'line',
      source: sourceId,
      'source-layer': ROUTES_SOURCE_LAYER,
      minzoom: Math.max(ROUTES_MIN_ZOOM, minzoom),
      filter: ['!=', tier, 'national'],
      layout: {
        // Butt, not round: a route is many ways end to end, and translucent round caps
        // overlap at every join, a darker bead each (seen at z12 along the West Highland
        // Way). Butt ends meet flush.
        'line-cap': 'butt',
        'line-join': 'round',
        'line-sort-key': byTier(0, 1, 0),
      },
      paint: {
        // The route ink as a line; its tier's tint once it is a corridor round a path.
        'line-color': [
          'step',
          ['zoom'],
          ink.walkRoute,
          HALO_ZOOM,
          ['match', tier, 'regional', ink.walkRouteTint[0], ink.walkRouteTint[1]],
        ],
        // National values unused: those routes are the diamonds.
        // Wider than the SAC band (4-12 px, on the same exponential curve) from z12, so a
        // ring of the tint shows outside the grade: 3 px a side for a local route at z14.5,
        // where at 1.2x the band's width it was under 2 px and lost against the band.
        'line-width': [
          'interpolate',
          ['exponential', 1.5],
          ['zoom'],
          ROUTES_MIN_ZOOM,
          byTier(1.6, 1.2, 1),
          HALO_ZOOM - 1,
          byTier(2.6, 2, 1.6),
          HALO_ZOOM,
          byTier(10, 9, 8),
          16,
          byTier(26, 23, 20),
        ],
      },
    },
    beforeLine,
  );

  map.addLayer(
    {
      id: routesDiamondLayerId(sourceId),
      type: 'symbol',
      source: sourceId,
      'source-layer': ROUTES_SOURCE_LAYER,
      minzoom: Math.max(ROUTES_MIN_ZOOM, minzoom),
      filter: ['==', tier, 'national'],
      layout: {
        'icon-image': ensureShapeImage(map, 'ratmap-route-diamond', DIAMOND, diamondColors(ink), DIAMOND_SIZE),
        'symbol-placement': 'line',
        // Close enough to read as a chain, not as scattered marks: about one diamond's
        // width of gap at z12, a little more further in.
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 8, 12, 12, 16, 16, 26],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 0.8, 16, 1.1],
        // Upright whichever way the path runs, as on the OS map. Turned with the path, a
        // diamond on a diagonal stretch was a square.
        'icon-rotation-alignment': 'viewport',
        'icon-pitch-alignment': 'viewport',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
    beforeLabels,
  );

  map.addLayer(
    {
      id: routesLabelLayerId(sourceId),
      type: 'symbol',
      source: sourceId,
      'source-layer': ROUTES_SOURCE_LAYER,
      minzoom: Math.max(11, minzoom),
      filter: ['has', 'name'],
      layout: {
        // The zoom step outermost: MapLibre allows ['zoom'] only as the input of a
        // top-level step or interpolate.
        'text-field': [
          'step',
          ['zoom'],
          ['case', ['==', tier, 'local'], '', ['get', 'name']],
          14,
          ['get', 'name'],
        ],
        'text-font': [MAP_FONTS.medium],
        'text-size': byTier(11, 10.5, 10),
        'text-letter-spacing': 0.04,
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'symbol-sort-key': byTier(0, 1, 2),
        // 60, as for the grade and contour labels: at 45 a trail's switchbacks rejected
        // nearly every placement (the West Highland Way unnamed from z11 to z13 over
        // Kinlochleven, 2026-11-18).
        'text-max-angle': 60,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ink.walkRouteText,
        'text-halo-color': ink.labelHalo,
        'text-halo-width': 1.6,
      },
    },
    beforeLabels,
  );
}

/** The tier as a legend swatch, in the inks the map uses: diamonds along a path, or a tint round one. */
export function routeSwatch(entry: RouteTier, ink: MapInk): string {
  const path =
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${ink.pathCasing}" stroke-width="3.5" stroke-linecap="round"/>` +
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${ink.pathLine}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  if (entry === 'national') {
    const { glyph, rim } = diamondColors(ink);
    const diamond = (x: number) => `<polygon points="${x},8 ${x + 5},12 ${x},16 ${x - 5},12"/>`;
    const diamonds = [9, 20, 31].map(diamond).join('');
    return (
      '<svg viewBox="0 0 40 24">' +
      path +
      `<g fill="${glyph}" stroke="${rim}" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke">${diamonds}</g>` +
      '</svg>'
    );
  }
  const i = entry === 'regional' ? 0 : 1;
  return (
    '<svg viewBox="0 0 40 24">' +
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${ink.walkRouteTint[i]}" stroke-width="${[10, 9][i]}" stroke-linecap="butt"/>` +
    path +
    '</svg>'
  );
}
