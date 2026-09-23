import type { LngLat } from 'maplibre-gl';
import { formatElevation, isMunro, type PeakProperties } from './peaks';
import { sacCssColor, type SacHit } from './sac';
import { fillReadout } from '../ui/readout';
import type { StatusCentre } from '../ui/status';
import { savePlace } from '../search/saved-places';

// The detail cards for something tapped on the map — a summit, a graded path, a bare
// point — and the summit tooltip a mouse gets before it taps. Each renders into the sheet
// body it is handed; opening the sheet is the caller's job.

type Toasts = Pick<StatusCentre, 'toast'>;

export function renderPeakSheet(
  body: HTMLElement,
  peak: PeakProperties,
  lngLat: LngLat,
  { status }: { status: Toasts },
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
    'SAC hiking scale, as tagged in OpenStreetMap. It describes the path in good summer conditions — snow, ice or bad weather put it up a grade or more.';
}

/**
 * Right-click or long-press anywhere on the map to read off its coordinates — just the raw
 * lat/lng, with copy and save as the only actions since there's no OSM feature behind a bare
 * point to link out to.
 */
export function renderCoordsSheet(
  body: HTMLElement,
  lngLat: LngLat,
  { status }: { status: Toasts },
): void {
  const coordsText = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;

  body.innerHTML = `
    <h2></h2>
    <div class="sheet-actions">
      <button class="sheet-copy" type="button">Copy</button>
      <button class="sheet-save" type="button">Save place</button>
    </div>
  `;
  body.querySelector('h2')!.textContent = coordsText;

  body.querySelector('.sheet-copy')!.addEventListener('click', () => {
    navigator.clipboard
      .writeText(coordsText)
      .then(() => status.toast('Copied coordinates'))
      .catch((err: Error) => status.toast(`Could not copy: ${err.message}`, { kind: 'error' }));
  });

  body.querySelector('.sheet-save')!.addEventListener('click', () => {
    void savePlace({ name: coordsText, lng: lngLat.lng, lat: lngLat.lat })
      .then(() => status.toast(`Saved “${coordsText}”`))
      .catch((err: Error) =>
        status.toast(`Could not save “${coordsText}”: ${err.message}`, { kind: 'error' }),
      );
  });
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
