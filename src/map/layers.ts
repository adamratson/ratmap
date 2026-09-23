import type { Map as MLMap } from 'maplibre-gl';
import { PEAKS_LAYER_ID } from '../overlays/peaks';
import { FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID } from '../regions/region-footprints';

// Which of the app's overlays are drawn — the Layers tab's state, and the one place that
// knows which style layers each toggle means.
//
// Only overlays. The basemap's own roads, landuse and place labels are never switchable:
// without them the map is close to blank, and hiding town labels would undo the reason
// peaks sit beneath them in the first place (see peaks.ts).
//
// Layers are added by their own modules exactly as before, visible or not, and this is
// applied as a pass afterwards (applyAllStoredVisibility). That runs synchronously with
// the add, so nothing paints in between — and it means none of those modules needs to
// know that toggling exists.

export type LayerGroup =
  | 'peaks'
  | 'hillshade'
  | 'contours'
  | 'paths'
  | 'sac'
  | 'terrainFeatures'
  | 'avalanche'
  | 'footprints';

export const LAYER_GROUP_ORDER: readonly LayerGroup[] = [
  'peaks',
  'hillshade',
  'contours',
  'paths',
  'sac',
  'terrainFeatures',
  'avalanche',
  'footprints',
];

/**
 * Every group on except avalanche terrain. A walking map that arrives pre-shaded in five
 * colours is not what most people want in June, and a safety layer that is always on is a
 * layer people stop seeing.
 */
const DEFAULT_VISIBLE: Record<LayerGroup, boolean> = {
  peaks: true,
  hillshade: true,
  contours: true,
  paths: true,
  sac: true,
  terrainFeatures: true,
  avalanche: false,
  footprints: true,
};

/**
 * The style layer ids each group covers, matched as suffixes so every downloaded region's
 * `region-<id>-…` copy is found without tracking which regions exist.
 *
 * Each is the full distinguishing tail, never a bare fragment: contours and SAC both emit a
 * `…-labels` layer, and `-labels` alone would switch both off at once. An exact id is just
 * a suffix that happens to be the whole string.
 */
const LAYER_ID_SUFFIXES: Record<LayerGroup, readonly string[]> = {
  peaks: [PEAKS_LAYER_ID, `${PEAKS_LAYER_ID}-marker`],
  // The global catalog's `hillshade` and every region's `…-terrain-hillshade`.
  hillshade: ['hillshade'],
  contours: ['-contours-lines-index', '-contours-lines', '-contours-labels'],
  // Both flavours: the basemap artifact's own paths above z14 (`…-basemap-paths`) and the
  // low-zoom paths artifact below it (`…-paths-paths`).
  paths: ['-paths-casing', '-paths'],
  sac: ['-sac-band', '-sac-labels'],
  terrainFeatures: ['-terrain-features-fill', '-terrain-features-points'],
  avalanche: ['-avalanche-shade'],
  footprints: [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID],
};

export function matchesGroup(layerId: string, group: LayerGroup): boolean {
  return LAYER_ID_SUFFIXES[group].some((suffix) => layerId.endsWith(suffix));
}

const STORAGE_KEY = 'ratmap:visible-layers';

function readStored(): Partial<Record<LayerGroup, boolean>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<LayerGroup, boolean>>) : {};
  } catch {
    // Private mode, or a value this version cannot read: fall back to the defaults.
    return {};
  }
}

function visibleIn(stored: Partial<Record<LayerGroup, boolean>>, group: LayerGroup): boolean {
  const value = stored[group];
  return typeof value === 'boolean' ? value : DEFAULT_VISIBLE[group];
}

export function isLayerVisible(group: LayerGroup): boolean {
  return visibleIn(readStored(), group);
}

export function setLayerVisible(group: LayerGroup, visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), [group]: visible }));
  } catch {
    // Private mode: the toggle still works for this session, it just won't be remembered.
  }
}

/**
 * Set every matching layer's visibility from one read of the stored state.
 *
 * `getLayersOrder()` rather than `getStyle()`: the latter serialises the entire style, and
 * this runs after every region add and every footprint redraw — which happens mid-pan
 * whenever the region the detail notice offers changes.
 */
function applyGroups(map: MLMap, groups: readonly LayerGroup[]): void {
  const stored = readStored();
  const layerIds = map.getLayersOrder();
  for (const group of groups) {
    const visibility = visibleIn(stored, group) ? 'visible' : 'none';
    for (const id of layerIds) {
      if (matchesGroup(id, group)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }
}

/** Show or hide every layer in the style that belongs to `group`, per its stored state. */
export function applyLayerVisibility(map: MLMap, group: LayerGroup): void {
  applyGroups(map, [group]);
}

/**
 * Re-assert every group's stored state. Called after anything adds layers — app start,
 * a theme swap, a region restored or downloaded, footprints redrawn — so a layer created
 * after its toggle was switched off still comes out hidden.
 */
export function applyAllStoredVisibility(map: MLMap): void {
  applyGroups(map, LAYER_GROUP_ORDER);
}
