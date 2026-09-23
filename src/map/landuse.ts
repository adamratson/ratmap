import type { LayerSpecification } from 'maplibre-gl';
import { layers as basemapLayers, type Flavor } from '@protomaps/basemaps';

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
 * Protomaps' generated basemap layers, with the bare-rock fill spliced in right after
 * `landuse_park` — same source-layer, same z-order as the rest of the landuse fills,
 * under roads and labels. Drop-in replacement for `@protomaps/basemaps`' own `layers()`.
 */
export function basemapLayersWithBareRock(
  source: string,
  flavor: Flavor,
  options?: { labelsOnly?: boolean; lang?: string },
): LayerSpecification[] {
  const generated = basemapLayers(source, flavor, options);
  const parkIndex = generated.findIndex((layer) => layer.id === 'landuse_park');
  generated.splice(parkIndex + 1, 0, bareRockLayer(source, flavor));
  return generated;
}
