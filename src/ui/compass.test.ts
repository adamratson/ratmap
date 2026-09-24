import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { setUpCompass } from './compass';

function fakeMap() {
  const handlers: Record<string, () => void> = {};
  const view = { bearing: 0, pitch: 0 };
  return {
    view,
    fire: (event: string) => handlers[event]?.(),
    on: (event: string, handler: () => void) => void (handlers[event] = handler),
    getBearing: () => view.bearing,
    getPitch: () => view.pitch,
    easeTo: vi.fn(),
  };
}

describe('the compass button', () => {
  let map: ReturnType<typeof fakeMap>;
  let button: HTMLButtonElement;

  beforeEach(() => {
    map = fakeMap();
    button = document.createElement('button');
    button.innerHTML = '<span class="compass-needle"></span>';
    setUpCompass(map as unknown as MLMap, button);
  });

  it('is hidden while the map is north-up and flat — there is nothing to undo', () => {
    expect(button.hidden).toBe(true);
  });

  it('appears once the map is rotated, with the needle pointing north', () => {
    map.view.bearing = 30;
    map.fire('rotate');

    expect(button.hidden).toBe(false);
    expect(button.querySelector<HTMLElement>('.compass-needle')!.style.transform).toBe('rotate(-30deg)');
  });

  it('appears once the map is tilted, even facing north', () => {
    map.view.pitch = 40;
    map.fire('pitch');

    expect(button.hidden).toBe(false);
  });

  it('ignores a rotation too small to see', () => {
    map.view.bearing = 0.5;
    map.fire('rotate');

    expect(button.hidden).toBe(true);
  });

  it('puts north back and flattens the map', () => {
    button.click();

    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0, pitch: 0 }));
  });
});
