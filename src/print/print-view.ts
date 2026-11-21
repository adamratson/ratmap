import type { LngLat, Map as MLMap } from 'maplibre-gl';
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
// under it; the frame stays put in the middle of whatever the sheet leaves visible — and
// when the sheet moves, the map moves with the frame, so the frame never slides onto
// different ground.

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

/** The sheet's own snap (style.css, #sheet.sheet-animating), so the map keeps pace with it. */
const FOLLOW_SHEET_MS = 260;

type State =
  | { kind: 'idle' }
  | { kind: 'making' }
  | { kind: 'ready'; file: File; complete: boolean; centre: [number, number] };

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
  /**
   * The ground at the frame's centre. The frame is drawn over this, not over the middle of
   * the visible map: the two are the same except while the map is catching up with a
   * sheet that has moved, when the frame has to ride with the ground rather than sit still
   * over whatever slides under it.
   */
  private anchor: LngLat | null = null;
  /** True while the map is being moved to bring the anchor back to the middle. */
  private recentring = false;
  /** Which of those moves is the current one — see {@link moveTo}. */
  private move = 0;
  /** The zoom a fit is heading for, until it gets there. */
  private fitZoom: number | undefined = undefined;

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
    this.anchor = null;
    this.recentring = false;
    this.fitZoom = undefined;
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
    this.anchor = null;
    this.recentring = false;
    this.fitZoom = undefined;
    this.move++;
    this.body = null;
    this.state = { kind: 'idle' };
  }

  /**
   * The sheet moved (a drag, a view opening, its contents growing), so the middle of the
   * visible map is somewhere else. Move the map to bring the frame's ground there, in step
   * with the sheet.
   *
   * The frame used to jump to the new middle instead and stay over whatever ground was
   * there: dragging the sheet up to reach "Make PDF" moved the sheet's area 3–4 km north,
   * and the PDF was of somewhere the person had never chosen.
   */
  layoutChanged(): void {
    if (!this.active) return;
    if (!this.anchor) {
      this.place();
      return;
    }
    const at = this.deps.map.project(this.anchor);
    const target = this.areaCentre();
    // Most layout calls are a re-render that moved nothing.
    if (Math.hypot(at.x - target.x, at.y - target.y) < 1) return;
    // A fit still under way keeps its zoom: this move replaces it, and would otherwise
    // leave the sheet at whatever zoom the fit had reached.
    this.moveTo(this.anchor, this.fitZoom);
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
    const centre = (this.anchor ?? this.deps.map.unproject([x, y])).wrap();
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
    const sheet = this.sheet();
    try {
      const printed = await renderSheet(sheet, {
        registry: this.deps.registry,
        regions: this.deps.downloadedRegions(),
        route: await this.deps.route(),
      });
      if (generation !== this.generation) return;
      this.state = { kind: 'ready', ...printed, centre: sheet.centre };
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

  private readonly moved = (event: { printMove?: number }): void => {
    // A recentring move ends here, or ended because something else stopped it — a drag,
    // say, which is someone choosing the area again.
    if (this.recentring && event.printMove === this.move) {
      this.recentring = false;
      this.fitZoom = undefined;
      this.place();
    }
    // Only a move that changed the area makes the finished PDF out of date. The sheet
    // moving takes the map with it, and the PDF is still of exactly this ground.
    if (this.state.kind === 'ready') {
      const [lng, lat] = this.sheet().centre;
      const [madeLng, madeLat] = this.state.centre;
      if (Math.abs(lng - madeLng) > 1e-7 || Math.abs(lat - madeLat) > 1e-7) this.reset();
    }
    this.renderCoverage();
  };

  /** Size and place the frame for the map as it is now. Runs on every move. */
  private readonly place = (): void => {
    const { map } = this.deps;
    // Any move but the recentring is someone choosing the area: the ground under the middle
    // is the sheet's from now on.
    if (!this.recentring || !this.anchor) {
      const middle = this.areaCentre();
      this.anchor = map.unproject([middle.x, middle.y]);
    }
    const { x, y } = map.project(this.anchor);
    const lat = this.anchor.lat;
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
    const around = this.anchor ?? map.unproject([x, y]);
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
    this.fitZoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom));
    this.moveTo(around, this.fitZoom);
  }

  /**
   * Bring `anchor` to the middle of the visible map, at `zoom` if given, north up.
   *
   * Each move is tagged through MapLibre's eventData, and only the latest one's moveend
   * ends the recentring. Starting a move stops the one before, which fires *that* move's
   * moveend: answered by any moveend, it ended this one too, and from then on every frame
   * of it re-read the frame's ground off the middle of the map — the very thing the move
   * is there to put right. A listener added after easeTo instead would miss a move with
   * reduced motion on, which finishes inside the call.
   */
  private moveTo(anchor: LngLat, zoom: number | undefined): void {
    const { map } = this.deps;
    const target = this.areaCentre();
    const container = map.getContainer();
    const move = ++this.move;
    this.anchor = anchor;
    this.recentring = true;
    map.easeTo(
      {
        center: anchor,
        // From the middle of the map to the middle of what the sheet leaves of it.
        offset: [target.x - container.clientWidth / 2, target.y - container.clientHeight / 2],
        ...(zoom === undefined ? {} : { zoom }),
        bearing: 0,
        pitch: 0,
        duration: FOLLOW_SHEET_MS,
      },
      { printMove: move },
    );
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
