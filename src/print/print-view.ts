import type { Map as MLMap } from 'maplibre-gl';
import { shareOrDownload } from '../app/share-file';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import type { RouteRegionOffer } from '../regions/coverage';
import type { Region } from '../regions/manifest';
import { renderSheet, type PrintSheet } from './print-render';
import {
  PRINT_SCALES,
  formatScale,
  groundSize,
  metresPerCssPx,
  sheetLayout,
  type Orientation,
  type PrintScale,
} from './sheet-geometry';

// The Print view, and the frame it draws over the map: the A4 sheet's true footprint at
// the chosen scale, so what is inside the frame is what is on the paper. The map moves
// under it; the frame stays put in the middle of whatever the sheet leaves visible.

export interface PrintDeps {
  map: MLMap;
  registry: TileSourceRegistry;
  /** The part of the map not covered by the sheet, in map-container px. */
  visibleArea: () => { left: number; top: number; right: number; bottom: number };
  downloadedRegions: () => readonly Region[];
  /** What to download for points no downloaded region covers — see RegionCoverage. */
  regionOffer: (points: [number, number][]) => RouteRegionOffer | null;
  /** The route on the map now, if any, to print with the sheet. */
  route: () => Promise<GeoJSON.GeoJSON | null>;
  onStatus: (message: string, kind: 'ok' | 'warn' | 'error') => void;
}

interface PrintOptions {
  scale: PrintScale;
  orientation: Orientation;
}

const STORAGE_KEY = 'ratmap.print';

/** How much of the visible map the frame fills when the view opens. */
const FIT_FRACTION = 0.8;

type State =
  | { kind: 'idle' }
  | { kind: 'making' }
  | { kind: 'ready'; file: File; complete: boolean };

export class PrintController {
  private readonly deps: PrintDeps;
  private readonly frame: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private options: PrintOptions = readStored();
  private state: State = { kind: 'idle' };
  private active = false;
  /** Where the view is drawn while it is open. */
  private body: HTMLElement | null = null;
  /** Bumped on hide, so a sheet finished after the view closed is dropped. */
  private generation = 0;

  constructor(deps: PrintDeps) {
    this.deps = deps;
    this.frame = document.createElement('div');
    this.frame.className = 'print-frame';
    this.frame.hidden = true;
    this.frame.setAttribute('aria-hidden', 'true');
    this.label = document.createElement('span');
    this.label.className = 'print-frame-label';
    this.frame.append(this.label);
    deps.map.getContainer().append(this.frame);
  }

  /** Show the frame and bring the map to a zoom where the whole sheet is in view. */
  show(): void {
    if (this.active) return;
    this.active = true;
    this.frame.hidden = false;
    this.deps.map.on('move', this.place);
    this.deps.map.on('moveend', this.moved);
    this.fit();
    this.place();
    this.renderCoverage();
  }

  hide(): void {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    this.frame.hidden = true;
    this.deps.map.off('move', this.place);
    this.deps.map.off('moveend', this.moved);
    this.body = null;
    this.state = { kind: 'idle' };
  }

  /** The sheet moved under the frame (a drag, or the sheet's own layout changing). */
  layoutChanged(): void {
    if (this.active) this.place();
  }

  render(body: HTMLElement): void {
    this.body = body;
    const { scale, orientation } = this.options;
    body.innerHTML = `
      <h2>Print</h2>
      <p class="sheet-note">
        An A4 sheet of the map inside the frame. Move the map to choose the area.
      </p>
      <div class="settings-row settings-row-static">
        <span class="settings-row-text">
          <span class="settings-row-label" id="print-scale-label">Scale</span>
        </span>
        <div class="segmented" role="radiogroup" aria-labelledby="print-scale-label">
          ${PRINT_SCALES.map(
            (value) => `
            <label>
              <input type="radio" name="print-scale" value="${value}" ${value === scale ? 'checked' : ''} />
              <span>${formatScale(value)}</span>
            </label>`,
          ).join('')}
        </div>
      </div>
      <div class="settings-row settings-row-static">
        <span class="settings-row-text">
          <span class="settings-row-label" id="print-paper-label">Paper</span>
        </span>
        <div class="segmented" role="radiogroup" aria-labelledby="print-paper-label">
          ${(['portrait', 'landscape'] as const)
            .map(
              (value) => `
            <label>
              <input type="radio" name="print-orientation" value="${value}" ${value === orientation ? 'checked' : ''} />
              <span>${value === 'portrait' ? 'Portrait' : 'Landscape'}</span>
            </label>`,
            )
            .join('')}
        </div>
      </div>
      <p class="print-coverage" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="print-action"></button>
      </div>
      <p class="sheet-note print-hint">
        Print at actual size (100%), not “fit to page”, or the scale will be wrong.
      </p>
    `;

    for (const radio of body.querySelectorAll<HTMLInputElement>('input[name="print-scale"]')) {
      radio.addEventListener('change', () => {
        if (radio.checked) this.setOptions({ scale: Number(radio.value) as PrintScale });
      });
    }
    for (const radio of body.querySelectorAll<HTMLInputElement>('input[name="print-orientation"]')) {
      radio.addEventListener('change', () => {
        if (radio.checked) this.setOptions({ orientation: radio.value as Orientation });
      });
    }
    body.querySelector('.print-action')!.addEventListener('click', () => void this.act());

    this.renderAction();
    this.renderCoverage();
  }

  /** The sheet the frame shows now. */
  sheet(): PrintSheet {
    const { x, y } = this.areaCentre();
    const centre = this.deps.map.unproject([x, y]).wrap();
    return { centre: [centre.lng, centre.lat], ...this.options };
  }

  private setOptions(change: Partial<PrintOptions>): void {
    this.options = { ...this.options, ...change };
    writeStored(this.options);
    this.reset();
    this.fit();
    this.place();
  }

  private async act(): Promise<void> {
    if (this.state.kind === 'making') return;
    if (this.state.kind === 'ready') {
      // Straight from the tap, so the share sheet still has the tap's permission to open.
      const { file } = this.state;
      const outcome = await shareOrDownload(file, 'ratmap A4 map');
      if (outcome === 'downloaded') this.deps.onStatus(`Saved ${file.name}`, 'ok');
      return;
    }

    const generation = this.generation;
    this.state = { kind: 'making' };
    this.renderAction();
    try {
      const printed = await renderSheet(this.sheet(), {
        registry: this.deps.registry,
        regions: this.deps.downloadedRegions(),
        route: await this.deps.route(),
      });
      if (generation !== this.generation) return;
      this.state = { kind: 'ready', ...printed };
      if (!printed.complete) {
        this.deps.onStatus('Part of the map hadn’t loaded in time — check the sheet before printing.', 'warn');
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.state = { kind: 'idle' };
      this.deps.onStatus(`Couldn’t make the sheet: ${(err as Error)?.message ?? 'unknown error'}`, 'error');
    }
    this.renderAction();
  }

  /** A finished sheet is of the area it was made from; anything else needs a new one. */
  private reset(): void {
    if (this.state.kind !== 'ready') return;
    this.state = { kind: 'idle' };
    this.renderAction();
  }

  private renderAction(): void {
    const button = this.body?.querySelector<HTMLButtonElement>('.print-action');
    if (!button) return;
    button.disabled = this.state.kind === 'making';
    button.textContent =
      this.state.kind === 'making'
        ? 'Making the sheet…'
        : this.state.kind === 'ready'
          ? sharesFiles()
            ? 'Share PDF'
            : 'Save PDF'
          : 'Make PDF';
  }

  private renderCoverage(): void {
    const note = this.body?.querySelector<HTMLParagraphElement>('.print-coverage');
    if (!note) return;
    const offer = this.deps.regionOffer(this.corners());
    note.hidden = offer === null;
    if (offer === null) return;
    // Honest about the gap rather than printing a sheet that is detailed in one corner
    // and an outline of the coast in the rest, with nothing on the paper to say why.
    note.textContent =
      offer.kind === 'region'
        ? `Some of this sheet is outside your downloaded maps, and prints with very little detail there. Download ${offer.region.name} for the whole sheet.`
        : 'Some of this sheet is outside any one downloaded region, and may print with very little detail there.';
  }

  private readonly moved = (): void => {
    this.reset();
    this.renderCoverage();
  };

  /** Size and place the frame for the map as it is now. Runs on every move. */
  private readonly place = (): void => {
    const { map } = this.deps;
    const { x, y } = this.areaCentre();
    const lat = map.unproject([x, y]).lat;
    const ground = groundSize(sheetLayout(this.options.orientation), this.options.scale);
    const metresPerPx = metresPerCssPx(map.getZoom(), lat);
    const w = ground.w / metresPerPx;
    const h = ground.h / metresPerPx;
    Object.assign(this.frame.style, {
      left: `${x - w / 2}px`,
      top: `${y - h / 2}px`,
      width: `${w}px`,
      height: `${h}px`,
      // The sheet is always printed north-up. On a rotated map, north-up is turned.
      transform: `rotate(${-map.getBearing()}deg)`,
    });
    this.label.textContent = `A4 · ${formatScale(this.options.scale)}`;
  };

  /** Zoom so the whole sheet sits inside the visible map, around the frame's centre. */
  private fit(): void {
    const { map } = this.deps;
    const area = this.deps.visibleArea();
    const { x, y } = this.areaCentre();
    const around = map.unproject([x, y]);
    const ground = groundSize(sheetLayout(this.options.orientation), this.options.scale);
    const fitPx = Math.min(
      (area.right - area.left) / ground.w,
      (area.bottom - area.top) / ground.h,
    ) * FIT_FRACTION;
    // metresPerCssPx(z) = metresPerCssPx(0) / 2^z, solved for the px-per-metre wanted.
    const zoom = Math.log2(fitPx * metresPerCssPx(0, around.lat));
    // No room at all — a hidden or zero-sized window — gives log2(0). A NaN zoom handed to
    // MapLibre does not throw; it breaks the map until a reload.
    if (!Number.isFinite(zoom)) return;
    map.easeTo({
      zoom: Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom)),
      bearing: 0,
      pitch: 0,
      around,
      duration: 300,
    });
  }

  private areaCentre(): { x: number; y: number } {
    const area = this.deps.visibleArea();
    return { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
  }

  private corners(): [number, number][] {
    const box = this.frame.getBoundingClientRect();
    const origin = this.deps.map.getContainer().getBoundingClientRect();
    return [
      [box.left, box.top],
      [box.right, box.top],
      [box.right, box.bottom],
      [box.left, box.bottom],
    ].map(([px, py]) => {
      const point = this.deps.map.unproject([px! - origin.left, py! - origin.top]).wrap();
      return [point.lng, point.lat];
    });
  }
}

/** Whether "Share" is the honest word for what the button will do on this device. */
function sharesFiles(): boolean {
  try {
    const probe = new File([''], 'probe.pdf', { type: 'application/pdf' });
    return navigator.canShare?.({ files: [probe] }) ?? false;
  } catch {
    return false;
  }
}

function readStored(): PrintOptions {
  const fallback: PrintOptions = { scale: 25_000, orientation: 'portrait' };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PrintOptions> | null;
    return {
      scale: PRINT_SCALES.includes(stored?.scale as PrintScale) ? (stored!.scale as PrintScale) : fallback.scale,
      orientation: stored?.orientation === 'landscape' ? 'landscape' : 'portrait',
    };
  } catch {
    return fallback;
  }
}

function writeStored(options: PrintOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Private mode: the choice lasts the session, which is fine.
  }
}
