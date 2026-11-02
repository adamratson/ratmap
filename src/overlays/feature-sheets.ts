import type { LngLat } from 'maplibre-gl';
import { formatElevation, isMunro, type PeakProperties } from './peaks';
import { sacCssColor, type SacHit } from './sac';
import {
  AVALANCHE_TERRAIN_ONLY,
  aspectName,
  forecastServiceFor,
  slopeClassFor,
  slopeCssColor,
  SLOPE_CLASSES,
  SLOPE_FLOOR_DEG,
} from './avalanche';
import type { AvalancheCell } from '../routes/avalanche-sampler';
import type { Region } from '../regions/manifest';
import { fillReadout } from '../ui/readout';
import type { StatusCentre } from '../ui/status';
import { savePlace } from '../search/saved-places';

// The detail cards for something tapped on the map — a summit, a graded path, a bare
// point — and the summit tooltip a mouse gets before it taps. Each renders into the sheet
// body it is handed; opening the sheet is the caller's job.

type Toasts = Pick<StatusCentre, 'toast'>;

/**
 * What the avalanche terrain artifact says about a tapped point, as the planner reads it:
 * null where no downloaded region carries the artifact, `cell: null` inside one where the
 * archive has no tile.
 */
export type AvalancheReading = Promise<{ cell: AvalancheCell | null; region: Region } | null>;

export function renderPeakSheet(
  body: HTMLElement,
  peak: PeakProperties,
  lngLat: LngLat,
  { status, avalanche }: { status: Toasts; avalanche?: AvalancheReading },
): void {
  const name = peak.name?.trim() || 'Unnamed summit';
  const ele = formatElevation(peak.ele);
  const wikidata = peak.wikidata;
  const munro = isMunro(peak);

  body.innerHTML = `
    <h2></h2>
    ${munro ? `<p class="sheet-munro-badge">▲ Munro</p>` : ''}
    <p class="sheet-ele"></p>
    <p class="sheet-coords"></p>
    <div class="sheet-actions">
      <button class="sheet-save" type="button">Save place</button>
      ${wikidata ? `<a class="sheet-link" target="_blank" rel="noreferrer">Wikidata</a>` : ''}
    </div>
    <div class="sheet-actions sheet-open-in"></div>
    ${avalanche ? '<div class="sheet-avalanche"></div>' : ''}
  `;
  // textContent, not interpolation: names come from OSM, which is user-editable data.
  body.querySelector('h2')!.textContent = name;
  fillReadout(body.querySelector<HTMLElement>('.sheet-ele')!, ele ?? 'Elevation unknown');
  body.querySelector('.sheet-coords')!.textContent =
    `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  if (wikidata) {
    const link = body.querySelector<HTMLAnchorElement>('.sheet-link')!;
    link.href = `https://www.wikidata.org/wiki/${encodeURIComponent(wikidata)}`;
  }
  renderOpenIn(body.querySelector<HTMLElement>('.sheet-open-in')!, lngLat, name);
  if (avalanche) renderAvalancheReadout(body.querySelector<HTMLElement>('.sheet-avalanche')!, avalanche);

  body.querySelector('.sheet-save')!.addEventListener('click', () => {
    void savePlace({
      name,
      lng: lngLat.lng,
      lat: lngLat.lat,
      ...(typeof peak.ele === 'number' ? { ele: peak.ele } : {}),
    })
      .then(() => status.toast(`Saved “${name}”`))
      .catch((err: Error) =>
        status.toast(`Could not save “${name}”: ${err.message}`, { kind: 'error' }),
      );
  });
}

/**
 * What a tapped path's SAC grade means, in the grade's own words.
 *
 * The scale is the SAC's, so the sheet quotes what the grade demands rather than
 * paraphrasing it into "easy/hard" — the whole value of a graded scale is that T3 means
 * the same thing on every mountain.
 *
 * Only for a hit that carries a grade; the caller checks.
 */
export function renderPathSheet(body: HTMLElement, hit: SacHit & { grade: NonNullable<SacHit['grade']> }): void {
  const grade = hit.grade;
  const name = hit.properties.name?.trim();

  body.innerHTML = `
    <h2></h2>
    <p class="sheet-sac-grade"></p>
    <p class="sheet-sac-note"></p>
    <p class="sheet-note"></p>
  `;
  // textContent throughout: path names come from OSM, which is user-editable data.
  body.querySelector('h2')!.textContent = name || 'Path';

  const gradeLine = body.querySelector<HTMLElement>('.sheet-sac-grade')!;
  gradeLine.textContent = `${grade.short} · ${grade.label}`;
  gradeLine.style.color = sacCssColor(grade.grade);

  body.querySelector('.sheet-sac-note')!.textContent = grade.note;
  body.querySelector('.sheet-note')!.textContent =
    'SAC hiking scale from OpenStreetMap.';
}

/**
 * Right-click or long-press anywhere on the map to read off its coordinates — just the raw
 * lat/lng and the ground height there. There's no OSM feature behind a bare point to link
 * out to, so beyond copy and save the only way out is another maps app.
 *
 * `elevation` is a promise because it is read from a terrain archive, which can take a tile
 * fetch and decode; the sheet opens at once and fills the height in when it lands. It
 * resolves null where there is no downloaded terrain to read.
 */
export function renderCoordsSheet(
  body: HTMLElement,
  lngLat: LngLat,
  {
    status,
    elevation,
    avalanche,
  }: { status: Toasts; elevation: Promise<number | null>; avalanche?: AvalancheReading },
): void {
  const coordsText = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;

  body.innerHTML = `
    <h2></h2>
    <p class="sheet-ele">Reading elevation…</p>
    <div class="sheet-actions">
      <button class="sheet-copy" type="button">Copy</button>
      <button class="sheet-save" type="button">Save place</button>
    </div>
    <div class="sheet-actions sheet-open-in"></div>
    ${avalanche ? '<div class="sheet-avalanche"></div>' : ''}
  `;
  body.querySelector('h2')!.textContent = coordsText;
  renderOpenIn(body.querySelector<HTMLElement>('.sheet-open-in')!, lngLat, coordsText);
  if (avalanche) renderAvalancheReadout(body.querySelector<HTMLElement>('.sheet-avalanche')!, avalanche);

  // Saved with the place once known, as a summit's height is. A save tapped before the
  // read lands goes without it rather than waiting on it.
  let ele: number | undefined;
  const eleLine = body.querySelector<HTMLElement>('.sheet-ele')!;
  elevation
    .then((metres) => {
      const text = formatElevation(metres);
      if (text && metres !== null) ele = metres;
      fillReadout(eleLine, text ?? 'Elevation needs a downloaded region');
    })
    .catch((err: Error) => fillReadout(eleLine, `Could not read elevation: ${err.message}`));

  body.querySelector('.sheet-copy')!.addEventListener('click', () => {
    navigator.clipboard
      .writeText(coordsText)
      .then(() => status.toast('Copied coordinates'))
      .catch((err: Error) => status.toast(`Could not copy: ${err.message}`, { kind: 'error' }));
  });

  body.querySelector('.sheet-save')!.addEventListener('click', () => {
    void savePlace({
      name: coordsText,
      lng: lngLat.lng,
      lat: lngLat.lat,
      ...(ele === undefined ? {} : { ele }),
    })
      .then(() => status.toast(`Saved “${coordsText}”`))
      .catch((err: Error) =>
        status.toast(`Could not save “${coordsText}”: ${err.message}`, { kind: 'error' }),
      );
  });
}

/**
 * Links that hand a point to another maps app — https rather than a `waze://`-style scheme,
 * so each opens the app where it is installed and the service's web map where it isn't.
 *
 * The position goes as coordinates, never as a search for the name: a summit's name can
 * resolve to somewhere else entirely, and that link would look fine. `label` only names the
 * pin. Apple needs one regardless: `ll` alone centres the map and marks nothing. Its newer
 * `/place` URLs would not, but they need iOS 18.4 and this app runs from iOS 17.
 *
 * `wrap` because a tap on a repeated world copy reports a longitude past ±180 — see §2.
 */
export function openInLinks(lngLat: LngLat, label: string): { name: string; href: string }[] {
  const { lng, lat } = lngLat.wrap();
  const ll = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  return [
    {
      name: 'Google Maps',
      href: `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: ll })}`,
    },
    { name: 'Waze', href: `https://www.waze.com/ul?${new URLSearchParams({ ll })}` },
    { name: 'Apple Maps', href: `https://maps.apple.com/?${new URLSearchParams({ ll, q: label })}` },
  ];
}

function renderOpenIn(container: HTMLElement, lngLat: LngLat, label: string): void {
  const heading = document.createElement('span');
  heading.className = 'sheet-open-in-label';
  heading.textContent = 'Open in';

  const links = openInLinks(lngLat, label).map(({ name, href }) => {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = name;
    link.setAttribute('aria-label', `Open in ${name}`);
    return link;
  });
  container.replaceChildren(heading, ...links);
}

/**
 * Slope and aspect at a tapped point, from the avalanche terrain layer.
 *
 * Worded per plans/avalanche-terrain.md §1: a slope angle and what that angle means for
 * release, never a danger level. Below the floor is "under 25°", not "safe" — the cell
 * stores 0 for everything it does not draw (A7), and gentle ground can sit under a steep
 * slope (A6). Every reading ends on the terrain-only line and the region's forecast.
 */
export function renderAvalancheReadout(container: HTMLElement, reading: AvalancheReading): void {
  container.innerHTML = `
    <h3>Avalanche terrain</h3>
    <p class="sheet-avalanche-slope">Reading slope…</p>
    <p class="sheet-note sheet-avalanche-caveat"></p>
    <p class="sheet-note sheet-avalanche-forecast"></p>
  `;
  const slopeLine = container.querySelector<HTMLElement>('.sheet-avalanche-slope')!;
  const caveat = container.querySelector<HTMLElement>('.sheet-avalanche-caveat')!;
  const forecast = container.querySelector<HTMLElement>('.sheet-avalanche-forecast')!;
  caveat.textContent = AVALANCHE_TERRAIN_ONLY;

  reading
    .then((result) => {
      if (!result) {
        slopeLine.textContent = 'Needs a downloaded region with avalanche terrain.';
        return;
      }
      slopeLine.textContent = slopeSentence(result.cell);
      const slopeClass = result.cell ? slopeClassFor(result.cell.slope) : null;
      if (slopeClass) {
        // A swatch rather than coloured text: the palette's pale end is a fill colour,
        // unreadable as type on a light sheet.
        const swatch = document.createElement('span');
        swatch.className = 'sheet-avalanche-swatch';
        swatch.style.background = slopeCssColor(SLOPE_CLASSES.indexOf(slopeClass));
        slopeLine.prepend(swatch);
      }

      const service = forecastServiceFor(result.region.id);
      if (service) {
        forecast.append('Get the forecast before going: ');
        const link = document.createElement('a');
        link.href = service.url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = service.name;
        forecast.append(link, '.');
      } else {
        forecast.textContent =
          'No avalanche forecast service is listed for this region. Ask locally before going onto snow.';
      }
    })
    .catch((err: Error) => {
      slopeLine.textContent = `Could not read avalanche terrain: ${err.message}`;
    });
}

function slopeSentence(cell: AvalancheCell | null): string {
  if (!cell) return 'No slope data here.';
  const slopeClass = slopeClassFor(cell.slope);
  if (!slopeClass) return `Under ${SLOPE_FLOOR_DEG}° here.`;
  const aspect = cell.aspect === null ? null : aspectName(cell.aspect);
  const facing = aspect ? `, faces ${aspect}` : '';
  return `Slope ${cell.slope}°${facing}. ${slopeClass.note}`;
}

/**
 * Name and elevation before the click, on a mouse only.
 *
 * Touch has no hover to give — the tap sheet is its only path, and stays it. A mouse can
 * hover, and nothing here used to: free information density a touch user loses nothing
 * by not having (plans/desktop-ux-review.md C2). The caller gates it on the same "is this
 * a mouse" check `NavigationControl` already uses, rather than a second definition of it.
 */
export class PeakTooltip {
  private readonly element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  show(peak: PeakProperties, point: { x: number; y: number }): void {
    const name = peak.name?.trim() || 'Unnamed summit';
    const ele = formatElevation(peak.ele);
    // Built from nodes, not innerHTML: the name is OSM data, which anyone can edit — the
    // same reason renderPeakSheet writes it with textContent.
    this.element.replaceChildren(name);
    if (ele) {
      const figure = document.createElement('span');
      figure.className = 'peak-tooltip-ele';
      fillReadout(figure, ele);
      this.element.append(' ', figure);
    }
    this.element.style.left = `${point.x}px`;
    this.element.style.top = `${point.y}px`;
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
