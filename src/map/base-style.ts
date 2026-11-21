import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import {
  BASEMAP_MAX_ZOOM,
  BASEMAP_PMTILES_URL,
  FALLBACK_TERRAIN_RASTER_DEM_URL,
  GLYPHS_URL,
  OSM_ATTRIBUTION,
  SPRITE_URL,
  TERRAIN_ATTRIBUTION,
  TERRAIN_MAX_ZOOM,
  TERRAIN_PMTILES_URL,
  USE_FALLBACK_TERRAIN,
} from '../app/config';
import type { Theme } from '../ui/theme';
import { mapInk } from './flavor';
import { OVER_GROUND_FROM_LAYER_ID, ratmapBasemapLayers } from './landuse';
import type { TileSourceRegistry } from './tile-source-registry';

function terrainSource(registry: TileSourceRegistry): SourceSpecification {
  return USE_FALLBACK_TERRAIN
    ? {
        type: 'raster-dem',
        tiles: [FALLBACK_TERRAIN_RASTER_DEM_URL],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution: 'Terrain: AWS Open Data Terrain Tiles',
      }
    : {
        type: 'raster-dem',
        url: registry.sourceUrl(TERRAIN_PMTILES_URL),
        encoding: 'terrarium',
        // Coarse global extract — see config. Without this MapLibre asks for tiles above
        // the archive's real maxzoom and hillshade silently disappears when you zoom in.
        maxzoom: TERRAIN_MAX_ZOOM,
        attribution: TERRAIN_ATTRIBUTION,
      };
}

/**
 * The base style, for a given theme.
 *
 * A function rather than a literal because the theme is switchable at runtime and
 * Protomaps ships the flavours as whole layer sets — there is no per-layer paint property
 * to flip. Only the basemap and the terrain live here; everything the app adds on top
 * (peaks, routes, downloaded regions, coverage) is re-installed by main.ts's
 * installAppLayers.
 */
export function buildBaseStyle(theme: Theme, registry: TileSourceRegistry): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: SPRITE_URL,
    sources: {
      basemap: {
        type: 'vector',
        url: registry.sourceUrl(BASEMAP_PMTILES_URL),
        maxzoom: BASEMAP_MAX_ZOOM,
        attribution: OSM_ATTRIBUTION,
      },
      terrain: terrainSource(registry),
    },
    layers: withGroundBeneath(ratmapBasemapLayers('basemap', theme, { lang: 'en' }), {
      id: 'hillshade',
      type: 'hillshade',
      source: 'terrain',
      // Style-spec default is 0.5; dialled down 40% to match the region hillshade's own
      // reduction in region-layers.ts.
      paint: {
        'hillshade-exaggeration': 0.3,
        'hillshade-highlight-color': mapInk(theme).hillshadeHighlight,
        'hillshade-shadow-color': mapInk(theme).hillshadeShadow,
      },
    }),
  };
}

/**
 * The basemap with the relief spliced in under its water and everything built on it (see
 * OVER_GROUND_FROM_LAYER_ID).
 *
 * The hillshade used to be the style's last layer, over every road and every label — and,
 * since a downloaded region draws above the base style's fills but not above this, shading
 * the region's roads and text too, from a terrain archive blurred across a whole valley.
 */
function withGroundBeneath(
  basemap: LayerSpecification[],
  relief: LayerSpecification,
): LayerSpecification[] {
  const at = basemap.findIndex((layer) => layer.id === OVER_GROUND_FROM_LAYER_ID);
  // No anchor (an upstream rename): last, where it used to be, rather than nowhere.
  if (at < 0) return [...basemap, relief];
  return [...basemap.slice(0, at), relief, ...basemap.slice(at)];
}
