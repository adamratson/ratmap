import type { FilterSpecification, Map as MLMap } from 'maplibre-gl';
import { MAP_FONTS, mapInk, ratmapFlavor, type MapInk } from '../flavor';
import type { Theme } from '../theme';
import { basemapLayersWithBareRock, TOWN_LABEL_LAYER_ID } from '../landuse';
import type { Region } from './manifest';
import { getArtifactFile } from './opfs-store';
import type { TileSourceRegistry } from '../tile-source-registry';
import { COPERNICUS_ATTRIBUTION, OSM_ATTRIBUTION, TERRAIN_ATTRIBUTION } from '../config';
import { PEAKS_LAYER_ID } from '../peaks';
import { addSacLayers } from '../sac';
import { addAvalancheLayer, avalancheSourceSpec } from '../avalanche';
import { addTerrainFeatureLayers } from '../terrain-features';
import { applyAllStoredVisibility } from '../layers';

// Renders a downloaded region *over* the low-zoom world catalog rather than replacing it,
// so panning outside the region degrades to the global view instead of falling off the
// edge of the map.
//
// Region archives carry far more zoom than the catalog (basemap z13, terrain z11 vs the
// catalog's z5/z4), which is the entire point — this is what fixes the "blurry at hiking
// zoom" problem the catalog-only decision (§8.2) creates.

const REGION_SOURCE_PREFIX = 'region';

/** Layer name inside `<region>-paths.pmtiles`, set by infra/scripts/build-paths.sh. */
const PATHS_SOURCE_LAYER = 'paths';

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
function beneathLabels(map: MLMap, region: Region): string | undefined {
  const regionLabel = regionLayerIds(map, region).find(
    (id) => map.getLayer(id)?.type === 'symbol',
  );
  if (regionLabel) return regionLabel;

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
 * Used for two different sources, which is why the layer and filter are parameters: the
 * region basemap's `roads` layer above z14, and our own low-zoom `paths` artifact below
 * it (see the `paths` branch in addRegionToMap). One set of paint expressions so the
 * handoff between them is invisible — both read `kind_detail` for the track/footpath
 * distinction, which is why build-paths.sh emits that Protomaps property name rather than
 * one of its own.
 *
 * Styling call, not a settled decision — §8.3 is still open.
 */
function addPathLayers(
  map: MLMap,
  sourceId: string,
  {
    sourceLayer,
    filter,
    minzoom,
    maxzoom,
    ink,
  }: {
    sourceLayer: string;
    filter?: FilterSpecification;
    minzoom: number;
    maxzoom?: number;
    ink: MapInk;
  },
): void {
  const before = map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined;
  const zooms = { minzoom, ...(maxzoom === undefined ? {} : { maxzoom }) };

  // Casing first, so the line above sits in its own channel and stays legible against
  // relief — light by day, graphite at night (see mapInk()).
  map.addLayer(
    {
      id: `${sourceId}-paths-casing`,
      type: 'line',
      source: sourceId,
      'source-layer': sourceLayer,
      ...(filter ? { filter } : {}),
      ...zooms,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ink.pathCasing,
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
      'source-layer': sourceLayer,
      ...(filter ? { filter } : {}),
      ...zooms,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ink.pathLine,
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

/**
 * Zoom at which the region basemap starts carrying paths.
 *
 * Not a preference — a property of the data. Protomaps tags paths `min_zoom: 14` and
 * thins them out below it: measured on `scotland-basemap.pmtiles` over Ben Nevis
 * (2026-09-08), the z14 tile holds 2 path features, the z13 tile holds 1, and the z12
 * tile holds none at all. Below this zoom the network has to come from somewhere else.
 */
const BASEMAP_PATHS_MIN_ZOOM = 14;

/**
 * The zoom below which a region's own layers must not draw.
 *
 * `pmtiles extract --bbox` keeps whole upstream tiles rather than re-clipping their
 * contents, so a region archive's low-zoom tiles are ordinary planet tiles that merely
 * *intersect* the region. Montenegro's z5 basemap tile spans 11.25° x 7.9° — Vienna to
 * Athens — and 85 of its 88 place labels fall outside the region (verified 2026-08-24 by
 * decoding it). Drawing it over the global catalog painted exactly that rectangle onto
 * the map: a hard-edged box across Romania and Bulgaria, with the region's opaque fills
 * burying the global hillshade inside it and the region's own hillshade doubling up.
 *
 * Suppressing them costs no detail. These tiles come from the same two upstream archives
 * the global catalog and global terrain are themselves extracted from, so below this
 * threshold the region is showing a duplicate of what is already on screen.
 *
 * The threshold is where a source tile stops being wider than the region, which bounds
 * the overhang to about one region-width instead of a continent.
 */
function regionMinZoom([west, south, east, north]: Region['bbox']): number {
  const span = Math.max(east - west, north - south);
  return Math.ceil(Math.log2(360 / span));
}

/**
 * A region's layers, in style order, found by the exact sources they draw from.
 *
 * Not by id prefix: region ids can be prefixes of each other — the catalogue has both
 * `england-east` and `england-east-midlands`, `sachsen` and `sachsen-anhalt` — so
 * `region-england-east-` also matched every East Midlands layer. Deleting East England
 * stripped the East Midlands of its layers while leaving its sources, and it went blank
 * until a reload.
 *
 * `getLayersOrder()` + `getLayer()` rather than `getStyle()`, which serialises the entire
 * style, and this runs once for every layer a region adds.
 */
function regionLayerIds(map: MLMap, region: Region): string[] {
  const sources = new Set(region.artifacts.map((artifact) => regionSourceId(region.id, artifact.kind)));
  return map.getLayersOrder().filter((id) => {
    const source = (map.getLayer(id) as { source?: unknown } | undefined)?.source;
    return typeof source === 'string' && sources.has(source);
  });
}

/**
 * Register a downloaded region's archives with the TileSourceRegistry and add its layers.
 * Idempotent — safe to call again after a style reload or a repeat download.
 *
 * `theme` is required, not defaulted: this used to hardcode the light flavour, which drew
 * a downloaded region as a light patch on the dark map. A default would bring that back
 * for whichever caller forgot. A theme change needs no extra handling here, since it
 * replaces the whole style and installAppLayers re-adds every region with the new theme.
 */
export async function addRegionToMap(
  map: MLMap,
  registry: TileSourceRegistry,
  region: Region,
  theme: Theme,
): Promise<void> {
  const minzoom = regionMinZoom(region.bbox);
  const ink = mapInk(theme);

  // Decided up front rather than by mutating the basemap's layers once the `paths`
  // artifact is reached: `setLayerZoomRange` throws "Style is not done loading" if it
  // lands while the style is still loading, and this runs at startup and again after
  // every download — so that version could abort a restore partway through and leave
  // regions undrawn, which is the failure this whole path exists to avoid. Reading the
  // artifact list is free and cannot throw.
  const hasLowZoomPaths = region.artifacts.some((artifact) => artifact.kind === 'paths');
  const basemapPathsMin = Math.max(hasLowZoomPaths ? BASEMAP_PATHS_MIN_ZOOM : 12, minzoom);

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
          minzoom,
          paint: {
            // Region terrain tops out around z11 while the basemap and contours go to
            // z13/z14, so at hiking zoom the DEM is being stretched and turns into dark
            // smeared blobs that compete with the contour lines. Fade the relief out as
            // it becomes unreliable and let contours carry the elevation story, which is
            // what a paper hill map does anyway.
            //
            // Both stops dialled down 10% (0.5→0.45, 0.15→0.135) — the relief was
            // competing with the contour lines even before the smearing kicks in.
            //
            // Styling call, not a settled decision — §8.3 is still open.
            'hillshade-exaggeration': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              0.45,
              14,
              0.135,
            ],
            'hillshade-highlight-color': ink.hillshadeHighlight,
            'hillshade-shadow-color': ink.hillshadeShadow,
          },
        },
        // Under every label, not just under the peaks — see beneathLabels().
        beneathLabels(map, region),
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
      const generated = basemapLayersWithBareRock(sourceId, ratmapFlavor(theme), { lang: 'en' });
      const beforePeaks = map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined;
      // The region's own town/city labels need the same collision priority over peaks as
      // the global catalog's do (see peaks.ts) — otherwise a downloaded region's real
      // Keswick/Penrith-level detail still loses to the Lake District's fell density,
      // because everything in this loop would otherwise land *before* peaks-symbol in
      // layer order and MapLibre gives placement priority to whatever's later (on top).
      // Anchoring against the catalog's own TOWN_LABEL_LAYER_ID — which peaks.ts already
      // placed peaks-symbol directly beneath — lands this region's copy right alongside
      // it, one layer above peaks-symbol, rather than one layer below it.
      const beforeTownLabels = map.getLayer(TOWN_LABEL_LAYER_ID) ? TOWN_LABEL_LAYER_ID : beforePeaks;
      for (const layer of generated) {
        if (!('source' in layer) || !layer.source) continue;
        const scoped = {
          ...layer,
          id: `${sourceId}-${layer.id}`,
          minzoom: Math.max(layer.minzoom ?? 0, minzoom),
        };
        const beforeId = layer.id === TOWN_LABEL_LAYER_ID ? beforeTownLabels : beforePeaks;
        map.addLayer(scoped, beforeId);
      }

      addPathLayers(map, sourceId, {
        ink,
        sourceLayer: 'roads',
        filter: ['==', ['get', 'kind'], 'path'] as unknown as FilterSpecification,
        // With the low-zoom artifact present this starts where that one stops, so the two
        // never draw the same way twice — a duplicated translucent casing reads brighter,
        // not invisible. Without it, 12: a region downloaded before that artifact existed
        // keeps drawing whatever few paths its z12-13 tiles do carry.
        minzoom: basemapPathsMin,
      });
    } else if (artifact.kind === 'contours') {
      // Copernicus, not OSM. These lines are traced from Copernicus GLO-30 by
      // build-contours.sh; crediting OpenStreetMap for them was both wrong and a licence
      // gap, since the Copernicus terms require attribution of their own.
      map.addSource(sourceId, { type: 'vector', url, attribution: COPERNICUS_ATTRIBUTION });

      // z11-z13 preview: index contours only (every 5th — see the `idx` note below),
      // giving a coarse sense of relief before full 10 m detail arrives. `maxzoom` is
      // exclusive in the style spec, so this hands off to the full layer below at exactly
      // z13 with no overlap between the two.
      map.addLayer(
        {
          id: `${sourceId}-lines-index`,
          type: 'line',
          source: sourceId,
          'source-layer': 'contours',
          filter: ['==', ['get', 'idx'], 1] as unknown as FilterSpecification,
          // The archive's own data starts at z11 (build-contours.sh's CONTOUR_MINZOOM).
          minzoom: Math.max(minzoom, 11),
          maxzoom: 13,
          paint: {
            'line-color': ink.contour,
            'line-width': 1.2,
          },
        },
        beneathLabels(map, region),
      );

      map.addLayer(
        {
          id: `${sourceId}-lines`,
          type: 'line',
          source: sourceId,
          'source-layer': 'contours',
          // Picks up exactly where the index-only layer above stops (its maxzoom: 13).
          minzoom: Math.max(minzoom, 13),
          paint: {
            'line-color': ink.contour,
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
        beneathLabels(map, region),
      );

      addContourLabels(map, sourceId, region, minzoom, ink);
    } else if (artifact.kind === 'paths') {
      map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });

      // The network below z14, where the basemap has none. Same paint as the basemap's
      // own path layers, so crossing z14 changes which source is drawing and nothing
      // else. `maxzoom` is exclusive in the style spec, so this stops exactly where the
      // basemap layers start.
      //
      // A region small enough that its own low-zoom cutoff is already at or above the
      // handoff has no band of zooms for this to occupy — adding a layer whose minzoom
      // exceeds its maxzoom is a style error, so it is simply not added.
      const lowZoomMin = Math.max(12, minzoom);
      if (lowZoomMin < BASEMAP_PATHS_MIN_ZOOM) {
        addPathLayers(map, sourceId, {
          ink,
          sourceLayer: PATHS_SOURCE_LAYER,
          minzoom: lowZoomMin,
          maxzoom: BASEMAP_PATHS_MIN_ZOOM,
        });
      }
    } else if (artifact.kind === 'avalanche') {
      // Slope shading from the region's own DEM derivative (Phase 4.6). Same source type
      // as the hillshade, different decoding: see AVALANCHE_ENCODING for why the channel
      // factors are what they are.
      map.addSource(sourceId, avalancheSourceSpec(url, COPERNICUS_ATTRIBUTION));

      addAvalancheLayer(map, sourceId, {
        minzoom: Math.max(artifact.minzoom ?? minzoom, minzoom),
        // From the manifest, not a constant: the top zoom is latitude-dependent (the
        // build caps it at the DEM's own ~30 m), so hardcoding it here would drift from
        // the pipeline exactly the way the detail-limit constant once did.
        maxzoom: artifact.maxzoom ?? 11,
        // Beneath the labels like the relief and contours — this shades the ground, so
        // painting it over the place names would be the same mistake the hillshade made.
        before: beneathLabels(map, region),
      });
    } else if (artifact.kind === 'sac') {
      map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });

      // The colour band goes *under* the path's white casing, so a graded path reads as
      // the same path with a coloured halo rather than as a second line beside it. The
      // grade labels go above the paths, with the rest of the region's text.
      //
      // The casing may not exist — a region can carry grades with its basemap not yet
      // downloaded, and C16 means artifacts arrive independently — in which case the band
      // simply sits under the labels like the relief does.
      const casing = `${regionSourceId(region.id, 'basemap')}-paths-casing`;
      addSacLayers(map, sourceId, {
        // Same floor as the paths themselves: a grade with no visible path under it is
        // an annotation on nothing.
        minzoom: Math.max(12, minzoom),
        beforeBand: map.getLayer(casing) ? casing : beneathLabels(map, region),
        beforeLabels: beneathLabels(map, region),
      });
    } else if (artifact.kind === 'terrain-features') {
      // Scree, shingle, rock and boulders — OSM ground-surface detail Protomaps does not
      // carry (see src/terrain-features.ts). Same attribution and z-order slot as the
      // rest of the region's ground-surface overlays (contours, avalanche terrain):
      // beneath the region's own labels, so text stays legible over a scree fill.
      map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });
      addTerrainFeatureLayers(map, sourceId, {
        minzoom: Math.max(artifact.minzoom ?? minzoom, minzoom),
        before: beneathLabels(map, region),
      });
    }
  }

  // Every layer above was added visible (avalanche hidden). A region restored or
  // downloaded while one of its overlays is switched off in the Layers tab must come out
  // with it off, not quietly switch it back on.
  applyAllStoredVisibility(map);
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
function addContourLabels(
  map: MLMap,
  sourceId: string,
  region: Region,
  regionMin: number,
  ink: MapInk,
): void {
  map.addLayer(
    {
      id: `${sourceId}-labels`,
      type: 'symbol',
      source: sourceId,
      'source-layer': 'contours',
      filter: ['==', ['get', 'idx'], 1] as unknown as FilterSpecification,
      // Below this the index lines are close enough together that labels collide more
      // than they inform. Kept 2 zoom levels above z13, where full-detail contours (and
      // this layer's own `-lines` sibling) take over — the sparser z11-z13 index-only
      // preview doesn't get labels at all, it's read as a bare relief band.
      minzoom: Math.max(15, regionMin),
      layout: {
        // Bare number, no unit: the convention on hill maps, and on a sheet already
        // covered in contours the unit is never ambiguous. Peak labels keep "m" because
        // there they sit alone against terrain.
        'text-field': ['to-string', ['round', ['get', 'ele']]],
        'text-font': [MAP_FONTS.regular],
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
        'text-color': ink.contourLabel,
        // The halo is what stands in for breaking the line behind the label, which
        // MapLibre cannot do — without it the contour runs straight through the digits.
        'text-halo-color': ink.labelHalo,
        'text-halo-width': 1.6,
      },
    },
    beneathLabels(map, region),
  );
}

/**
 * Remove a region's layers and sources, and unregister its archives — used when the user
 * deletes a download. The inverse of addRegionToMap, registry included: the files behind
 * those archives are about to be deleted (see TileSourceRegistry.removeLocal).
 */
export function removeRegionFromMap(map: MLMap, registry: TileSourceRegistry, region: Region): void {
  for (const layerId of regionLayerIds(map, region)) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const artifact of region.artifacts) {
    const sourceId = regionSourceId(region.id, artifact.kind);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    registry.removeLocal(artifact.filename);
  }
}
