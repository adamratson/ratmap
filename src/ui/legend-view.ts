import type { MapInk } from '../map/flavor';
import { SAC_GRADES, sacCssColor } from '../overlays/sac';
import { TERRAIN_FEATURE_KINDS, terrainSwatch } from '../overlays/terrain-features';
import { SLOPE_CLASSES, slopeCssColor } from '../overlays/avalanche';

// The map legend: every symbol the map draws, in the colours it draws them.

/** One legend entry: a swatch (SVG, matched to the real map colours) plus a label and note. */
export function legendRow(swatch: string, label: string, note: string): string {
  return `
    <div class="legend-row">
      <div class="legend-swatch">${swatch}</div>
      <div class="legend-row-text">
        <span class="legend-row-label">${label}</span>
        <span class="legend-row-note">${note}</span>
      </div>
    </div>
  `;
}

/**
 * A plain line swatch, optionally cased the way paths and routes are on the map — in the
 * casing colour passed, since that is white by day and graphite at night (mapInk()).
 */
export function lineSwatch(
  color: string,
  width: number,
  {
    dash,
    casing: casingColor,
    cap = 'round',
  }: { dash?: string; casing?: string; cap?: 'round' | 'butt' } = {},
): string {
  const casing = casingColor
    ? `<line x1="3" y1="12" x2="37" y2="12" stroke="${casingColor}" stroke-width="${width + 3}" stroke-linecap="round"/>`
    : '';
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  return (
    `<svg viewBox="0 0 40 24">${casing}` +
    `<line x1="3" y1="12" x2="37" y2="12" stroke="${color}" stroke-width="${width}"${dashAttr} stroke-linecap="${cap}"/></svg>`
  );
}

/** Fill `body` with the legend, drawn in `ink` — the theme showing now. */
export function renderLegend(body: HTMLElement, ink: MapInk): void {
  // The swatches read the same inks the map layers do, for the theme showing now. A
  // hardcoded swatch is how the legend drifted from the map last time: violet summits
  // and a blue route, long after the map had moved on.
  body.innerHTML = `
    <div class="legend-section">
      <h3>Summits</h3>
      ${legendRow(
        `<svg viewBox="0 0 40 24"><circle cx="20" cy="12" r="6" fill="${ink.peakDot}" stroke="${ink.peakDotStroke}" stroke-width="2"/></svg>`,
        'Summit',
        'Named and given a height once its prominence clears the zoom threshold — less prominent summits appear as you zoom in.',
      )}
    </div>

    <div class="legend-section">
      <h3>Paths</h3>
      ${legendRow(
        lineSwatch(ink.pathLine, 2, { dash: '4 3', casing: ink.pathCasing, cap: 'butt' }),
        'Footpath',
        'Dashed. Drawn once its region is downloaded, from zoom 12.',
      )}
      ${legendRow(
        lineSwatch(ink.pathLine, 3.2, { casing: ink.pathCasing }),
        'Track',
        'Solid and heavier than a footpath — vehicle-width.',
      )}
    </div>

    <div class="legend-section">
      <h3>Path grade (SAC)</h3>
      <p class="legend-note">
        The Swiss Alpine Club's T1–T6 scale, where OpenStreetMap carries it — a coloured
        band under the path, labelled from zoom 14. Most paths are not graded; an
        unbanded path is untagged, not necessarily easy.
      </p>
      ${SAC_GRADES.map((entry) =>
        legendRow(
          lineSwatch(sacCssColor(entry.grade), 7, { cap: 'butt' }),
          `${entry.short} · ${entry.label}`,
          entry.note,
        ),
      ).join('')}
    </div>

    <div class="legend-section">
      <h3>Relief</h3>
      ${legendRow(
        `<svg viewBox="0 0 40 24"><path d="M3,17 C14,17 12,7 23,7 S34,15 37,9" fill="none" stroke="${ink.contour}" stroke-width="1.2"/></svg>`,
        'Contour line',
        '10 m interval, where a region is fully downloaded.',
      )}
      ${legendRow(
        `<svg viewBox="0 0 40 24"><path d="M3,17 C14,17 12,7 23,7 S34,15 37,9" fill="none" stroke="${ink.contourLabel}" stroke-width="1.8"/><text x="21" y="6.5" font-size="6.5" fill="${ink.contourLabel}" text-anchor="middle">620</text></svg>`,
        'Index contour',
        'Every 50 m, drawn heavier and labelled with height — count the thin lines between them for the rest.',
      )}
      ${legendRow(
        '<div class="legend-hillshade-swatch"></div>',
        'Hillshade',
        'Shaded relief from downloaded terrain — fades out at close zoom, where contours carry the detail instead.',
      )}
    </div>

    <div class="legend-section">
      <h3>Ground surface</h3>
      <p class="legend-note">
        Scree, shingle and rock outcrops — OpenStreetMap detail the basemap has no room
        for. Coverage is partial and uneven: a hillside with nothing shown here is not
        "there is no scree there", most of the world's surface tagging is simply
        incomplete.
      </p>
      ${TERRAIN_FEATURE_KINDS.map((entry) =>
        legendRow(
          terrainSwatch(entry.kind === 'stone' ? 'rock' : entry.kind, ink),
          entry.label,
          entry.note,
        ),
      ).join('')}
    </div>

    <div class="legend-section">
      <h3>Avalanche terrain</h3>
      <p class="legend-note">
        Off by default &mdash; switch it on in Layers. Slope steepness computed from
        the downloaded region's elevation data, shaded where a slab could release.
        <strong>This is terrain, not a forecast.</strong> Avalanche danger is snowpack
        and weather as well as ground, and this map has never seen either. Unshaded is
        not the same as safe: the runout of a slope above you is often gentle ground.
      </p>
      ${SLOPE_CLASSES.map((entry) =>
        legendRow(
          `<svg viewBox="0 0 40 24"><rect x="3" y="5" width="34" height="14" rx="2" fill="${slopeCssColor(
            SLOPE_CLASSES.indexOf(entry),
          )}" fill-opacity="0.75"/></svg>`,
          entry.label,
          entry.note,
        ),
      ).join('')}
    </div>

    <div class="legend-section">
      <h3>Routes</h3>
      ${legendRow(
        lineSwatch(ink.routeLine, 3.5, { casing: ink.routeCasing }),
        'Route',
        'A planned or saved route, following real paths where the network allows.',
      )}
      ${legendRow(
        lineSwatch(ink.routeStraight, 3.5, { dash: '5 4', casing: ink.routeCasing, cap: 'butt' }),
        'Unsnapped leg',
        'No path connects these two waypoints — a straight line only, not a real route. Move a waypoint onto a path to fix it.',
      )}
      ${legendRow(
        lineSwatch(ink.offRoute, 2, { dash: '3 3' }),
        'Off-route',
        'Shown while following a route — the way back to it.',
      )}
    </div>

    <div class="legend-section">
      <h3>Offline coverage</h3>
      ${legendRow(
        '<svg viewBox="0 0 40 24"><rect x="3" y="4" width="34" height="16" rx="2" fill="#15803d" fill-opacity="0.12" stroke="#15803d" stroke-width="1.5"/></svg>',
        'Downloaded region',
        'Full detail, works offline.',
      )}
      ${legendRow(
        '<svg viewBox="0 0 40 24"><rect x="3" y="4" width="34" height="16" rx="2" fill="#2563eb" fill-opacity="0.08" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="3 3"/></svg>',
        'Available to download',
        'Outlined below full detail zoom — get it from the Offline tab.',
      )}
    </div>
  `;
}
