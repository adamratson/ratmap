import type { ExpressionSpecification, Map as MLMap } from 'maplibre-gl';
import { MAP_FONTS, type MapInk } from '../map/flavor';

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
// tags its numbered trails national. So the map does not draw a national route as more
// important than a regional one: nothing a walker could rely on would back that up. The
// level decides only when a route appears, and whether it stands out from the local ones.
//
// Each part answers one question, the same way at every zoom:
//
//   - **Where does it go?** National and regional routes are drawn as paths from z10, in
//     the path ink, two zooms before the rest of the network (the paths archive starts at
//     z12): the paths worth seeing while choosing a walk. Under the roads, so a stretch
//     along a road is the road. They hand over to the paths themselves at z12.
//   - **Is this path waymarked, and which way does the route go at a junction?** From z12,
//     a pale tint round the path, wider than the SAC grade band so a graded path on a route
//     shows both. Not below z12: there every path drawn is a route, and the tint would say
//     nothing. Local routes are a fainter tint than the rest. Around Grindelwald and
//     Zermatt 79-87% of route length is local (z12 tiles of switzerland-routes-1,
//     2026-11-27): in one tint a long route could not be followed through the signposted
//     network it crosses.
//   - **What do the signs call it?** The name along the line.
//
// There were OS-style diamonds on national routes. They told a walker nothing the name did
// not, appeared from z8 with no path under them, and at z14 were 13 px marks every 21 px
// along a 1.4 px path, drawn over the roads (2026-11-27). Gone.
//
// The tint is not a line beside the path: a route's ways run in whatever direction each
// was mapped, so an offset line would swap sides at every join. And not translucent:
// MapLibre draws every join of a line as its own fan, and where a path's vertices crowd
// together the overlapping fans of a translucent line built up into dark starbursts (seen
// along the West Highland Way at z12, 2026-11-18). So the tint is opaque, and lies under
// the hillshade and contours, which still read across it.

export const ROUTES_SOURCE_LAYER = 'routes';

/**
 * The two ways a route is drawn: national, international and regional routes, which come
 * in at z10 and take the stronger tint, and local ones.
 */
export type RouteTier = 'main' | 'local';

export interface RouteLegendEntry {
  tier: RouteTier;
  label: string;
  note: string;
}

export const ROUTES_LEGEND: readonly RouteLegendEntry[] = [
  {
    tier: 'main',
    label: 'National or regional route',
    note: 'Long-distance and regional trails such as the West Highland Way or the GR routes. Drawn as paths from zoom 10, before the rest of the network; tinted from zoom 12.',
  },
  {
    tier: 'local',
    label: 'Local route',
    note: 'Waymarked local walks, from zoom 12, in a fainter tint so a longer route can be followed through them. In some countries every signposted path.',
  },
];

/** From z10: national and regional routes, drawn as paths. */
export const ROUTES_MIN_ZOOM = 10;

/** Where the paths archive starts (build-paths.sh's -Z12): the routes become a tint round them. */
const TINT_ZOOM = 12;

export function routesLineLayerId(sourceId: string): string {
  return `${sourceId}-line`;
}

export function routesPathLayerId(sourceId: string): string {
  return `${sourceId}-path`;
}

export function routesPathCasingLayerId(sourceId: string): string {
  return `${sourceId}-path-casing`;
}

export function routesLabelLayerId(sourceId: string): string {
  return `${sourceId}-labels`;
}

const isLocal: ExpressionSpecification = ['!', ['in', ['get', 'network'], ['literal', ['iwn', 'nwn', 'rwn']]]];

/**
 * The tint round the path from z12, the national and regional routes drawn as paths at
 * z10-11, and the names along them.
 *
 * Each goes before its own anchor: the tint before `beforeLine`, under everything drawn over
 * the ground; the paths before `beforePath`, over the relief and water but under the roads;
 * the names before `beforeLabels`, with the region's other text.
 *
 * Names from z11 for national and regional routes, z14 for local ones: a Swiss local
 * route's name is often just the next signpost ("Grosse Scheidegg - Schreckfeld"), useful
 * close in and noise further out. Where two collide, the national or regional name places
 * first.
 */
export function addRoutesLayers(
  map: MLMap,
  sourceId: string,
  {
    minzoom,
    ink,
    beforeLine,
    beforePath,
    beforeLabels,
  }: { minzoom: number; ink: MapInk; beforeLine?: string; beforePath?: string; beforeLabels?: string },
): void {
  const base = { source: sourceId, 'source-layer': ROUTES_SOURCE_LAYER };

  map.addLayer(
    {
      ...base,
      id: routesLineLayerId(sourceId),
      type: 'line',
      minzoom: Math.max(TINT_ZOOM, minzoom),
      layout: {
        // Butt, not round: a route is many ways end to end, and round caps overlap at every
        // join. Butt ends meet flush.
        'line-cap': 'butt',
        'line-join': 'round',
        // The stronger tint over the fainter where a longer route shares a local one's path,
        // so it can be followed through.
        'line-sort-key': ['case', isLocal, 0, 1],
      },
      paint: {
        'line-color': ['case', isLocal, ink.walkRouteTint[1], ink.walkRouteTint[0]],
        // Wider than the SAC band (4-12 px, on the same exponential curve), so a ring of the
        // tint shows outside the grade: 3 px a side for a local route at z14.5, where at 1.2x
        // the band's width it was under 2 px and lost against the band.
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], TINT_ZOOM, 9, 16, 23],
      },
    },
    beforeLine,
  );

  // National and regional routes as paths at z10-11, in the paths' own ink and dash
  // (addPathLayers in src/regions/region-layers.ts), thinning to their z12 widths so the
  // hand-over to the paths archive does not show. Local routes are left out: they come in
  // at z12 with the rest of the network.
  const pathZooms = { minzoom: Math.max(ROUTES_MIN_ZOOM, minzoom), maxzoom: TINT_ZOOM };
  const notLocal = ['!', isLocal] as ExpressionSpecification;
  map.addLayer(
    {
      ...base,
      ...pathZooms,
      id: routesPathCasingLayerId(sourceId),
      type: 'line',
      filter: notLocal,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ink.pathCasing,
        'line-width': ['interpolate', ['linear'], ['zoom'], ROUTES_MIN_ZOOM, 1.6, TINT_ZOOM, 2],
      },
    },
    beforePath,
  );
  map.addLayer(
    {
      ...base,
      ...pathZooms,
      id: routesPathLayerId(sourceId),
      type: 'line',
      filter: notLocal,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ink.pathLine,
        'line-width': ['interpolate', ['linear'], ['zoom'], ROUTES_MIN_ZOOM, 0.8, TINT_ZOOM, 1],
        'line-dasharray': [2.5, 1.5],
      },
    },
    beforePath,
  );

  map.addLayer(
    {
      ...base,
      id: routesLabelLayerId(sourceId),
      type: 'symbol',
      minzoom: Math.max(11, minzoom),
      filter: ['has', 'name'],
      layout: {
        // The zoom step outermost: MapLibre allows ['zoom'] only as the input of a
        // top-level step or interpolate.
        'text-field': ['step', ['zoom'], ['case', isLocal, '', ['get', 'name']], 14, ['get', 'name']],
        'text-font': [MAP_FONTS.medium],
        'text-size': ['case', isLocal, 10, 10.5],
        'text-letter-spacing': 0.04,
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'symbol-sort-key': ['case', isLocal, 1, 0],
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

/** The tier as a legend swatch, in the inks the map uses: a path in its tint. */
export function routeSwatch(entry: RouteTier, ink: MapInk): string {
  const tint = ink.walkRouteTint[entry === 'local' ? 1 : 0];
  return (
    '<svg viewBox="0 0 40 24">' +
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${tint}" stroke-width="9" stroke-linecap="butt"/>` +
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${ink.pathCasing}" stroke-width="3.5" stroke-linecap="round"/>` +
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${ink.pathLine}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
    '</svg>'
  );
}
