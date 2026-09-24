import type { Map as MLMap } from 'maplibre-gl';
import type { MapInk } from '../map/flavor';
import {
  LAYER_GROUP_ORDER,
  applyLayerVisibility,
  isLayerVisible,
  setLayerVisible,
  type LayerGroup,
} from '../map/layers';
import { SAC_GRADES, sacCssColor } from '../overlays/sac';
import { terrainSwatch } from '../overlays/terrain-features';
import { slopeCssColor } from '../overlays/avalanche';
import { lineSwatch } from './legend-view';

// The Layers tab: a switch per overlay. Which style layers each switch means, and
// remembering the choice, is map/layers.ts's job; this is only the rows.

/**
 * One row per switchable overlay. Swatches are the Legend's own, read from the same inks,
 * so a row shows what it switches in the colour the map draws it.
 */
const LAYER_ROWS: Record<LayerGroup, { label: string; note: string; swatch: (ink: MapInk) => string }> = {
  peaks: {
    label: 'Summits',
    note: 'Summit markers, names and heights.',
    swatch: (ink) =>
      `<svg viewBox="0 0 40 24"><circle cx="20" cy="12" r="6" fill="${ink.peakDot}" stroke="${ink.peakDotStroke}" stroke-width="2"/></svg>`,
  },
  hillshade: {
    label: 'Hillshade',
    note: 'Shaded relief.',
    swatch: () => '<div class="legend-hillshade-swatch"></div>',
  },
  contours: {
    label: 'Contours',
    note: 'Contour lines and heights, in downloaded regions.',
    swatch: (ink) =>
      `<svg viewBox="0 0 40 24"><path d="M3,17 C14,17 12,7 23,7 S34,15 37,9" fill="none" stroke="${ink.contour}" stroke-width="1.2"/></svg>`,
  },
  paths: {
    label: 'Paths and tracks',
    note: 'Footpaths and tracks, in downloaded regions.',
    swatch: (ink) => lineSwatch(ink.pathLine, 2, { dash: '4 3', casing: ink.pathCasing, cap: 'butt' }),
  },
  sac: {
    label: 'Path grade (SAC)',
    note: 'T1–T6 colour bands under graded paths.',
    swatch: () => lineSwatch(sacCssColor(SAC_GRADES[2].grade), 7, { cap: 'butt' }),
  },
  terrainFeatures: {
    label: 'Ground surface',
    note: 'Scree, shingle and rock outcrops.',
    swatch: (ink) => terrainSwatch('scree', ink),
  },
  avalanche: {
    label: 'Avalanche terrain',
    note: 'Slopes shaded by steepness. Terrain only — not a forecast. Off by default.',
    swatch: () =>
      `<svg viewBox="0 0 40 24"><rect x="3" y="5" width="34" height="14" rx="2" fill="${slopeCssColor(2)}" fill-opacity="0.75"/></svg>`,
  },
  footprints: {
    label: 'Offline coverage',
    note: 'Outlines of downloaded and available regions.',
    swatch: () =>
      '<svg viewBox="0 0 40 24"><rect x="3" y="4" width="34" height="16" rx="2" fill="#15803d" fill-opacity="0.12" stroke="#15803d" stroke-width="1.5"/></svg>',
  },
};

/** Fill `body` with a switch per overlay, applied to `map` as it is flipped. */
export function renderLayersView(body: HTMLElement, { map, ink }: { map: MLMap; ink: MapInk }): void {
  body.innerHTML = `
    ${LAYER_GROUP_ORDER.map((group) => {
      const row = LAYER_ROWS[group];
      return `
        <label class="legend-row layer-row">
          <div class="legend-swatch">${row.swatch(ink)}</div>
          <span class="legend-row-text">
            <span class="legend-row-label">${row.label}</span>
            <span class="legend-row-note">${row.note}</span>
          </span>
          <input id="layer-toggle-${group}" type="checkbox" data-group="${group}" />
        </label>
      `;
    }).join('')}
  `;
  for (const input of body.querySelectorAll<HTMLInputElement>('input[data-group]')) {
    const group = input.dataset.group as LayerGroup;
    input.checked = isLayerVisible(group);
    input.addEventListener('change', () => {
      setLayerVisible(group, input.checked);
      applyLayerVisibility(map, group);
    });
  }
}
