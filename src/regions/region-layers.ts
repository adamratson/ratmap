import type { FilterSpecification, Map as MLMap } from 'maplibre-gl';
import { layers as basemapLayers, namedFlavor } from '@protomaps/basemaps';
import type { Region } from './manifest';
import { getArtifactFile } from './opfs-store';
import type { TileSourceRegistry } from '../tile-source-registry';
import { OSM_ATTRIBUTION, TERRAIN_ATTRIBUTION } from '../config';
import { PEAKS_LAYER_ID } from '../peaks';

// Renders a downloaded region *over* the low-zoom world catalog rather than replacing it,
// so panning outside the region degrades to the global view instead of falling off the
// edge of the map.
//
// Region archives carry far more zoom than the catalog (basemap z13, terrain z11 vs the
// catalog's z5/z4), which is the entire point — this is what fixes the "blurry at hiking
// zoom" problem the catalog-only decision (§8.2) creates.

const REGION_SOURCE_PREFIX = 'region';

export function regionSourceId(regionId: string, kind: string): string {
  return `${REGION_SOURCE_PREFIX}-${regionId}-${kind}`;
}

/**
 * Where a region's relief and contours belong in the layer stack: above the region's own
 * fills, below its labels.
 *
 * Everything used to be inserted at the peaks layer, which stacks each artifact on top of
 * the last. Artifacts are processed basemap → contours → terrain, so the hillshade landed
 * on top of the basemap's own labels and washed out the gully and corrie names on Ben
 * Nevis's north face.
 *
 * Region-scoped deliberately. Targeting the *first* symbol layer in the whole style would
 * pick a global-basemap label, which sits below the region's fills — burying the relief
 * under the region's own opaque earth and landcover instead of showing it.
 */
function beneathLabels(map: MLMap, regionId: string): string | undefined {
  const layers = map.getStyle().layers;
  const regionPrefix = `${REGION_SOURCE_PREFIX}-${regionId}-`;

  const regionLabel = layers.find(
    (layer) => layer.type === 'symbol' && layer.id.startsWith(regionPrefix),
  );
  if (regionLabel) return regionLabel.id;

  // No region labels yet (e.g. contours downloaded without a basemap): fall back to
  // sitting under the peaks, which is still better than on top of them.
  return map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined;
}

/**
 * Draw paths and tracks the way a hill map does, on top of Protomaps' own road layers.
 *
 * The generated `light` flavour renders paths as a 0.5 px `#ebebeb` line at z14 — a
 * near-white hairline on a near-white background, effectively invisible. That is a
 * reasonable default for a general-purpose basemap and completely wrong for a walking
 * map, where the paths are the single most important feature.
 *
 * A white casing under a dark dashed line keeps them readable over hillshade and contours
 * without competing with them. Tracks (vehicle-width) draw solid and slightly heavier than
 * footpaths, matching the usual convention.
 *
 * Styling call, not a settled decision — §8.3 is still open.
 */
function addPathLayers(map: MLMap, sourceId: string): void {
  const isPath: unknown = ['==', ['get', 'kind'], 'path'];
  const before = map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined;

  // Casing first, so the dashes above sit in a light channel and stay legible against
  // dark relief.
  map.addLayer(
    {
      id: `${sourceId}-paths-casing`,
      type: 'line',
      source: sourceId,
      'source-layer': 'roads',
      filter: isPath as FilterSpecification,
      minzoom: 12,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(255,255,255,0.85)',
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 2, 16, 6],
      },
    },
    before,
  );

  map.addLayer(
    {
      id: `${sourceId}-paths`,
      type: 'line',
      source: sourceId,
      'source-layer': 'roads',
      filter: isPath as FilterSpecification,
      minzoom: 12,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#8a3d2e',
        'line-width': [
          'interpolate',
          ['exponential', 1.5],
          ['zoom'],
          12,
          ['case', ['==', ['get', 'kind_detail'], 'track'], 1.4, 1],
          16,
          ['case', ['==', ['get', 'kind_detail'], 'track'], 3.5, 2.4],
        ],
        // Tracks solid, footpaths dashed — the usual walking-map distinction.
        'line-dasharray': [
          'case',
          ['==', ['get', 'kind_detail'], 'track'],
          ['literal', [1, 0]],
          ['literal', [2.5, 1.5]],
        ],
      },
    },
    before,
  );
}

function regionLayerIds(map: MLMap, regionId: string): string[] {
  return map
    .getStyle()
    .layers.map((layer) => layer.id)
    .filter((id) => id.startsWith(`${REGION_SOURCE_PREFIX}-${regionId}-`));
}

/**
 * Register a downloaded region's archives with the TileSourceRegistry and add its layers.
 * Idempotent — safe to call again after a style reload or a repeat download.
 */
export async function addRegionToMap(
  map: MLMap,
  registry: TileSourceRegistry,
  region: Region,
): Promise<void> {
  for (const artifact of region.artifacts) {
    const file = await getArtifactFile(artifact.filename);
    if (!file) continue;

    // C3 in practice: FileSource.getKey() returns file.name, so the registry key is the
    // artifact filename — which the build pipeline guarantees is globally unique.
    registry.addLocal(file);
    const sourceId = regionSourceId(region.id, artifact.kind);
    const url = registry.sourceUrl(artifact.filename);

    if (map.getSource(sourceId)) continue;

    if (artifact.kind === 'terrain') {
      map.addSource(sourceId, {
        type: 'raster-dem',
        url,
        encoding: 'terrarium',
        attribution: TERRAIN_ATTRIBUTION,
      });
      map.addLayer(
        {
          id: `${sourceId}-hillshade`,
          type: 'hillshade',
          source: sourceId,
          paint: {
            // Region terrain tops out around z11 while the basemap and contours go to
            // z13/z14, so at hiking zoom the DEM is being stretched and turns into dark
            // smeared blobs that compete with the contour lines. Fade the relief out as
            // it becomes unreliable and let contours carry the elevation story, which is
            // what a paper hill map does anyway.
            //
            // Styling call, not a settled decision — §8.3 is still open.
            'hillshade-exaggeration': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              0.5,
              14,
              0.15,
            ],
          },
        },
        // Under every label, not just under the peaks — see beneathLabels().
        beneathLabels(map, region.id),
      );
    } else if (artifact.kind === 'basemap') {
      map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });

      // Reuse the same Protomaps style generator as the global basemap so the region
      // looks identical, just sharper — rather than maintaining a second stylesheet.
      //
      // Source-bound layers only. `layers()` also emits a `background` layer, which is
      // viewport-filling rather than tile-bound: adding a region's copy of it painted flat
      // #cccccc over the entire global map, leaving only the area with region tiles
      // visible. A style needs exactly one background, and the global basemap already
      // supplies it.
      const generated = basemapLayers(sourceId, namedFlavor('light'), { lang: 'en' });
      for (const layer of generated) {
        if (!('source' in layer) || !layer.source) continue;
        const scoped = { ...layer, id: `${sourceId}-${layer.id}` };
        map.addLayer(scoped, map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined);
      }

      addPathLayers(map, sourceId);
    } else if (artifact.kind === 'contours') {
      map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });
      map.addLayer(
        {
          id: `${sourceId}-lines`,
          type: 'line',
          source: sourceId,
          'source-layer': 'contours',
          paint: {
            'line-color': 'rgba(120, 85, 55, 0.55)',
            // Index contours (every 5th) are drawn heavier, as on a paper map.
            //
            // `idx`, not `index`, and compared to 1, not true: build-contours.sh tags them
            // via SQLite, which yields an integer 0/1 under the alias `idx`. The original
            // expression matched neither the name nor the type, so every contour silently
            // drew at the thin weight and the emphasis never appeared.
            'line-width': ['case', ['==', ['get', 'idx'], 1], 1.2, 0.6],
          },
        },
        // Contour lines drawn over place names would be just as unreadable as relief
        // over them, so these go under the labels too.
        beneathLabels(map, region.id),
      );

      addContourLabels(map, sourceId, region.id);
    }
  }
}

/**
 * Height annotations along the index contours, as on a paper hill map.
 *
 * Index contours only (`idx == 1`, every 50 m). Labelling all of them at a 10 m interval
 * would put five times as much text on the map for no extra information — the intermediate
 * lines are read by counting up from an annotated one, which is the whole reason index
 * contours are drawn heavier in the first place.
 *
 * Styling call, not a settled decision — §8.3 is still open.
 */
function addContourLabels(map: MLMap, sourceId: string, regionId: string): void {
  map.addLayer(
    {
      id: `${sourceId}-labels`,
      type: 'symbol',
      source: sourceId,
      'source-layer': 'contours',
      filter: ['==', ['get', 'idx'], 1] as unknown as FilterSpecification,
      // Below this the index lines are close enough together that labels collide more
      // than they inform; contour tiles themselves only start at z11.
      minzoom: 13,
      layout: {
        // Bare number, no unit: the convention on hill maps, and on a sheet already
        // covered in contours the unit is never ambiguous. Peak labels keep "m" because
        // there they sit alone against terrain.
        'text-field': ['to-string', ['round', ['get', 'ele']]],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        // Drawn along the line and rotated with it, the way a contour label reads on
        // paper, rather than sitting horizontally beside it.
        'symbol-placement': 'line',
        // Well above the 250 px default: a contour can wander a long way across the
        // viewport and repeating its height every few centimetres is just noise.
        'symbol-spacing': 500,
        // Contours curve hard around a corrie; the 45° default rejects placement there
        // and whole lines end up unlabelled.
        'text-max-angle': 60,
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: {
        'text-color': '#6b4a33',
        // The halo is what stands in for breaking the line behind the label, which
        // MapLibre cannot do — without it the contour runs straight through the digits.
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.6,
      },
    },
    beneathLabels(map, regionId),
  );
}

/** Remove a region's layers and sources — used when the user deletes a download. */
export function removeRegionFromMap(map: MLMap, region: Region): void {
  for (const layerId of regionLayerIds(map, region.id)) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const artifact of region.artifacts) {
    const sourceId = regionSourceId(region.id, artifact.kind);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
}
