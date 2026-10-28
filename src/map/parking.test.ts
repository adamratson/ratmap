import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from './flavor';
import { layoutValue } from '../test-support/paint-value';
import { parkingIconId, parkingImage, parkingLayer, supplyParkingIcons } from './parking';

/** The [r, g, b, a] of one pixel. */
function pixel(image: ReturnType<typeof parkingImage>, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return Array.from(image.data.slice(at, at + 4));
}

describe('parkingImage', () => {
  const ink = mapInk('light');
  const image = parkingImage(ink);

  it('is a 16 px sign at 2x', () => {
    expect([image.width, image.height]).toEqual([32, 32]);
    expect(image.data).toHaveLength(32 * 32 * 4);
  });

  it('draws a white P on the blue field, ringed in the rim ink', () => {
    expect(pixel(image, 12, 20)).toEqual([255, 255, 255, 255]); // the stem
    expect(pixel(image, 21, 12)).toEqual([255, 255, 255, 255]); // the bowl's right side
    expect(pixel(image, 20, 22)).toEqual([0x1f, 0x5c, 0xa8, 255]); // field, under the bowl
    expect(pixel(image, 16, 0)).toEqual([255, 255, 255, 255]); // rim, top edge
  });

  it('leaves the rounded corners transparent', () => {
    expect(pixel(image, 0, 0)[3]).toBe(0);
    expect(pixel(image, 31, 31)[3]).toBe(0);
  });

  it('rims the night sign in graphite, not white', () => {
    expect(pixel(parkingImage(mapInk('dark')), 16, 0)).toEqual([0x0e, 0x11, 0x14, 255]);
  });
});

describe('supplyParkingIcons', () => {
  function fakeMap() {
    const handlers: Array<(event: { id: string }) => void> = [];
    const images = new Map<string, unknown>();
    const map = {
      on: vi.fn((_: string, handler: (event: { id: string }) => void) => handlers.push(handler)),
      hasImage: vi.fn((id: string) => images.has(id)),
      addImage: vi.fn((id: string, image: unknown) => images.set(id, image)),
    } as unknown as MLMap;
    return { map, images, fire: (id: string) => handlers.forEach((h) => h({ id })) };
  }

  it('answers a missing parking sign for either theme', () => {
    const { map, images, fire } = fakeMap();
    supplyParkingIcons(map);
    expect(map.on).toHaveBeenCalledWith('styleimagemissing', expect.any(Function));

    fire(parkingIconId('light'));
    fire(parkingIconId('dark'));
    expect([...images.keys()]).toEqual([parkingIconId('light'), parkingIconId('dark')]);
  });

  it('leaves every other missing image alone', () => {
    const { map, images, fire } = fakeMap();
    supplyParkingIcons(map);
    fire('cafe');
    expect(images.size).toBe(0);
  });
});

describe('parkingLayer', () => {
  it('draws every car park in its own artifact from z13, however low the region allows', () => {
    const layer = parkingLayer('regions-z13-15-parking', 'light', 0);
    expect(layer).toMatchObject({
      id: 'regions-z13-15-parking-symbols',
      type: 'symbol',
      source: 'regions-z13-15-parking',
      'source-layer': 'parking',
      minzoom: 13,
    });
    // The artifact holds only car parks a walker can use; nothing is left to filter.
    expect(layer.filter).toBeUndefined();
    expect(parkingLayer('s', 'light', 14).minzoom).toBe(14);
  });

  it('places named before unnamed, public before customers-only, larger before smaller', () => {
    const sortKey = (props: Record<string, unknown>) =>
      layoutValue('symbol', 'symbol-sort-key', parkingLayer('s', 'light', 13).layout!['symbol-sort-key'], 15, props) as number;
    const order = [
      { name: 'Seathwaite', size: 5000 },
      { name: 'Seathwaite layby', size: 0 },
      { name: 'Old Dungeon Ghyll', customers: 1, size: 9000 },
      { size: 20000 },
      { size: 90 },
      { customers: 1, size: 50000 },
      { customers: 1, size: 0 },
    ].map(sortKey);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('uses the sign drawn for its own theme', () => {
    expect(parkingLayer('s', 'dark', 13).layout).toMatchObject({ 'icon-image': parkingIconId('dark') });
  });

  it('keeps the sign when its name has no room', () => {
    expect(parkingLayer('s', 'light', 13).layout).toMatchObject({ 'text-optional': true });
  });
});
