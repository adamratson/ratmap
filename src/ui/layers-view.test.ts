import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import { LAYER_GROUP_ORDER } from '../map/layers';
import { renderLayersView } from './layers-view';

const store = new Map<string, string>();

function fakeMap(ids: string[]) {
  const visibility = new Map<string, string>();
  return {
    visibility,
    getLayersOrder: () => [...ids],
    setLayoutProperty: vi.fn((id: string, _name: string, value: string) => void visibility.set(id, value)),
  };
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(map = fakeMap([])) {
  const body = document.createElement('div');
  renderLayersView(body, { map: map as unknown as MLMap, ink: mapInk('dark') });
  return body;
}

const input = (body: HTMLElement, group: string) =>
  body.querySelector<HTMLInputElement>(`#layer-toggle-${group}`)!;

describe('the Layers view', () => {
  it('has one switch per overlay, in order', () => {
    const groups = [...render().querySelectorAll<HTMLInputElement>('input[data-group]')].map(
      (el) => el.dataset.group,
    );
    expect(groups).toEqual([...LAYER_GROUP_ORDER]);
  });

  it('puts each switch inside its label, so the whole row is the tap target and names it', () => {
    const body = render();
    for (const group of LAYER_GROUP_ORDER) {
      expect(input(body, group).closest('label')!.querySelector('.legend-row-label')!.textContent).toBeTruthy();
    }
  });

  it('shows everything on except avalanche terrain, by default', () => {
    const body = render();
    for (const group of LAYER_GROUP_ORDER) {
      expect(input(body, group).checked).toBe(group !== 'avalanche');
    }
  });

  it('switches the group’s layers on the map and remembers it', () => {
    const map = fakeMap(['region-a-contours-lines', 'region-a-contours-labels', 'hillshade']);
    const body = render(map);

    const contours = input(body, 'contours');
    contours.checked = false;
    contours.dispatchEvent(new Event('change'));

    expect(map.visibility.get('region-a-contours-lines')).toBe('none');
    expect(map.visibility.get('region-a-contours-labels')).toBe('none');
    expect(map.visibility.has('hillshade')).toBe(false);
    // Next time the view opens, it says so.
    expect(input(render(), 'contours').checked).toBe(false);
  });

  it('draws its swatches in the map’s own inks', () => {
    const ink = mapInk('dark');
    expect(render().innerHTML).toContain(ink.peakDot);
    expect(render().innerHTML).toContain(ink.contour);
  });
});
