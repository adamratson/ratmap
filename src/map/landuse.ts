import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import { layers as basemapLayers, type Flavor } from '@protomaps/basemaps';
import type { Theme } from '../ui/theme';
import { BUILDING_OUTLINE, ROAD_CLASS_FILL, STREAM_INK, ratmapFlavor } from './flavor';
import { PROTOMAPS_HUTS_WATER_KINDS } from '../overlays/huts-water';

/**
 * @protomaps/basemaps' own id for the settlement layer (city/town/village/hamlet, styled
 * by population_rank — see its base_layers.ts). Both the global catalog's copy and every
 * downloaded region's own copy (prefixed `region-<id>-`, see region-layers.ts) carry this
 * same base id, which is what lets peaks.ts and region-layers.ts each single it out for
 * label-collision priority over the peaks layer.
 */
export const TOWN_LABEL_LAYER_ID = 'places_locality';

/**
 * The first basemap layer drawn *over* the ground: streams and rivers, water, then
 * everything built — tunnels, buildings, roads, rail, bridges. Relief, contours, scree, walls and the region's other
 * ground detail go beneath it, the way a paper hill map prints them: a road is laid over
 * the contours, which stop at its edge, and a contour never crosses a loch.
 *
 * They used to go above every road, bridge and building, so at z13 a contour every 10 m
 * across the main road through a valley all but hid it.
 */
export const OVER_GROUND_FROM_LAYER_ID = 'water_stream';

/**
 * Whether one of the basemap's own layers (its id as ratmapBasemapLayers gives it, before
 * any region prefix) is drawn over the ground — see {@link OVER_GROUND_FROM_LAYER_ID}.
 * Labels are not: they have a place of their own, above everything.
 */
export function isOverGroundLayer(id: string): boolean {
  const order = basemapOrder();
  const index = order.ids.indexOf(id);
  return order.from >= 0 && index >= order.from && order.types[index] !== 'symbol';
}

// OSM `natural=bare_rock` rides in every basemap archive already — Protomaps' own
// `Landuse.java` puts it in the `landuse` source-layer as `kind: "bare_rock"` at
// minzoom 2, same as `wood`/`scrub`/`glacier`. But `landuse_park`, the layer that paints
// those siblings, has a hardcoded `kind` allowlist in @protomaps/basemaps' base_layers.ts
// that omits `bare_rock` — checked directly against that file, not assumed. So the
// geometry is there and simply never painted. This adds the missing rule rather than a
// new artifact or pipeline step.
//
// `natural=scree`/`shingle`/`boulder` are a different, harder problem: Protomaps only maps
// those to `bare_rock` via Overture data, not OSM ingestion, so they are not in this
// archive at all. See docs/IMPLEMENTATION.md for that follow-up.
function bareRockLayer(source: string, flavor: Flavor): LayerSpecification {
  return {
    id: 'landuse_bare_rock',
    type: 'fill',
    source,
    'source-layer': 'landuse',
    filter: ['==', ['get', 'kind'], 'bare_rock'],
    paint: {
      // Same fade-in as landuse_park, whose sibling this is in every way but the filter.
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0, 11, 1],
      'fill-color': flavor.landcover?.barren ?? '#c9c2b8',
    },
  };
}

/**
 * An outline for each building footprint, directly above Protomaps' own `buildings` fill.
 * The filter is the fill's own, copied rather than restated, so an upstream change to
 * what counts as a building moves both together.
 */
function buildingOutlineLayer(
  source: string,
  theme: Theme,
  fill: LayerSpecification | undefined,
): LayerSpecification {
  return {
    id: 'buildings_outline',
    type: 'line',
    source,
    'source-layer': 'buildings',
    ...(fill && 'filter' in fill && fill.filter ? { filter: fill.filter } : {}),
    paint: {
      'line-color': BUILDING_OUTLINE[theme],
      // Faded in rather than switched on: at z12 a town is a solid mat of footprints, and
      // outlining every one of them there would turn it into hatching.
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 17, 1, 19, 1.5],
    },
  };
}

/**
 * How wide each class of road is drawn, in CSS px at each zoom (exponential 1.6, as
 * upstream's own). Fill widths: a casing's gap is the same expression, so the edge sits
 * exactly on the fill.
 *
 * Wider than upstream from z12, and the minor roads most of all. Upstream's widths suit a
 * city map, where roads are the whole picture; a hill map's ground is busy with relief,
 * and a 0.5 px minor road on it was a hairline the 10 m contours outdrew. These are the
 * proportions of a printed 1:25 000 sheet, where a single-track road is still a road you
 * can see from arm's length.
 */
const ROAD_WIDTHS = {
  highway: [3, 0, 6, 1.1, 12, 2.6, 15, 5.5, 18, 16],
  major: [6, 0, 12, 2.2, 15, 4.6, 18, 14],
  link: [13, 0, 13.5, 1.2, 18, 11],
  minor: [11, 0, 12.5, 1.2, 15, 3.2, 18, 12],
  service: [13, 0, 15, 1.6, 18, 8],
} as const;

type RoadClass = keyof typeof ROAD_WIDTHS;

/** Which width class an upstream road layer draws — fill, casing, tunnel or bridge alike. */
function roadClass(id: string): RoadClass | null {
  const match = /^roads_(?:tunnels_|bridges_)?(highway|major|link|minor_service|minor)(?:_casing(?:_early|_late)?)?$/.exec(id);
  if (!match) return null;
  return match[1] === 'minor_service' ? 'service' : (match[1] as RoadClass);
}

function widthExpression(roadClassName: RoadClass): ExpressionSpecification {
  return ['interpolate', ['exponential', 1.6], ['zoom'], ...ROAD_WIDTHS[roadClassName]] as ExpressionSpecification;
}

/**
 * Main roads coloured by what they are — trunk and primary, secondary, the rest — the way
 * a paper map grades them, rather than one cream for all of them. Upstream keeps the OSM
 * class in `kind_detail` (checked on Andorra's tiles: trunk, primary, secondary, tertiary
 * and their links), and a road with none takes the flavour's own `major` colour.
 */
function majorFill(theme: Theme, fallback: unknown): ExpressionSpecification {
  const fill = ROAD_CLASS_FILL[theme];
  return [
    'match',
    ['get', 'kind_detail'],
    ['trunk', 'primary', 'trunk_link', 'primary_link'],
    fill.primary,
    ['secondary', 'secondary_link'],
    fill.secondary,
    typeof fallback === 'string' ? fallback : fill.secondary,
  ] as ExpressionSpecification;
}

/** Upstream's road layer with ratmap's widths, and main roads coloured by class. */
function retuneRoad(layer: LayerSpecification, theme: Theme): LayerSpecification {
  if (layer.type !== 'line') return layer;
  const roadClassName = roadClass(layer.id);
  if (!roadClassName) return layer;
  const paint = { ...layer.paint };
  const width = widthExpression(roadClassName);
  if (/_casing/.test(layer.id)) {
    // The casing's own stroke stays upstream's; the road it edges is what got wider.
    paint['line-gap-width'] = width;
  } else {
    paint['line-width'] = width;
    if (roadClassName === 'major' && !layer.id.startsWith('roads_tunnels_')) {
      paint['line-color'] = majorFill(theme, paint['line-color']);
    }
  }
  return { ...layer, paint } as LayerSpecification;
}

/**
 * Protomaps' POI layer, minus what src/overlays/huts-water.ts draws from the huts
 * artifact. Upstream draws `drinking_water` with its own sprite icon, from z16 where its
 * `min_zoom` says, so left alone a tap would show twice, in two styles. Every huts-and-water
 * kind is excluded, not just that one, so a later basemaps version that starts drawing a
 * hut cannot double it either. Wrapped rather than edited, so upstream's own filter stays whole whatever its
 * shape.
 */
function withoutHutsWater(pois: LayerSpecification): LayerSpecification {
  if (!('filter' in pois) || !pois.filter) return pois;
  return {
    ...pois,
    filter: ['all', pois.filter, ['!', ['in', ['get', 'kind'], ['literal', PROTOMAPS_HUTS_WATER_KINDS]]]],
  } as LayerSpecification;
}

/**
 * Protomaps' generated basemap layers, in ratmap's flavour, with what upstream leaves
 * unpainted spliced back in: the bare-rock fill right after `landuse_park` (same
 * source-layer, same z-order as the rest of the landuse fills, under roads and labels),
 * and an outline right after the `buildings` fill. Roads are widened and main roads
 * coloured by class (see {@link ROAD_WIDTHS}).
 * Drop-in replacement for `@protomaps/basemaps`' own `layers()`.
 *
 * Car parks are not drawn from here any more, though the basemap carries some: they come
 * from their own artifact, which has the small ones the basemap drops (see parking.ts).
 * Drinking water comes out of the POI layer too: huts-water.ts draws it with the huts.
 */
export function ratmapBasemapLayers(
  source: string,
  theme: Theme,
  options?: { labelsOnly?: boolean; lang?: string },
): LayerSpecification[] {
  const flavor = ratmapFlavor(theme);
  const generated = basemapLayers(source, flavor, options);
  const parkIndex = generated.findIndex((layer) => layer.id === 'landuse_park');
  generated.splice(parkIndex + 1, 0, bareRockLayer(source, flavor));
  const buildingsIndex = generated.findIndex((layer) => layer.id === 'buildings');
  // Guarded where the rock is not: a fill-less outline layer at position 0 would draw
  // every footprint's edge with no filter under the background. landuse.test.ts is what
  // notices the anchor going missing.
  if (buildingsIndex >= 0) {
    generated.splice(
      buildingsIndex + 1,
      0,
      buildingOutlineLayer(source, theme, generated[buildingsIndex]),
    );
  }
  const poisIndex = generated.findIndex((layer) => layer.id === 'pois');
  if (poisIndex >= 0) generated[poisIndex] = withoutHutsWater(generated[poisIndex]);
  return waterLinesUnderWater(generated).map((layer) =>
    retuneWater(retuneRoad(layer, theme), theme, flavor.water),
  );
}

/** The stream and river centreline layers, which run on through every lake they feed. */
const WATER_LINE_LAYER_IDS = ['water_stream', 'water_river'];

/**
 * Streams and rivers moved from just above the water fill to just beneath it. OSM carries a
 * river's centreline straight through every loch and reservoir it passes through (the Tees
 * across Cow Green), and upstream draws the lines over the fill: harmless while they were
 * the water's own colour, a line across the lake once they have an ink of their own. Under
 * the fill, a lake hides its river the way a paper map does.
 */
function waterLinesUnderWater(layers: LayerSpecification[]): LayerSpecification[] {
  const lines = layers.filter((layer) => WATER_LINE_LAYER_IDS.includes(layer.id));
  const rest = layers.filter((layer) => !WATER_LINE_LAYER_IDS.includes(layer.id));
  const water = rest.findIndex((layer) => layer.id === 'water');
  // No water layer (labelsOnly): nothing to go beneath, and no lines either.
  if (water < 0) return layers;
  return [...rest.slice(0, water), ...lines, ...rest.slice(water)];
}

/**
 * Streams and rivers in a blue of their own (STREAM_INK), wide enough to see. A river is
 * also a water polygon from about z14, where a dark line down its middle would read as a
 * channel, so its line fades back to the water colour by z15; a stream has no polygon to
 * fill it and keeps its line.
 */
function retuneWater(layer: LayerSpecification, theme: Theme, water: string): LayerSpecification {
  if (layer.type !== 'line') return layer;
  if (layer.id === 'water_stream') {
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'line-color': STREAM_INK[theme],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 14, 1, 16, 1.6, 18, 2.4],
      },
    } as LayerSpecification;
  }
  if (layer.id === 'water_river') {
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'line-color': ['interpolate', ['linear'], ['zoom'], 13, STREAM_INK[theme], 15, water],
      },
    } as LayerSpecification;
  }
  if (layer.id === 'roads_rail') {
    // Upstream's 0.5 left the dashes all but invisible on either theme.
    return { ...layer, paint: { ...layer.paint, 'line-opacity': 0.85 } } as LayerSpecification;
  }
  return layer;
}

let order: { ids: string[]; types: string[]; from: number } | null = null;

/**
 * The basemap's layer order, read from the generator itself so it can never drift from
 * what is actually drawn. Theme changes paint, not order.
 *
 * Should upstream ever rename the anchor, `from` is -1 and nothing counts as over the
 * ground: the relief and contours fall back to their old place under the paths, over the
 * roads — the old look, not a broken map. landuse.test.ts is what notices.
 */
function basemapOrder(): { ids: string[]; types: string[]; from: number } {
  if (order) return order;
  const layers = ratmapBasemapLayers('basemap', 'light');
  const ids = layers.map((layer) => layer.id);
  order = { ids, types: layers.map((layer) => layer.type), from: ids.indexOf(OVER_GROUND_FROM_LAYER_ID) };
  return order;
}
