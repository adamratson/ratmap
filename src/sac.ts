import type { Map as MLMap, MapGeoJSONFeature, PointLike } from 'maplibre-gl';
import { isCoarsePointer } from './pointer';

// The SAC hiking scale (T1–T6) on the paths that carry it.
//
// Protomaps' `roads` layer does not have it — decoded from our own
// `scotland-basemap.pmtiles` at z15 over the Ben Nevis Mountain Path (2026-09-06), a path
// feature carries exactly `kind, kind_detail, min_zoom, name, sort_rank`. So this rides on
// its own artifact, `<region>-sac.pmtiles`, built by infra/scripts/build-sac.sh from OSM
// and cut per region the same way the basemap and terrain are (C16: a region is a set of
// named artifacts, so this is additive).
//
// **Coverage is partial and always will be.** ~921 k ways worldwide carry `sac_scale`
// (taginfo, 2026-09-06); in a Lochaber/Cairngorms box it is 397 of 5 948 walkable ways,
// about 7%. In the Alps it is far denser. Every piece of UI here therefore has to
// distinguish "graded T1" from "not graded", because reading an ungraded path as an easy
// one is the silent-wrong-answer failure this project keeps designing against — and the
// direction of that error is downhill, on a mountain, in the dark.

export const SAC_SOURCE_LAYER = 'sac';

/** Layer id suffix shared by every region's coloured band — used to find them for a tap. */
const BAND_SUFFIX = '-band';

export type SacGrade = 1 | 2 | 3 | 4 | 5 | 6;

/** The properties build-sac.sh keeps. `t` is the grade, already normalized to 1–6. */
export interface SacProperties {
  t?: number;
  name?: string;
}

export interface SacGradeInfo {
  grade: SacGrade;
  /** "T3" — the form used on signs and in guidebooks. */
  short: string;
  /** The SAC's own name for the grade. */
  label: string;
  /** What it demands of the walker, in one line. */
  note: string;
  color: string;
}

/**
 * The scale, with the colours the map draws it in.
 *
 * Blue → green → amber → orange → red → purple: an ordered hue ramp, the convention
 * difficulty scales are read in (piste maps, climbing grades), rather than a single-hue
 * sequential ramp that would be unreadable at three of its six steps over hillshade.
 *
 * Colour alone is not the answer, though — a deuteranope reads T2 green and T3 amber as
 * close cousins, and that pair is the boundary between "a walk" and "hands out of
 * pockets". So the grade is also written along the line as text at close zoom, appears in
 * the tap sheet, and appears in the route summary. The colour is the quick scan; the
 * label is the fact.
 */
export const SAC_GRADES: readonly SacGradeInfo[] = [
  {
    grade: 1,
    short: 'T1',
    label: 'Hiking',
    note: 'Well-made path, gentle ground, no exposure. Trainers will do.',
    color: '#2c7fb8',
  },
  {
    grade: 2,
    short: 'T2',
    label: 'Mountain hiking',
    note: 'Continuous path, steeper ground in places. Sure-footedness needed.',
    color: '#3f9e4d',
  },
  {
    grade: 3,
    short: 'T3',
    label: 'Demanding mountain hiking',
    note: 'Exposed sections, short scrambles, sometimes cabled. Head for heights.',
    color: '#d9a125',
  },
  {
    grade: 4,
    short: 'T4',
    label: 'Alpine hiking',
    note: 'Path comes and goes; hands needed; sustained exposure. Alpine experience.',
    color: '#e8590c',
  },
  {
    grade: 5,
    short: 'T5',
    label: 'Demanding alpine hiking',
    note: 'Often trackless, scrambling, possible glacier or snow. Mountaineering skills.',
    color: '#c92a2a',
  },
  {
    grade: 6,
    short: 'T6',
    label: 'Difficult alpine hiking',
    note: 'Mostly trackless, climbing to grade II, very exposed, rarely marked.',
    color: '#7b2d8b',
  },
];

/** The grade a feature carries, or null when the value is not one of T1–T6. */
export function sacGradeInfo(value: unknown): SacGradeInfo | null {
  return SAC_GRADES.find((entry) => entry.grade === value) ?? null;
}

/**
 * The colour to draw a grade in **UI text and swatches**, as a CSS variable.
 *
 * Not the same value as `color`: style.css lightens the ramp under `[data-theme='dark']`
 * so a T6 label stays legible on the dark sheet, where the map's own hex is about 2.4:1
 * against it. The map keeps the literal hex, because a MapLibre paint property cannot
 * read a CSS variable — which is also why the two lists have to be kept in step.
 */
export function sacCssColor(grade: number): string {
  return sacGradeInfo(grade) ? `var(--sac-t${grade})` : 'currentColor';
}

/** `['match', ['get','t'], 1, colour, …, fallback]` — the ramp as a style expression. */
function colorExpression(): unknown {
  return [
    'match',
    ['get', 't'],
    ...SAC_GRADES.flatMap((entry) => [entry.grade, entry.color]),
    // A grade outside 1–6 cannot reach the tiles (build-sac.sh drops it), so this only
    // fires if the artifact and this build ever disagree. Grey says "unknown", which is
    // the truth, rather than borrowing a grade's colour and asserting something false.
    '#8b8b8b',
  ];
}

export function sacBandLayerId(sourceId: string): string {
  return `${sourceId}${BAND_SUFFIX}`;
}

/**
 * Draw the graded paths as a wide, soft colour band *under* the path line itself.
 *
 * A band rather than recolouring the path: this geometry is our own OSM cut, tiled by
 * tippecanoe, while the line drawn on top of it is Protomaps' generalisation of the same
 * ways. They agree closely at z15 and less well below it, and a 6 px translucent band
 * absorbs that disagreement where a 2 px replacement line would show as a doubled path.
 * It also keeps one path style on the map: the grade is an annotation on the path, not a
 * different kind of path.
 */
export function addSacLayers(
  map: MLMap,
  sourceId: string,
  {
    minzoom,
    beforeBand,
    beforeLabels,
  }: { minzoom: number; beforeBand?: string; beforeLabels?: string },
): void {
  map.addLayer(
    {
      id: sacBandLayerId(sourceId),
      type: 'line',
      source: sourceId,
      'source-layer': SAC_SOURCE_LAYER,
      minzoom,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colorExpression() as never,
        // Wider than the path drawn over it, so the grade reads as a halo around the
        // path rather than as a second path beside it.
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 4, 16, 12],
        // Translucent so contours and hillshade still read through it — the band marks a
        // path, it does not replace the ground under it.
        'line-opacity': 0.6,
      },
    },
    beforeBand,
  );

  map.addLayer(
    {
      id: `${sourceId}-labels`,
      type: 'symbol',
      source: sourceId,
      'source-layer': SAC_SOURCE_LAYER,
      // z14, not z12: at z12 a graded path is a few millimetres long on screen and the
      // labels are all that would be visible of it. Below this the colour carries it.
      minzoom: Math.max(14, minzoom),
      layout: {
        'text-field': ['concat', 'T', ['to-string', ['get', 't']]],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'symbol-placement': 'line',
        'symbol-spacing': 300,
        'text-max-angle': 60,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': colorExpression() as never,
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.6,
      },
    },
    beforeLabels,
  );
}

export interface SacHit {
  properties: SacProperties;
  grade: SacGradeInfo | null;
}

/** Tap targets are finger-sized on touch, exact on a mouse — same rule as the summits. */
function tapPadding(): number {
  return isCoarsePointer() ? 12 : 0;
}

/**
 * The graded path at a screen point, or null.
 *
 * Queries every region's band layer, so it keeps working with two overlapping regions
 * downloaded. Only layers that currently exist are queried: `queryRenderedFeatures`
 * throws on an unknown layer id rather than returning nothing, and these layers come and
 * go with region downloads.
 */
export function sacPathAt(map: MLMap, point: PointLike, paddingPx = tapPadding()): SacHit | null {
  const layers = map
    .getStyle()
    .layers.map((layer) => layer.id)
    .filter((id) => id.endsWith(`-${SAC_SOURCE_LAYER}${BAND_SUFFIX}`) && Boolean(map.getLayer(id)));
  if (layers.length === 0) return null;

  const query: PointLike | [PointLike, PointLike] =
    paddingPx <= 0
      ? point
      : (() => {
          const { x, y } = screenXY(point);
          return [
            [x - paddingPx, y - paddingPx],
            [x + paddingPx, y + paddingPx],
          ] as [PointLike, PointLike];
        })();

  const hits = map.queryRenderedFeatures(query as never, { layers });
  if (hits.length === 0) return null;

  // Hardest first. Where two graded paths overlap inside one tap box, reporting the easier
  // of them is the dangerous direction to round.
  const hardest = hits.reduce((best: MapGeoJSONFeature, candidate: MapGeoJSONFeature) =>
    gradeOf(candidate) > gradeOf(best) ? candidate : best,
  );
  const properties = hardest.properties as SacProperties;
  return { properties, grade: sacGradeInfo(properties.t) };
}

function gradeOf(feature: MapGeoJSONFeature): number {
  const value = (feature.properties as SacProperties).t;
  return typeof value === 'number' ? value : 0;
}

function screenXY(point: PointLike): { x: number; y: number } {
  if (Array.isArray(point)) return { x: point[0], y: point[1] };
  return { x: (point as { x: number }).x, y: (point as { y: number }).y };
}
