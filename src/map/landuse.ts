import type { LayerSpecification } from 'maplibre-gl';
import { layers as basemapLayers, type Flavor } from '@protomaps/basemaps';
import type { Theme } from '../ui/theme';
import { BUILDING_OUTLINE, ratmapFlavor } from './flavor';

/**
 * @protomaps/basemaps' own id for the settlement layer (city/town/village/hamlet, styled
 * by population_rank — see its base_layers.ts). Both the global catalog's copy and every
 * downloaded region's own copy (prefixed `region-<id>-`, see region-layers.ts) carry this
 * same base id, which is what lets peaks.ts and region-layers.ts each single it out for
 * label-collision priority over the peaks layer.
 */
export const TOWN_LABEL_LAYER_ID = 'places_locality';

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
 * Protomaps' generated basemap layers, in ratmap's flavour, with what upstream leaves
 * unpainted spliced back in: the bare-rock fill right after `landuse_park` (same
 * source-layer, same z-order as the rest of the landuse fills, under roads and labels),
 * and an outline right after the `buildings` fill.
 * Drop-in replacement for `@protomaps/basemaps`' own `layers()`.
 *
 * Car parks are not drawn from here any more, though the basemap carries some: they come
 * from their own artifact, which has the small ones the basemap drops (see parking.ts).
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
  return generated;
}
