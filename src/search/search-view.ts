import type { Map as MLMap } from 'maplibre-gl';
import { formatElevation } from '../overlays/peaks';
import { compassBearing, distanceMetres, formatDistance } from '../routes/geo';
import type { StatusCentre } from '../ui/status';
import { parseLatLng } from './coords';
import { PlacesSearch, type SearchResult } from './search';

// The search box in the sheet's peek row (C9: local FTS5, no geocoding API).

export interface SearchBoxOptions {
  /** Wraps the input and results; a click outside it closes the results. */
  container: HTMLElement;
  input: HTMLInputElement;
  results: HTMLUListElement;
  map: MLMap;
  status: Pick<StatusCentre, 'toast'>;
  /** A typed-in coordinate pair was chosen. */
  onCoordinates: (coords: { lat: number; lng: number }) => void;
}

export class SearchBox {
  private readonly input: HTMLInputElement;
  private readonly results: HTMLUListElement;
  private readonly map: MLMap;
  private readonly status: Pick<StatusCentre, 'toast'>;
  private readonly onCoordinates: (coords: { lat: number; lng: number }) => void;
  private readonly search = new PlacesSearch();
  private seq = 0;

  /**
   * Arrow-key navigation through search results (plans/desktop-ux-review.md A2).
   *
   * Focus stays in the input rather than moving into the list — this is search-as-you-type,
   * so a keystroke has to keep filtering results whether or not one is highlighted. -1 means
   * nothing is highlighted, which is also the state every fresh render starts from: indices
   * from the previous result set don't mean anything once the list has been rebuilt.
   */
  private highlighted = -1;

  constructor(options: SearchBoxOptions) {
    this.input = options.input;
    this.results = options.results;
    this.map = options.map;
    this.status = options.status;
    this.onCoordinates = options.onCoordinates;

    this.input.addEventListener('input', () => {
      void this.run(this.input.value);
    });

    this.input.addEventListener('keydown', (event) => this.onKeydown(event));

    // Load the index on first focus rather than at startup: it pulls the SQLite runtime plus
    // the index, and the map should render first.
    this.input.addEventListener('focus', () => {
      void this.search.load().catch((err: Error) => {
        this.status.toast(`Search is unavailable: ${err.message}`, { kind: 'warn' });
      });
    });

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Node)) return;
      if (!options.container.contains(event.target)) this.hideResults();
    });
  }

  resultsOpen(): boolean {
    return !this.results.hidden;
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  hideResults(): void {
    this.results.hidden = true;
    this.results.innerHTML = '';
    this.highlighted = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  /**
   * After a result is chosen: put the phone keyboard away, but only for a tap.
   *
   * `blur()` is what dismisses an on-screen keyboard that would otherwise cover the map
   * the result just moved. Done unconditionally, it also dropped a keyboard user's focus
   * to <body> — back to the start of the page — after every Enter. A result chosen with
   * Enter is `.click()`ed from the keydown handler, which dispatches with `detail` 0; a
   * real tap or click counts at least 1.
   */
  private releaseInput(event: MouseEvent): void {
    if (event.detail > 0) this.input.blur();
  }

  private resultButtons(): HTMLButtonElement[] {
    return Array.from(this.results.querySelectorAll<HTMLButtonElement>('li > button'));
  }

  private highlight(index: number): void {
    const buttons = this.resultButtons();
    this.highlighted = buttons.length === 0 ? -1 : Math.max(0, Math.min(index, buttons.length - 1));

    buttons.forEach((button, i) => {
      const active = i === this.highlighted;
      button.classList.toggle('result-active', active);
      button.setAttribute('aria-selected', String(active));
      if (active) button.scrollIntoView({ block: 'nearest' });
    });

    if (this.highlighted === -1) this.input.removeAttribute('aria-activedescendant');
    else this.input.setAttribute('aria-activedescendant', buttons[this.highlighted].id);
  }

  private onKeydown(event: KeyboardEvent): void {
    if (this.results.hidden) return;
    const buttons = this.resultButtons();
    if (buttons.length === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.highlight(this.highlighted + 1 >= buttons.length ? 0 : this.highlighted + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.highlight(this.highlighted <= 0 ? buttons.length - 1 : this.highlighted - 1);
        return;
      case 'Enter':
        // Only when a result is actually highlighted — otherwise Enter falls through to
        // whatever a plain `type="search"` input already does with it (nothing here), not a
        // click on a result the user never selected.
        if (this.highlighted === -1) return;
        event.preventDefault();
        buttons[this.highlighted].click();
        return;
      default:
        return;
    }
  }

  private async run(query: string): Promise<void> {
    const seq = ++this.seq;

    if (query.trim().length < 2) {
      this.hideResults();
      return;
    }

    // A pasted coordinate pair is never also a place name, and needs neither the FTS index
    // nor it being loaded — check for one first so it works even before search.load() has
    // settled, or if it never does.
    const coords = parseLatLng(query);
    if (coords) {
      this.renderCoordsResult(coords);
      return;
    }

    try {
      await this.search.load();
    } catch (err) {
      this.status.toast(`Search is unavailable: ${(err as Error).message}`, { kind: 'warn' });
      return;
    }

    // A slower earlier keystroke must not overwrite a newer result set.
    if (seq !== this.seq) return;

    const centre = this.map.getCenter();
    const results = this.search.search(query, { lat: centre.lat, lon: centre.lng });
    this.renderResults(results);
  }

  /**
   * Clears the results list for a fresh render.
   *
   * Also drops the keyboard highlight: indices from the previous result set don't refer to
   * anything once the list is rebuilt, and leaving `aria-activedescendant` pointing at a
   * removed element would announce nothing to a screen reader.
   */
  private beginRender(): void {
    this.results.innerHTML = '';
    this.highlighted = -1;
    this.input.removeAttribute('aria-activedescendant');
  }

  private showResults(): void {
    this.results.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  /** A typed-in coordinate pair, offered as the one search result it is. */
  private renderCoordsResult(coords: { lat: number; lng: number }): void {
    this.beginRender();

    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'search-result-0';
    button.setAttribute('role', 'option');

    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;

    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent = 'Coordinates';

    button.append(name, meta);
    button.addEventListener('click', (event) => {
      this.map.easeTo({ center: [coords.lng, coords.lat], zoom: Math.max(this.map.getZoom(), 11) });
      this.hideResults();
      this.releaseInput(event);
      this.onCoordinates(coords);
    });

    item.append(button);
    this.results.append(item);
    this.showResults();
  }

  private renderResults(results: SearchResult[]): void {
    this.beginRender();

    if (results.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'search-empty';
      empty.textContent = 'No matches';
      this.results.append(empty);
      this.showResults();
      return;
    }

    results.forEach((result, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `search-result-${index}`;
      button.setAttribute('role', 'option');

      // textContent throughout — these names come from OSM, which is user-editable.
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = result.name;

      const meta = document.createElement('span');
      meta.className = 'result-meta';
      // Distance and direction, not just kind and height. The query already ranks by
      // distance from the viewport centre, but showing only "peak · 1174 m" hid that
      // ranking entirely — and Scotland has several Ben Mores, rendered as identical rows.
      const centre = this.map.getCenter();
      const from: [number, number] = [centre.lng, centre.lat];
      const to: [number, number] = [result.lon, result.lat];
      const parts = [result.kind];
      const ele = formatElevation(result.ele);
      if (ele) parts.push(ele);
      parts.push(`${formatDistance(distanceMetres(from, to))} ${compassBearing(from, to)}`);
      meta.textContent = parts.join(' · ');

      button.append(name, meta);
      button.addEventListener('click', (event) => {
        this.map.easeTo({ center: [result.lon, result.lat], zoom: Math.max(this.map.getZoom(), 11) });
        this.hideResults();
        this.releaseInput(event);
      });

      item.append(button);
      this.results.append(item);
    });

    this.showResults();
  }
}
