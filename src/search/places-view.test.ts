import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import type { SavedPlace } from './saved-places';
import type { StatusCentre } from '../ui/status';

const places = vi.hoisted(() => ({
  list: [] as SavedPlace[],
  listPlaces: vi.fn(),
  deletePlace: vi.fn(),
  savePlace: vi.fn(),
}));
vi.mock('./saved-places', () => ({
  listPlaces: places.listPlaces,
  deletePlace: places.deletePlace,
  savePlace: places.savePlace,
}));

const { renderPlacesSheet } = await import('./places-view');

const BEN: SavedPlace = { id: 'a', name: 'Ben Nevis', lng: -5, lat: 56.8, ele: 1345, savedAt: 2 };
const HUT: SavedPlace = { id: 'b', name: 'CIC Hut', lng: -5.01, lat: 56.81, savedAt: 1 };

let body: HTMLElement;
let map: { easeTo: Mock; getZoom: () => number };
let status: { toast: Mock<StatusCentre['toast']> };
let onGoTo: Mock<() => void>;

const render = () => renderPlacesSheet(body, { map: map as unknown as MLMap, status, onGoTo });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  places.list = [BEN, HUT];
  places.listPlaces.mockImplementation(async () => [...places.list]);
  places.deletePlace.mockImplementation(async (id: string) => {
    places.list = places.list.filter((p) => p.id !== id);
  });
  places.savePlace.mockImplementation(async (place: SavedPlace) => {
    places.list = [...places.list, place];
  });
  body = document.createElement('div');
  document.body.append(body);
  map = { easeTo: vi.fn(), getZoom: () => 6 };
  status = { toast: vi.fn() };
  onGoTo = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('the saved places sheet', () => {
  it('lists each place with its height where it has one', async () => {
    await render();

    expect([...body.querySelectorAll('.place-goto')].map((b) => b.textContent)).toEqual([
      'Ben Nevis · 1345 m',
      'CIC Hut',
    ]);
  });

  it('says how to save one when there are none', async () => {
    places.list = [];
    await render();

    expect(body.querySelector('.places-empty')!.textContent).toMatch(/tap a summit/);
  });

  it('flies to a place, close enough to see it, then gets out of the way', async () => {
    await render();
    body.querySelector<HTMLButtonElement>('.place-goto')!.click();

    expect(map.easeTo).toHaveBeenCalledWith({ center: [-5, 56.8], zoom: 10 });
    expect(onGoTo).toHaveBeenCalled();
  });

  it('labels each delete button with the place it deletes', async () => {
    await render();

    expect(
      [...body.querySelectorAll('.place-delete')].map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Delete Ben Nevis', 'Delete CIC Hut']);
  });

  it('deletes at once, with an Undo that restores the same record', async () => {
    await render();
    body.querySelector<HTMLButtonElement>('.place-delete')!.click();
    await flush();

    expect(body.textContent).not.toContain('Ben Nevis');
    const [message, options] = status.toast.mock.calls[0];
    expect(message).toBe('Deleted “Ben Nevis”');
    expect(options?.action?.label).toBe('Undo');

    options!.action!.onSelect();
    await flush();

    expect(places.savePlace).toHaveBeenCalledWith(BEN);
    expect(body.textContent).toContain('Ben Nevis');
  });

  it('reports a store that will not open, rather than showing an empty list', async () => {
    places.listPlaces.mockRejectedValue(new Error('IndexedDB unavailable'));
    await render();

    expect(status.toast).toHaveBeenCalledWith(expect.stringContaining('IndexedDB unavailable'), {
      kind: 'error',
    });
    expect(body.querySelector('.places-empty')).toBeNull();
  });
});
