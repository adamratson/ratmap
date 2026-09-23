import type { SourceSpecification, StyleSpecification } from 'maplibre-gl';
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
import { mapInk, ratmapFlavor } from './flavor';
import { basemapLayersWithBareRock } from './landuse';
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
    layers: [
      ...basemapLayersWithBareRock('basemap', ratmapFlavor(theme), { lang: 'en' }),
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain',
        // Style-spec default is 0.5; dialled down 10% to match the region hillshade's own
        // reduction in region-layers.ts.
        paint: {
          'hillshade-exaggeration': 0.45,
          'hillshade-highlight-color': mapInk(theme).hillshadeHighlight,
          'hillshade-shadow-color': mapInk(theme).hillshadeShadow,
        },
      },
    ],
  };
}
