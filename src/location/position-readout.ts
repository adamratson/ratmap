import type { IControl } from 'maplibre-gl';
import { gridReference } from './grid-ref';
import type { LocationState } from './location';

// Where you are, as you would read it out: a grid reference first — what a paper map, a
// guidebook and a mountain rescue call all use in Britain — then latitude and longitude,
// and how good the fix is.
//
// Only while there is a fix. Before one, or after the location button has been turned off,
// a figure here would be a stale position presented as a current one.
//
// A MapLibre control in the bottom-left corner, so it stacks above the scale bar and rides
// up with the sheet exactly as the scale and attribution do (style.css), rather than
// keeping a second copy of that positioning in step by hand.

export interface PositionReadoutOptions {
  /** The readout was tapped: show this fix's coordinates sheet. */
  onSelect: (lngLat: [number, number]) => void;
}

/** "56.79694, -5.00361": the order and precision every other coordinate in ratmap uses. */
export function formatLatLng(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export class PositionReadout implements IControl {
  private readonly onSelect: (lngLat: [number, number]) => void;
  private container: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private lngLat: [number, number] | null = null;

  constructor({ onSelect }: PositionReadoutOptions) {
    this.onSelect = onSelect;
  }

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl position-readout';
    container.hidden = true;
    container.innerHTML = `
      <button type="button">
        <span class="position-gridref"></span>
        <span class="position-latlng"></span>
      </button>
    `;
    const button = container.querySelector('button')!;
    button.addEventListener('click', () => {
      if (this.lngLat) this.onSelect(this.lngLat);
    });
    this.container = container;
    this.button = button;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.button = null;
  }

  /** Follow the location state: shown while tracking, hidden otherwise. */
  update(state: LocationState): void {
    if (!this.container || !this.button) return;
    if (state.status !== 'tracking') {
      this.container.hidden = true;
      this.lngLat = null;
      return;
    }

    const { longitude: lng, latitude: lat, accuracy } = state.position.coords;
    this.lngLat = [lng, lat];
    const grid = gridReference(lng, lat);
    const latLng = formatLatLng(lng, lat);
    const plusMinus = Number.isFinite(accuracy) && accuracy > 0 ? `±${Math.round(accuracy)} m` : null;

    const gridEl = this.button.querySelector<HTMLElement>('.position-gridref')!;
    gridEl.hidden = grid === null;
    gridEl.textContent = grid?.text ?? '';
    this.button.querySelector<HTMLElement>('.position-latlng')!.textContent =
      plusMinus ? `${latLng}  ${plusMinus}` : latLng;

    this.button.setAttribute(
      'aria-label',
      [
        'Your position',
        grid ? `${grid.system} ${grid.text}` : null,
        latLng,
        plusMinus ? `accurate to ${Math.round(accuracy)} metres` : null,
      ]
        .filter(Boolean)
        .join(', ') + '. Show details',
    );
    this.container.hidden = false;
  }
}
