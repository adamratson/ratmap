import type { Map as MLMap } from 'maplibre-gl';
import { formatElevation } from '../overlays/peaks';
import type { StatusCentre } from '../ui/status';
import { deletePlace, listPlaces, savePlace, type SavedPlace } from './saved-places';

// The Saved view: every saved place, to fly to or delete.

export interface PlacesViewDeps {
  map: MLMap;
  status: Pick<StatusCentre, 'toast'>;
  /** Called after flying to a place. */
  onGoTo: () => void;
}

export async function renderPlacesSheet(body: HTMLElement, deps: PlacesViewDeps): Promise<void> {
  const { map, status } = deps;

  let places: SavedPlace[];
  try {
    places = await listPlaces();
  } catch (err) {
    status.toast(`Could not open saved places: ${(err as Error).message}`, { kind: 'error' });
    return;
  }

  body.innerHTML = `
    <ul class="places-list"></ul>
  `;

  const list = body.querySelector<HTMLUListElement>('.places-list')!;
  if (places.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'places-empty';
    empty.textContent = 'No saved places yet — tap a summit and choose “Save place”.';
    list.append(empty);
  }

  for (const place of places) {
    const item = document.createElement('li');

    const goto = document.createElement('button');
    goto.type = 'button';
    goto.className = 'place-goto';
    const ele = formatElevation(place.ele);
    goto.textContent = ele ? `${place.name} · ${ele}` : place.name;
    goto.addEventListener('click', () => {
      map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 10) });
      // Out of the way, but still one drag from the list — going to a place is usually
      // the first of several.
      deps.onGoTo();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'place-delete';
    remove.setAttribute('aria-label', `Delete ${place.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      // Deleted immediately, with a way back — rather than a confirmation dialog in front
      // of every delete. savePlace takes an explicit id and savedAt, so undo restores the
      // same record rather than a copy of it.
      void deletePlace(place.id).then(
        () => {
          void renderPlacesSheet(body, deps);
          status.toast(`Deleted “${place.name}”`, {
            action: {
              label: 'Undo',
              onSelect: () =>
                void savePlace(place).then(
                  () => void renderPlacesSheet(body, deps),
                  // An Undo that fails quietly is worse than none: the place is gone, and
                  // the person who pressed it believes it is back.
                  (err: Error) =>
                    status.toast(`Could not restore “${place.name}”: ${err.message}`, { kind: 'error' }),
                ),
            },
          });
        },
        (err: Error) =>
          status.toast(`Could not delete “${place.name}”: ${err.message}`, { kind: 'error' }),
      );
    });

    item.append(goto, remove);
    list.append(item);
  }
}
