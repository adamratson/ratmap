import type { Map as MLMap } from 'maplibre-gl';

// Ground surface detail Protomaps does not carry: scree, shingle, rock outcrops and
// boulders. Checked directly against Protomaps' own `Landuse.java` (2026-09-18) — its OSM
// ingestion path maps `natural=bare_rock` into the `landuse` layer but drops
// `scree`/`shingle`/`rock`/`stone` outright; they're only reachable there via Overture
// data, which is not in this project's region extracts. So this rides on its own artifact,
// `<region>-terrain-features.pmtiles`, built by infra/scripts/build-terrain-features.sh
// from OSM and cut per region the same way sac and paths are (C16). `bare_rock` is
// deliberately excluded here — see src/map/landuse.ts, which paints it from data the basemap
// already carries, no new artifact needed.
//
// **Coverage is partial and non-uniform, the same shape as SAC's.** Most of the world's
// `natural=` surface tagging is incomplete, and density varies by well over an order of
// magnitude between ranges — measured (2026-09-18) at ~0.085 features/km² over a Ben Nevis
// reference box against 4,886 `scree` ways alone in a similarly-sized Swiss Alps box.
// A summit with nothing drawn here is not "there is no scree there".

export const TERRAIN_FEATURES_SOURCE_LAYER = 'terrain_features';

export type TerrainFeatureKind = 'scree' | 'shingle' | 'rock' | 'stone';

export interface TerrainFeatureKindInfo {
  kind: TerrainFeatureKind;
  label: string;
  note: string;
  /** Fill colour for the area cases (most scree/shingle/rock, and some stone fields). */
  fillColor: string;
  /** Marker colour for the point cases (rock outcrops and individual boulders). */
  pointColor: string;
}

/**
 * Grey-brown, distinct from `bare_rock`'s pale `landcover.barren` tint (src/map/landuse.ts) —
 * that tint is tuned to read at z2 as a continent-scale landcover band; this is a
 * hiking-zoom feature and wants to read as *loose ground*, not as a lighter version of
 * solid rock. `rock` and `stone` share a colour: OSM has no field-vs-individual sub-tag
 * (a boulder field and an isolated boulder are both `natural=stone` with no way to tell
 * them apart from the tag alone), so the map doesn't invent a distinction the data
 * doesn't carry — a cluster of markers reads as a field by density on screen instead.
 */
export const TERRAIN_FEATURE_KINDS: readonly TerrainFeatureKindInfo[] = [
  {
    kind: 'scree',
    label: 'Scree',
    note: 'Loose rock fragments — underfoot changes the walk. Coverage is partial.',
    fillColor: '#a99a86',
    pointColor: '#8a7860',
  },
  {
    kind: 'shingle',
    label: 'Shingle',
    note: 'Loose rounded stones. Coverage is partial.',
    fillColor: '#b6ad9c',
    pointColor: '#8a7860',
  },
  {
    kind: 'rock',
    label: 'Rock / outcrop',
    note: 'Bare rock outcrop, mapped as an area or a single point. Coverage is partial.',
    fillColor: '#8f8172',
    pointColor: '#6b5d4f',
  },
  {
    kind: 'stone',
    label: 'Boulder',
    note: 'A large boulder or boulder field — OSM cannot tell the two apart. Coverage is partial.',
    fillColor: '#8f8172',
    pointColor: '#6b5d4f',
  },
];

function fillColorExpression(): unknown {
  return [
    'match',
    ['get', 'kind'],
    ...TERRAIN_FEATURE_KINDS.flatMap((entry) => [entry.kind, entry.fillColor]),
    '#8b8b8b',
  ];
}

function pointColorExpression(): unknown {
  return [
    'match',
    ['get', 'kind'],
    ...TERRAIN_FEATURE_KINDS.flatMap((entry) => [entry.kind, entry.pointColor]),
    '#6b5d4f',
  ];
}

export function terrainFeaturesFillLayerId(sourceId: string): string {
  return `${sourceId}-fill`;
}

/**
 * Draw the artifact: a fill for the area features (most scree/shingle/rock/stone) and a
 * small marker for the point ones (rock outcrops, individual boulders).
 *
 * Two layers, no geometry filter needed to split them — a `fill` layer simply does not
 * render Point geometry and a `circle` layer does not render Polygon geometry, so `kind`
 * alone drives the colour and MapLibre's own layer-type/geometry matching does the rest.
 * Verified against a real build (`scotland-latest.osm.pbf` + `montenegro-latest.osm.pbf`,
 * 2026-09-18): `rock` and `stone` are the two kinds that carry both shapes (669 area +
 * 856 point for `rock`; 73 area + 762 point for `stone`), `scree`/`shingle` came back
 * 100% area.
 */
export function addTerrainFeatureLayers(
  map: MLMap,
  sourceId: string,
  { minzoom, before }: { minzoom: number; before?: string },
): void {
  map.addLayer(
    {
      id: terrainFeaturesFillLayerId(sourceId),
      type: 'fill',
      source: sourceId,
      'source-layer': TERRAIN_FEATURES_SOURCE_LAYER,
      minzoom,
      paint: {
        'fill-color': fillColorExpression() as never,
        // Same fade-in shape as landuse_park (src/map/landuse.ts) — the layer sits in the
        // same visual family as the basemap's own landuse fills, not a separate overlay.
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], minzoom, 0, minzoom + 2, 0.55],
      },
    },
    before,
  );

  map.addLayer(
    {
      id: `${sourceId}-points`,
      type: 'circle',
      source: sourceId,
      'source-layer': TERRAIN_FEATURES_SOURCE_LAYER,
      // A point marker at the same zoom as a scattering of fills would be visual noise;
      // these are a small minority against the area count — measured (2026-09-18, real
      // build against scotland-latest.osm.pbf + montenegro-latest.osm.pbf) 1,618 points
      // against 10,153 areas — and read better once the map is close enough to place them
      // precisely.
      minzoom: Math.max(13, minzoom),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 17, 5],
        'circle-color': pointColorExpression() as never,
        'circle-stroke-color': 'rgba(255,255,255,0.9)',
        'circle-stroke-width': 1.25,
      },
    },
    before,
  );
}
