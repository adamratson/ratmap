import { COMPASS_UNRELIABLE_NT, fieldNear, type MagneticField } from '../location/declination';
import { HeadingWatcher, trueHeading, type Heading, type HeadingPermission } from '../location/heading';
import { gridConvergence, gridFor } from '../print/grid';

// The compass panel: which way the phone is pointing, as a number to walk on.
//
// The location dot's cone already answers "roughly which way am I facing". This answers
// what a cone cannot: a bearing, in degrees, against the same north a baseplate compass
// uses — and the true and grid bearings beside it, so one taken off the map can be
// compared without arithmetic in the rain.
//
// The phone's own reading is magnetic on every platform (heading.ts), so magnetic is the
// figure that is measured; true and grid are worked out from it with the local declination
// and grid convergence, and left blank rather than guessed where either is unknown.

/** Where the declination and grid convergence are worked out. */
export interface CompassPlace {
  lng: number;
  lat: number;
}

export interface CompassReadings {
  magnetic: number;
  true: number | null;
  grid: number | null;
  /** "OS National Grid", "UTM 30N" — what `grid` is measured against. */
  gridName: string;
}

/** The three bearings for a magnetic heading at a place. */
export function compassReadings(magnetic: number, place: CompassPlace, field: MagneticField | null): CompassReadings {
  const truth = trueHeading(magnetic, field);
  const grid = gridFor([place.lng, place.lat]);
  return {
    magnetic,
    true: truth,
    // Grid north is `convergence` east of true, so a bearing against it is that much less.
    grid: truth === null ? null : normalise(truth - gridConvergence(grid, [place.lng, place.lat])),
    gridName: grid.name,
  };
}

/** "047°": three figures, as a bearing is said and set on a compass. */
export function formatBearing(degrees: number): string {
  const whole = Math.round(normalise(degrees)) % 360;
  return `${whole.toString().padStart(3, '0')}°`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Sixteen points: this one is for walking on, unlike a search result's eight (geo.ts). */
export function cardinal(degrees: number): string {
  return POINTS[Math.round(normalise(degrees) / 22.5) % 16]!;
}

function normalise(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** How long to wait for a first reading before saying there may be no compass at all. */
const NO_READING_MS = 3000;

export interface CompassViewOptions {
  place: () => CompassPlace;
  now?: () => Date;
  noReadingMs?: number;
}

export class CompassView {
  private readonly place: () => CompassPlace;
  private readonly now: () => Date;
  private readonly noReadingMs: number;
  private readonly watcher: HeadingWatcher;
  private body: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seen = false;
  /**
   * The dial's angle, unwrapped. Turning from 359° to 1° is a 2° turn; set as rotate(1deg)
   * after rotate(-359deg) the transition spins the card the whole way round.
   */
  private dialAngle: number | null = null;

  constructor({ place, now = () => new Date(), noReadingMs = NO_READING_MS }: CompassViewOptions) {
    this.place = place;
    this.now = now;
    this.noReadingMs = noReadingMs;
    this.watcher = new HeadingWatcher((heading, accuracy) => this.update(heading, accuracy));
  }

  /**
   * Draw the panel into `body` and start the compass. Call from the tap that opened it:
   * iOS only offers the compass from a user gesture (heading.ts).
   */
  open(body: HTMLElement): void {
    this.stopTimer();
    this.body = body;
    this.seen = false;
    this.dialAngle = null;
    body.innerHTML = DIAL_HTML;
    this.setStatus('Waiting for the compass…');

    void this.watcher.start().then((permission) => this.started(permission));
  }

  close(): void {
    this.stopTimer();
    // Let go of the sheet first: stopping the watcher reports a last null heading, and by
    // now the sheet body holds whatever view replaced this one, or nothing.
    this.body = null;
    this.watcher.stop();
  }

  private started(permission: HeadingPermission): void {
    if (!this.body) return;
    if (permission === 'unsupported') {
      this.setStatus('This browser doesn’t give ratmap a compass.');
      return;
    }
    if (permission === 'denied') {
      this.setStatus('Compass access was refused. Reload ratmap to be asked again.');
      return;
    }
    this.timer = setTimeout(() => {
      if (!this.seen) {
        this.setStatus(
          'No compass reading. This device may not have one, or it may need calibrating: move the phone in a figure of eight.',
        );
      }
    }, this.noReadingMs);
  }

  private update(heading: Heading, accuracy: number | null): void {
    const body = this.body;
    const view = body?.querySelector<HTMLElement>('.compass-view');
    if (!body || !view) return;

    if (heading === null) {
      // Readings that have stopped making sense: an uncalibrated magnetometer on iOS.
      if (this.seen) this.setStatus('The compass needs calibrating: move the phone in a figure of eight.');
      view.classList.add('compass-no-reading');
      setText(body, '.compass-heading-value', '—');
      setText(body, '.compass-heading-point', '');
      return;
    }

    this.seen = true;
    this.stopTimer();
    view.classList.remove('compass-no-reading');

    const place = this.place();
    const field = fieldNear(place.lat, place.lng, this.now());
    const readings = compassReadings(heading, place, field);

    setText(body, '.compass-heading-value', formatBearing(readings.magnetic));
    setText(body, '.compass-heading-point', cardinal(readings.magnetic));
    setText(body, '.compass-true', readings.true === null ? '—' : formatBearing(readings.true));
    setText(body, '.compass-grid', readings.grid === null ? '—' : formatBearing(readings.grid));
    setText(body, '.compass-grid-name', readings.gridName === 'OS National Grid' ? 'Grid (OS)' : `Grid (${readings.gridName})`);
    const accuracyRow = body.querySelector<HTMLElement>('.compass-accuracy-row')!;
    accuracyRow.hidden = accuracy === null;
    if (accuracy !== null) setText(body, '.compass-accuracy', `±${Math.round(accuracy)}°`);

    this.turnDial(readings.magnetic, field);
    this.setStatus(
      field && field.horizontal < COMPASS_UNRELIABLE_NT
        ? 'This close to the magnetic pole a compass is unreliable.'
        : null,
    );
  }

  /** The card turns so its N lies along magnetic north; the lubber line at the top stays put. */
  private turnDial(magnetic: number, field: MagneticField | null): void {
    const body = this.body!;
    const target = -magnetic;
    if (this.dialAngle === null) this.dialAngle = target;
    else this.dialAngle += ((((target - this.dialAngle) % 360) + 540) % 360) - 180;
    body.querySelector<SVGGElement>('.compass-card')!.style.transform = `rotate(${this.dialAngle}deg)`;

    // True north, on the card: magnetic north less the declination.
    const marker = body.querySelector<SVGGElement>('.compass-true-north')!;
    const usable = field !== null && field.horizontal >= COMPASS_UNRELIABLE_NT;
    marker.style.display = usable ? '' : 'none';
    if (usable) marker.style.transform = `rotate(${-field.declination}deg)`;
  }

  private setStatus(message: string | null): void {
    const status = this.body?.querySelector<HTMLElement>('.compass-status');
    if (!status) return;
    status.hidden = message === null;
    if (message !== null && status.textContent !== message) status.textContent = message;
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Only touches the DOM when the text changes: this runs on every degree the phone turns. */
function setText(root: HTMLElement, selector: string, text: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (el && el.textContent !== text) el.textContent = text;
}

function ticks(): string {
  let out = '';
  for (let deg = 0; deg < 360; deg += 10) {
    const major = deg % 30 === 0;
    out += `<line class="compass-tick${major ? ' major' : ''}" x1="0" y1="-88" x2="0" y2="${major ? -76 : -81}" transform="rotate(${deg})"/>`;
  }
  return out;
}

function labels(): string {
  const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  let out = '';
  for (let deg = 0; deg < 360; deg += 30) {
    const name = names[deg];
    const cls = name ? `compass-label cardinal${deg === 0 ? ' north' : ''}` : 'compass-label';
    out += `<text class="${cls}" x="0" y="${name ? -58 : -62}" transform="rotate(${deg})">${name ?? deg}</text>`;
  }
  return out;
}

const DIAL_HTML = `
  <div class="compass-view compass-no-reading">
    <h2 class="visually-hidden">Compass</h2>
    <svg class="compass-dial" viewBox="-100 -100 200 200" aria-hidden="true">
      <circle class="compass-bezel" r="92"/>
      <g class="compass-card">
        ${ticks()}
        ${labels()}
        <g class="compass-true-north" style="display: none">
          <path d="M0 -92 L5 -100 L-5 -100 Z"/>
        </g>
        <path class="compass-needle-north" d="M0 -44 L7 0 L-7 0 Z"/>
        <path class="compass-needle-south" d="M0 44 L7 0 L-7 0 Z"/>
      </g>
      <path class="compass-lubber" d="M0 -86 L0 -100"/>
    </svg>
    <p class="compass-heading" aria-live="off">
      <span class="compass-heading-value readout">—</span>
      <span class="compass-heading-point"></span>
    </p>
    <dl class="compass-figures">
      <div><dt>True</dt><dd class="compass-true readout">—</dd></div>
      <div><dt class="compass-grid-name">Grid</dt><dd class="compass-grid readout">—</dd></div>
      <div class="compass-accuracy-row" hidden><dt>Accuracy</dt><dd class="compass-accuracy readout"></dd></div>
    </dl>
    <p class="compass-status sheet-note" role="status"></p>
  </div>
`;
