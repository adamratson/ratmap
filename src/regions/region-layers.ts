import type { FilterSpecification, Map as MLMap, RasterTileSource, VectorTileSource } from 'maplibre-gl';
import { MAP_FONTS, mapInk, type MapInk } from '../map/flavor';
import type { Theme } from '../ui/theme';
import { ratmapBasemapLayers, TOWN_LABEL_LAYER_ID } from '../map/landuse';
import { isTileArchive, type Region } from './manifest';
import { getArtifactFile } from './opfs-store';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import {
  COPERNICUS_ATTRIBUTION,
  OSM_ATTRIBUTION,
  PEAKS_PMTILES_URL,
  TERRAIN_ATTRIBUTION,
} from '../app/config';
import { PEAKS_LAYER_ID, PEAKS_SOURCE_ID } from '../overlays/peaks';
import { addSacLayers, sacBandLayerId } from '../overlays/sac';
import { addAvalancheLayer, avalancheSourceSpec } from '../overlays/avalanche';
import { addTerrainFeatureLayers } from '../overlays/terrain-features';
import { addLandmarkLayers } from '../overlays/landmarks';
import { addDetailLayers } from '../overlays/detail';
import { parkingLayer } from '../map/parking';
import { applyAllStoredVisibility } from '../map/layers';

// Renders a downloaded region *over* the low-zoom world catalog rather than replacing it,
// so panning outside the region degrades to the global view instead of falling off the
// edge of the map.
//
// Region archives carry far more zoom than the catalog (basemap z13, terrain z11 vs the
// catalog's z5/z4), which is the entire point — this is what fixes the "blurry at hiking
// zoom" problem the catalog-only decision (§8.2) creates.

const SHARED_SOURCE_PREFIX = 'regions';

/** Layer name inside `<region>-paths.pmtiles`, set by infra/scripts/build-paths.sh. */
const PATHS_SOURCE_LAYER = 'paths';

/**
 * The style source every downloaded region's `kind` artifact is drawn through, for
 * archives with this zoom range.
 *
 * One source per kind rather than per region (TileSourceRegistry.addSharedCopy says why),
 * and per zoom range because a source has only one: basemaps end at z15 in most regions
 * but at z13 or z14 in some, and a z13 region on a z15 source would go blank above z13
 * rather than be overzoomed.
 *
 * The kind comes last: the Layers toggles and the tap lookups find layers by the tail of
 * their id (`…-landmarks-symbols`, `…-sac-band`), which every layer id built on this keeps.
 */
export function sharedSourceId(kind: string, minzoom: number, maxzoom: number): string {
  return `${SHARED_SOURCE_PREFIX}-z${minzoom}-${maxzoom}-${kind}`;
}

/**
 * Where downloaded relief and contours belong in the layer stack: above the downloaded
 * fills, below the downloaded labels.
 *
 * Everything used to be inserted at the peaks layer, which stacks each artifact on top of
 * the last. Artifacts are processed basemap → contours → terrain, so the hillshade landed
 * on top of the basemap's own labels and washed out the gully and corrie names on Ben
 * Nevis's north face.
 *
 * Scoped to the downloaded layers deliberately. Targeting the *first* symbol layer in the
 * whole style would pick a global-basemap label, which sits below the downloaded fills —
 * burying the relief under their opaque earth and landcover instead of showing it.
 */
function beneathLabels(map: MLMap): string | undefined {
  const regionLabel = downloadedLayerIds(map).find((id) => map.getLayer(id)?.type === 'symbol');
  if (regionLabel) return regionLabel;

  // No region labels yet (e.g. contours downloaded without a basemap): fall back to
  // sitting under the peaks, which is still better than on top of them.
  return map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined;
}

/**
 * Where a region's paths belong: over every line the basemap draws — roads, rail,
 * bridges — and under every symbol it draws, car parks and other POIs included.
 *
 * Paths used to go in under the peaks, which put them on top of the whole basemap, so a
 * path crossing a car park struck straight through its P sign and the name beside it.
 *
 * The first symbol *above the basemap's last line* rather than beneathLabels(): artifacts
 * arrive independently (C16), and a region whose contours were added before its basemap
 * has the contour labels as its first symbol — below the basemap's opaque fills, where
 * paths would vanish. Nor simply the basemap's own first symbol: the low-zoom paths
 * artifact is added after the contour and grade labels, and would draw across them.
 */
function beneathBasemapLabels(map: MLMap): string | undefined {
  const ids = downloadedLayerIds(map);
  const type = (id: string) => map.getLayer(id)?.type;
  const lastLine = ids.findLastIndex((id) => layerSource(map, id).endsWith('-basemap') && type(id) !== 'symbol');
  if (lastLine < 0) return beneathLabels(map);
  const label = ids.slice(lastLine + 1).find((id) => type(id) === 'symbol');
  return label ?? (map.getLayer(PEAKS_LAYER_ID) ? PEAKS_LAYER_ID : undefined);
}

/**
 * Where a region's ground shading belongs — relief, contours, slope and scree: under its
 * paths (and the grade band that haloes them), so none of it draws across the network.
 * With the paths now beneath the labels too, beneathLabels() alone would land each of
 * these between the two.
 */
function beneathPaths(map: MLMap): string | undefined {
  // The basemap's paths, the low-zoom paths artifact's, and the SAC grade band.
  const isAnchor = (id: string) => {
    const source = layerSource(map, id);
    return (
      ((source.endsWith('-basemap') || source.endsWith('-paths')) && id === `${source}-paths-casing`) ||
      (source.endsWith('-sac') && id === sacBandLayerId(source))
    );
  };
  return downloadedLayerIds(map).find(isAnchor) ?? beneathLabels(map);
}

/**
 * Where a region's own point symbols belong — landmarks, gates, fords: in with the
 * basemap's POIs, just beneath them. Above every line, so no path strikes through a mast or
 * a gate, and above the contour and grade labels, which give way to a symbol rather than
 * the other way round. Without the basemap yet (C16), under the region's labels like the
 * rest.
 */
function amongBasemapPois(map: MLMap): string | undefined {
  return (
    downloadedLayerIds(map).find((id) => {
      const source = layerSource(map, id);
      return source.endsWith('-basemap') && id === `${source}-pois`;
    }) ?? beneathLabels(map)
  );
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
    before,
  }: {
    sourceLayer: string;
    filter?: FilterSpecification;
    minzoom: number;
    maxzoom?: number;
    ink: MapInk;
    before?: string;
  },
): void {
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
 * The zoom below which a region must not draw.
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
 *
 * Applied where tiles are served, not on the layers: those are shared by every region of
 * a kind, so the floor is each region's copy's own (TileSourceRegistry.addSharedCopy).
 */
function regionMinZoom([west, south, east, north]: Region['bbox']): number {
  const span = Math.max(east - west, north - south);
  return Math.ceil(Math.log2(360 / span));
}

/**
 * Where car parks belong: just above the basemap's POIs rather than among them, so a car
 * park places before a bench or a cafe claims its spot — the slot the basemap's own car
 * park layer had — and still below the place labels, which place first of all. Without
 * the basemap yet (C16), under the downloaded labels like the rest.
 */
function aboveBasemapPois(map: MLMap): string | undefined {
  const pois = downloadedLayerIds(map).find((id) => {
    const source = layerSource(map, id);
    return source.endsWith('-basemap') && id === `${source}-pois`;
  });
  if (!pois) return beneathLabels(map);
  const order = map.getLayersOrder();
  return order[order.indexOf(pois) + 1];
}

function layerSource(map: MLMap, id: string): string {
  const source = (map.getLayer(id) as { source?: unknown } | undefined)?.source;
  return typeof source === 'string' ? source : '';
}

/**
 * Every layer drawn from downloaded regions, in style order, found by the sources they
 * draw from. All regions' at once: they share their sources and layers (sharedSourceId),
 * so where one kind sits relative to another holds across every region on the map.
 *
 * `getLayersOrder()` + `getLayer()` rather than `getStyle()`, which serialises the entire
 * style, and this runs once for every layer a kind adds.
 */
function downloadedLayerIds(map: MLMap): string[] {
  return map.getLayersOrder().filter((id) => layerSource(map, id).startsWith(`${SHARED_SOURCE_PREFIX}-`));
}

/** Read a shared source's header and tiles again, after a region joined or left it. */
function reloadSource(map: MLMap, sourceId: string, url: string): void {
  (map.getSource(sourceId) as VectorTileSource | RasterTileSource | undefined)?.setUrl(url);
}

/**
 * Register a downloaded region's archives with the TileSourceRegistry, and add the layers
 * for any kind no region on the map has drawn yet. Idempotent — safe to call again after
 * a style reload or a repeat download.
 *
 * Each archive joins the source its kind already has (sharedSourceId), so a second region
 * of a kind adds no layers: its source is reloaded and draws both. That is what keeps one
 * region from hiding another where they overlap — see TileSourceRegistry.addSharedCopy.
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
  const ink = mapInk(theme);

  for (const artifact of region.artifacts) {
    // A search index is read by search, not drawn (src/search/search.ts).
    if (!isTileArchive(artifact)) continue;
    const file = await getArtifactFile(artifact.filename);
    if (!file) continue;

    // C3 in practice: FileSource.getKey() returns file.name, so the registry key is the
    // artifact filename — which the build pipeline guarantees is globally unique.
    const archive = registry.addLocal(file);

    if (artifact.kind === 'peaks') {
      // No layers of its own: the region's summits are served in place of the global
      // archive's tiles inside it, so the existing summit layers draw them — offline
      // included. See TileSourceRegistry.addRegionalCopy.
      if (registry.addRegionalCopy(PEAKS_PMTILES_URL, artifact.filename, region.bbox)) {
        // An offline start asked for the summits before any region was restored, got
        // nothing, and MapLibre does not ask twice. Ask again now there is an answer.
        (map.getSource(PEAKS_SOURCE_ID) as VectorTileSource | undefined)?.setUrl(
          registry.sourceUrl(PEAKS_PMTILES_URL),
        );
      }
      continue;
    }

    // The source's zoom range is the archive's own, from its header — what each region
    // source took before they were shared, and wider than the tiles in a sparse cutout
    // (build-region.sh's verify_wide_header says why that is left so).
    const header = await archive.getHeader();
    const sourceId = sharedSourceId(artifact.kind, header.minZoom, header.maxZoom);
    const changed = registry.addSharedCopy(
      sourceId,
      artifact.filename,
      region.bbox,
      regionMinZoom(region.bbox),
    );
    const url = registry.sourceUrl(sourceId);

    if (map.getSource(sourceId)) {
      if (changed) reloadSource(map, sourceId, url);
      continue;
    }

    addKindLayers(map, artifact.kind, sourceId, url, {
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
      ink,
      theme,
    });
  }

  // Every layer above was added visible (avalanche hidden). A region restored or
  // downloaded while one of its overlays is switched off in the Layers tab must come out
  // with it off, not quietly switch it back on.
  applyAllStoredVisibility(map);
}

/**
 * Add the source and layers for one kind of downloaded artifact, drawn from every region
 * that carries it.
 *
 * `minzoom` and `maxzoom` are the source's zoom range. No region's own floor applies here:
 * a region answers no tile below it (regionMinZoom), so the layers can start where the
 * data does.
 */
function addKindLayers(
  map: MLMap,
  kind: string,
  sourceId: string,
  url: string,
  { minzoom, maxzoom, ink, theme }: { minzoom: number; maxzoom: number; ink: MapInk; theme: Theme },
): void {
  if (kind === 'terrain') {
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
          // Both stops dialled down 40% (0.5→0.3, 0.15→0.09) — the relief was
          // competing with the contour lines even before the smearing kicks in.
          //
          // Styling call, not a settled decision — §8.3 is still open.
          'hillshade-exaggeration': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            0.3,
            14,
            0.09,
          ],
          'hillshade-highlight-color': ink.hillshadeHighlight,
          'hillshade-shadow-color': ink.hillshadeShadow,
        },
      },
      // Under every label, not just under the peaks — see beneathLabels() — and under
      // the paths, see beneathPaths().
      beneathPaths(map),
    );
  } else if (kind === 'basemap') {
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });

    // Reuse the same Protomaps style generator as the global basemap so the region
    // looks identical, just sharper — rather than maintaining a second stylesheet.
    //
    // Source-bound layers only. `layers()` also emits a `background` layer, which is
    // viewport-filling rather than tile-bound: adding a region's copy of it painted flat
    // #cccccc over the entire global map, leaving only the area with region tiles
    // visible. A style needs exactly one background, and the global basemap already
    // supplies it.
    const generated = ratmapBasemapLayers(sourceId, theme, { lang: 'en' });
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
    // The fills and lines go under everything already drawn from the downloads. The
    // basemap is not necessarily first: the manifest lists artifacts alphabetically, so
    // `avalanche` is added before it, and C16 means a region restored half-downloaded can
    // have its relief on the map before the basemap arrives at all. Stacked at the peaks
    // like the labels, the opaque earth, landcover and water painted straight over those
    // overlays — which is how avalanche terrain came to show nowhere, Scotland included.
    // A second basemap source (another zoom range) goes under the first's ground too, and
    // so under every overlay, rather than over them.
    const beneathRegion = downloadedLayerIds(map)[0] ?? beforePeaks;
    for (const layer of generated) {
      if (!('source' in layer) || !layer.source) continue;
      const scoped = {
        ...layer,
        id: `${sourceId}-${layer.id}`,
        ...(layer.minzoom === undefined ? {} : { minzoom: layer.minzoom }),
      };
      const beforeId =
        layer.id === TOWN_LABEL_LAYER_ID
          ? beforeTownLabels
          : layer.type === 'symbol'
            ? beforePeaks
            : beneathRegion;
      map.addLayer(scoped, beforeId);
    }

    addPathLayers(map, sourceId, {
      ink,
      sourceLayer: 'roads',
      filter: ['==', ['get', 'kind'], 'path'] as unknown as FilterSpecification,
      // Starts where the low-zoom paths artifact stops, so the two never draw the same
      // way twice — a duplicated translucent casing reads brighter, not invisible. Every
      // region in the catalogue carries that artifact. One downloaded before it existed
      // goes without paths at z12-13 until updated: with the layers shared, there is no
      // per-region "has paths" left to start this at z12 for.
      minzoom: BASEMAP_PATHS_MIN_ZOOM,
      before: beneathBasemapLabels(map),
    });
  } else if (kind === 'contours') {
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
          // Ramped up to the full index stroke at z13, where the all-contours layer takes
          // over. At z11–12 these lines sit a millimetre apart on steep ground, and at
          // full ink they turn into a texture that buries the trails.
          'line-color': ink.contourIndex,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 12, 0.5, 13, 1],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 13, 1.4],
        },
      },
      beneathPaths(map),
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
          // Index contours (every 5th) are drawn darker and heavier, as on a paper map —
          // their own ink, not only a wider stroke (see MapInk.contourIndex).
          'line-color': ['case', ['==', ['get', 'idx'], 1], ink.contourIndex, ink.contour],
          //
          // `idx`, not `index`, and compared to 1, not true: build-contours.sh tags them
          // via SQLite, which yields an integer 0/1 under the alias `idx`. The original
          // expression matched neither the name nor the type, so every contour silently
          // drew at the thin weight and the emphasis never appeared.
          'line-width': ['case', ['==', ['get', 'idx'], 1], 1.4, 0.7],
        },
      },
      // Contour lines drawn over place names would be just as unreadable as relief
      // over them, so these go under the labels too — and under the paths.
      beneathPaths(map),
    );

    addContourLabels(map, sourceId, ink);
  } else if (kind === 'paths') {
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });

    // The network below z14, where the basemap has none. Same paint as the basemap's
    // own path layers, so crossing z14 changes which source is drawing and nothing
    // else. `maxzoom` is exclusive in the style spec, so this stops exactly where the
    // basemap layers start.
    addPathLayers(map, sourceId, {
      ink,
      sourceLayer: PATHS_SOURCE_LAYER,
      minzoom: Math.max(12, minzoom),
      maxzoom: BASEMAP_PATHS_MIN_ZOOM,
      before: beneathBasemapLabels(map),
    });
  } else if (kind === 'avalanche') {
    // Slope shading from the region's own DEM derivative (Phase 4.6). Same source type
    // as the hillshade, different decoding: see AVALANCHE_ENCODING for why the channel
    // factors are what they are.
    map.addSource(sourceId, avalancheSourceSpec(url, COPERNICUS_ATTRIBUTION));

    addAvalancheLayer(map, sourceId, {
      minzoom,
      // From the archive, not a constant: the top zoom is latitude-dependent (the build
      // caps it at the DEM's own ~30 m), so hardcoding it here would drift from the
      // pipeline exactly the way the detail-limit constant once did.
      maxzoom,
      // Beneath the labels like the relief and contours — this shades the ground, so
      // painting it over the place names would be the same mistake the hillshade made.
      before: beneathPaths(map),
    });
  } else if (kind === 'sac') {
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });

    // The colour band goes *under* the path's white casing, so a graded path reads as
    // the same path with a coloured halo rather than as a second line beside it. The
    // grade labels go above the paths, with the rest of the region's text.
    //
    // The casing may not exist — a region can carry grades with its basemap not yet
    // downloaded, and C16 means artifacts arrive independently — in which case the band
    // simply sits under the labels like the relief does.
    const casing = downloadedLayerIds(map).find((id) => {
      const source = layerSource(map, id);
      return source.endsWith('-basemap') && id === `${source}-paths-casing`;
    });
    addSacLayers(map, sourceId, {
      // Same floor as the paths themselves: a grade with no visible path under it is
      // an annotation on nothing.
      minzoom: Math.max(12, minzoom),
      beforeBand: casing ?? beneathLabels(map),
      beforeLabels: beneathLabels(map),
    });
  } else if (kind === 'terrain-features') {
    // Scree, shingle, rock and boulders — OSM ground-surface detail Protomaps does not
    // carry (see src/overlays/terrain-features.ts). Same attribution and z-order slot as the
    // rest of the ground-surface overlays (contours, avalanche terrain): beneath the
    // downloaded paths and labels, so neither is lost under the scree stipple.
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });
    addTerrainFeatureLayers(map, sourceId, {
      ink,
      minzoom,
      before: beneathPaths(map),
    });
  } else if (kind === 'landmarks') {
    // Masts, towers, trig points, cairns, lighthouses and wind turbines — POIs Protomaps
    // does not keep (see src/overlays/landmarks.ts).
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });
    addLandmarkLayers(map, sourceId, {
      ink,
      minzoom,
      before: amongBasemapPois(map),
    });
  } else if (kind === 'parking') {
    // Car parks (see src/map/parking.ts), the basemap's own no longer drawn.
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });
    map.addLayer(parkingLayer(sourceId, theme, minzoom), aboveBasemapPois(map));
  } else if (kind === 'detail') {
    // Walls, fences, power lines, gates, stiles and fords (see src/overlays/detail.ts).
    // The lines are ground detail like the scree, so under the paths; the gates and fords
    // sit on the paths, so with the landmarks, over them.
    map.addSource(sourceId, { type: 'vector', url, attribution: OSM_ATTRIBUTION });
    addDetailLayers(map, sourceId, {
      ink,
      minzoom,
      beforeLines: beneathPaths(map),
      beforeSymbols: amongBasemapPois(map),
    });
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
function addContourLabels(map: MLMap, sourceId: string, ink: MapInk): void {
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
      minzoom: 15,
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
    beneathLabels(map),
  );
}

/**
 * Take a region off the map and unregister its archives — used when the user deletes a
 * download. The inverse of addRegionToMap, registry included: the files behind those
 * archives are about to be deleted (see TileSourceRegistry.removeLocal).
 *
 * A source the region shared with others stays, reloaded so the deleted region's tiles
 * leave the screen; one it was the last region in goes, with its layers.
 */
export function removeRegionFromMap(map: MLMap, registry: TileSourceRegistry, region: Region): void {
  const left = new Set<string>();
  for (const artifact of region.artifacts) {
    for (const key of registry.removeLocal(artifact.filename)) left.add(key);
  }
  for (const sourceId of left) {
    // The summits' archive comes back here too, under its URL: its source keeps drawing
    // from the network and from the other regions, as it always has.
    if (!map.getSource(sourceId)) continue;
    if (registry.sharedCopyCount(sourceId) > 0) {
      reloadSource(map, sourceId, registry.sourceUrl(sourceId));
      continue;
    }
    for (const id of map.getLayersOrder()) {
      if (layerSource(map, id) === sourceId) map.removeLayer(id);
    }
    map.removeSource(sourceId);
  }
}
