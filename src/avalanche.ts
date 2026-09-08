import type { Map as MLMap, SourceSpecification } from 'maplibre-gl';

// Avalanche **terrain** — Phase 4.6, plans/avalanche-terrain.md.
//
// Avalanche danger is snowpack x weather x terrain. Offline, with no bulletin and no
// observations, this app has one of the three, permanently. So this layer answers "could
// this slope slide, on the shape of the ground alone" and never "will it today". That is
// not a caveat bolted on at the end: it fixes the name, the palette (§5 — it must not read
// as a bulletin's danger scale) and every string in the UI. Someone reading a terrain
// layer as a forecast can die of it.
//
// The data is a per-region raster built by infra/scripts/build-avalanche.sh from Copernicus
// GLO-30 — no third-party live feed anywhere, and nothing computed in the browser (C14).

/** Layer id suffix, used to find these layers for toggling and removal. */
const SHADE_SUFFIX = '-shade';

/**
 * How the artifact's channels decode.
 *
 * R = slope in whole degrees, G = aspect octant (0-8), B = runout (0 until Stage B).
 *
 * The factors are chosen so the DEM "elevation" MapLibre ramps over *is* the slope angle,
 * with no arithmetic in the style. Two properties of `packDEMData()` force the shape:
 *
 *   - **No factor may be zero.** MapLibre packs the colour ramp's own elevation stops back
 *     into RGB using `minScale = min(red, green, blue)` and divides by it, so a single zero
 *     makes every stop NaN and the shader's binary search collapses — silently, rendering
 *     nothing. The obvious layout (slope alone in G, the others zeroed) is unusable.
 *   - So the other channels ride *underneath* slope rather than beside it. G contributes at
 *     most 8/256 = 0.031 deg and B at most 90/65536 = 0.0014 deg — far inside the 1-degree
 *     quantisation and the 5-degree classes, so what the ramp sees is the slope.
 *
 * Verified on iOS Safari 26.4, WebKit and Chromium: `spike/color-relief.html`, 15/15 exact.
 */
export const AVALANCHE_ENCODING = {
  encoding: 'custom',
  redFactor: 1,
  greenFactor: 1 / 256,
  blueFactor: 1 / 65536,
  baseShift: 0,
} as const;

/** Bytes below this in the R channel mean "below the drawn threshold", never "flat" (A7). */
export const SLOPE_FLOOR_DEG = 25;

export interface SlopeClass {
  /** Inclusive lower bound in degrees. */
  from: number;
  /** Exclusive upper bound; `null` for the open-ended top class. */
  to: number | null;
  label: string;
  note: string;
  color: string;
}

/**
 * The slope classes, and the colours the map draws them in.
 *
 * **Deliberately not a green-amber-red ramp.** That is the visual grammar of every
 * avalanche bulletin in the world, and borrowing it would assert exactly the thing this
 * layer cannot know. This is a pale-to-saturated sequence through yellow and orange, read
 * as "how much of the ground is in the release window", not as a danger level.
 *
 * The ramp is also **not monotonic at the top**. Ground at 45 degrees and above is not
 * "worse" than 35-40: it sluffs continuously and rarely builds the slabs that kill people,
 * so it is a different failure mode rather than more of the same one. Making it hotter
 * would teach the wrong thing, so it steps to a cool blue instead — visibly a different
 * category, not the end of a heat ramp.
 *
 * 35-40 gets the strongest treatment because that is where the distribution of slab
 * releases actually peaks.
 *
 * Styling call, not a settled decision — §8.3 is still open, and so is this plan's §5.
 */
export const SLOPE_CLASSES: readonly SlopeClass[] = [
  {
    from: 25,
    to: 30,
    label: '25–29°',
    note: 'Release is uncommon, but runout and terrain traps live on ground like this.',
    color: '#ffeb82',
  },
  {
    from: 30,
    to: 35,
    label: '30–34°',
    note: 'Slab release becomes common from here.',
    color: '#fab03c',
  },
  {
    from: 35,
    to: 40,
    label: '35–39°',
    note: 'Where most slab avalanches release. The steepest band that reliably holds a slab.',
    color: '#e25028',
  },
  {
    from: 40,
    to: 45,
    label: '40–44°',
    note: 'Frequent, generally smaller, more often loose-snow than slab.',
    color: '#962878',
  },
  {
    from: 45,
    to: null,
    label: '45°+',
    note: 'Sluffs continuously and rarely builds slabs — a different problem, not a worse one.',
    color: '#3c5ac8',
  },
];

/** CSS variable for a class, for sheet text and legend swatches — see sacCssColor. */
export function slopeCssColor(index: number): string {
  return SLOPE_CLASSES[index] ? `var(--avalanche-c${SLOPE_CLASSES[index].from})` : 'currentColor';
}

/** The class a slope angle falls in, or null below the floor. */
export function slopeClassFor(degrees: number): SlopeClass | null {
  if (!Number.isFinite(degrees) || degrees < SLOPE_FLOOR_DEG) return null;
  return (
    SLOPE_CLASSES.find((c) => degrees >= c.from && (c.to === null || degrees < c.to)) ?? null
  );
}

/** Compass names for the aspect octants the G channel stores (1-8; 0 means none). */
export const ASPECT_OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function aspectName(octant: number): string | null {
  return ASPECT_OCTANTS[octant - 1] ?? null;
}

/**
 * The `color-relief-color` ramp: hard bands out of an `interpolate` expression.
 *
 * It must be `interpolate`. MapLibre's `_createColorRamp()` only reads stops from an
 * `Interpolate` expression; a `step` expression yields an empty ramp and a fully
 * transparent layer, with no error anywhere. Hard edges therefore come from *duplicating*
 * each stop at both ends of its band, and the tiny gap between one band's top and the
 * next band's bottom is where the interpolation happens — invisible, because stored values
 * are integers and can never land inside it.
 */
export function avalancheColorRamp(): unknown {
  const stops: unknown[] = [
    // Everything below the floor is transparent, so the map shows through unchanged.
    0,
    'rgba(0,0,0,0)',
    SLOPE_FLOOR_DEG - 0.01,
    'rgba(0,0,0,0)',
  ];
  for (const entry of SLOPE_CLASSES) {
    stops.push(entry.from, entry.color);
    stops.push(entry.to === null ? 90 : entry.to - 0.01, entry.color);
  }
  return ['interpolate', ['linear'], ['elevation'], ...stops];
}

export function avalancheSourceSpec(url: string, attribution: string): SourceSpecification {
  return {
    type: 'raster-dem',
    url,
    ...AVALANCHE_ENCODING,
    attribution,
  } as unknown as SourceSpecification;
}

export function avalancheLayerId(sourceId: string): string {
  return `${sourceId}${SHADE_SUFFIX}`;
}

/** Every avalanche layer currently in the style. */
export function avalancheLayerIds(map: MLMap): string[] {
  return map
    .getStyle()
    .layers.map((layer) => layer.id)
    .filter((id) => id.endsWith(`-avalanche${SHADE_SUFFIX}`));
}

export function addAvalancheLayer(
  map: MLMap,
  sourceId: string,
  { minzoom, maxzoom, before, visible }: {
    minzoom: number;
    /** The archive's own top zoom, from the manifest — where `nearest` takes over. */
    maxzoom: number;
    before?: string;
    visible: boolean;
  },
): void {
  map.addLayer(
    {
      id: avalancheLayerId(sourceId),
      type: 'color-relief',
      source: sourceId,
      minzoom,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'color-relief-color': avalancheColorRamp() as never,
        // Translucent: this annotates the ground, it does not replace it. Contours and
        // the path network have to stay readable underneath, because the decision the
        // layer supports is "does my route cross this", not "look at the pretty slope".
        'color-relief-opacity': 0.5,
        // Above the archive's own zoom the data is being stretched, and a smooth gradient
        // across a class boundary is a value that exists in neither cell. Showing the
        // real 30 m grid is the honest rendering — blocky says "this is as much as is
        // known", where smooth would quietly imply detail that was never measured (A5).
        resampling: ['step', ['zoom'], 'linear', maxzoom + 1, 'nearest'],
      } as never,
    },
    before,
  );
}

/** Show or hide every avalanche layer at once — the Settings toggle. */
export function setAvalancheVisible(map: MLMap, visible: boolean): void {
  for (const id of avalancheLayerIds(map)) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

const STORAGE_KEY = 'ratmap:avalanche-layer';

/**
 * Off by default, and remembered.
 *
 * A walking map that arrives pre-shaded in five colours is not what most people want in
 * June, and a safety layer that is always on is a layer people stop seeing.
 */
export function isAvalancheEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAvalancheEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Private mode: the toggle still works for this session, it just won't be remembered.
  }
}
