import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk, ratmapFlavor } from '../map/flavor';
import { contrast, layoutValue, paintValue, styleColor } from '../test-support/paint-value';
import { featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  addRoutesLayers,
  ROUTES_LEGEND,
  routeSwatch,
  routesDiamondLayerId,
  routesLabelLayerId,
  routesLineLayerId,
} from './routes';

const images = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();

function layersFor(minzoom = 0, theme: 'light' | 'dark' = 'light') {
  const added: Array<{ layer: Record<string, any>; before?: string }> = [];
  const map = {
    addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })),
    hasImage: (id: string) => images.has(id),
    addImage: (id: string, image: { width: number; height: number; data: Uint8ClampedArray }) => images.set(id, image),
  } as unknown as MLMap;
  addRoutesLayers(map, 'regions-z8-15-routes', {
    minzoom,
    ink: mapInk(theme),
    beforeLine: 'casing',
    beforeLabels: 'first-label',
  });
  return added;
}

/** Whether a layer's filter keeps a route on this network. */
const keeps = (layer: Record<string, any>, props: Record<string, unknown>) =>
  featureFilter(layer.filter as FilterSpecification).filter({ zoom: 13 }, { type: 2, properties: props } as never);

const NATIONAL = { network: 'nwn', name: 'West Highland Way' };
const REGIONAL = { network: 'rwn', name: 'Affric Kintail Way' };
const LOCAL = { network: 'lwn', name: 'Grosse Scheidegg - Schreckfeld' };

describe('the route line', () => {
  const [{ layer: line, before }] = layersFor();
  const width = (zoom: number, props: Record<string, unknown>) =>
    paintValue('line', 'line-width', line.paint['line-width'], zoom, props) as number;
  const color = (zoom: number, props: Record<string, unknown>) =>
    paintValue('line', 'line-color', line.paint['line-color'], zoom, props);
  it('reads the routes archive from z8, before the anchor it is given', () => {
    expect(line).toMatchObject({ id: 'regions-z8-15-routes-line', type: 'line', 'source-layer': 'routes', minzoom: 8 });
    expect(before).toBe('casing');
    expect(layersFor(10)[0]!.layer.minzoom).toBe(10);
  });

  it('draws regional and local routes, and leaves national ones to the diamonds', () => {
    expect(keeps(line, REGIONAL)).toBe(true);
    expect(keeps(line, LOCAL)).toBe(true);
    expect(keeps(line, NATIONAL)).toBe(false);
    expect(keeps(line, { network: 'iwn' })).toBe(false);
  });

  it('is a line in the route ink below z12, and its tier’s tint, wider than the grade band, from z12', () => {
    const ink = mapInk('light');
    expect(color(11, REGIONAL)).toEqual(styleColor(ink.walkRoute));
    expect(width(11, REGIONAL)).toBeLessThan(3);
    expect([color(12, REGIONAL), color(12, LOCAL)]).toEqual(ink.walkRouteTint.map(styleColor));
    // The SAC band is 4 px at z12 and 12 px at z16 (src/overlays/sac.ts).
    expect(width(12, LOCAL)).toBeGreaterThan(4);
    expect(width(16, LOCAL)).toBeGreaterThan(12);
  });

  it('is opaque, so crowded joins do not build up into dark marks', () => {
    expect(line.paint['line-opacity']).toBeUndefined();
  });

  it('draws regional routes heavier than local ones, and over them where they share a path', () => {
    for (const zoom of [9, 13, 16]) expect(width(zoom, REGIONAL)).toBeGreaterThan(width(zoom, LOCAL));
    const key = (props: Record<string, unknown>) =>
      layoutValue('line', 'line-sort-key', line.layout['line-sort-key'], 13, props) as number;
    expect(key(REGIONAL)).toBeGreaterThan(key(LOCAL));
  });
});

describe('the national route diamonds', () => {
  const added = layersFor();
  const { layer: diamonds, before } = added[1]!;

  it('marks national and international routes only, from z8', () => {
    expect(diamonds).toMatchObject({
      id: routesDiamondLayerId('regions-z8-15-routes'),
      type: 'symbol',
      'source-layer': 'routes',
      minzoom: 8,
    });
    expect(keeps(diamonds, NATIONAL)).toBe(true);
    expect(keeps(diamonds, { network: 'iwn' })).toBe(true);
    expect(keeps(diamonds, REGIONAL)).toBe(false);
    expect(keeps(diamonds, LOCAL)).toBe(false);
  });

  it('runs a chain of them along the path, upright, and over every line', () => {
    expect(diamonds.layout['symbol-placement']).toBe('line');
    // Turned with the path, a diamond on a diagonal stretch is a square.
    expect(diamonds.layout['icon-rotation-alignment']).toBe('viewport');
    // Above the paths: with the labels' anchor, not the corridor's.
    expect(before).toBe('first-label');
    expect(added.map((a) => a.layer.id)).toEqual([
      routesLineLayerId('regions-z8-15-routes'),
      routesDiamondLayerId('regions-z8-15-routes'),
      routesLabelLayerId('regions-z8-15-routes'),
    ]);
    // A chain, not scattered marks: spaced a few diamonds' widths apart at most.
    for (const zoom of [8, 12, 16]) {
      const spacing = layoutValue('symbol', 'symbol-spacing', diamonds.layout['symbol-spacing'], zoom) as number;
      const size = layoutValue('symbol', 'icon-size', diamonds.layout['icon-size'], zoom) as number;
      expect(spacing / (14 * size)).toBeLessThan(2.5);
    }
  });

  it('takes no label’s place', () => {
    expect(diamonds.layout['icon-allow-overlap']).toBe(true);
    expect(diamonds.layout['icon-ignore-placement']).toBe(true);
  });

  it('is drawn in the national route ink, rimmed, in each theme', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ink = mapInk(theme);
      const id = layersFor(0, theme)[1]!.layer.layout['icon-image'];
      expect(id).toContain(ink.walkNational.slice(1));
      const image = images.get(id)!;
      // The middle pixel is the glyph colour; a corner is clear.
      const at = ((image.height / 2) * image.width + image.width / 2) * 4;
      expect(Array.from(image.data.slice(at, at + 3))).toEqual([
        parseInt(ink.walkNational.slice(1, 3), 16),
        parseInt(ink.walkNational.slice(3, 5), 16),
        parseInt(ink.walkNational.slice(5, 7), 16),
      ]);
      expect(image.data[3]).toBe(0);
      expect(contrast(ink.walkNational, theme === 'light' ? '#ffffff' : '#0e1114')).toBeGreaterThanOrEqual(3);
      // On every ground, dense woodland included: OS green was 2.6:1 there, in the wood's
      // own hue.
      const flavor = ratmapFlavor(theme) as unknown as Record<string, string>;
      for (const ground of ['earth', 'park_b', 'wood_b', 'scrub_b', 'sand', 'glacier']) {
        expect([ground, contrast(ink.walkNational, flavor[ground]) >= 4.5]).toEqual([ground, true]);
      }
    }
  });
});

describe('the route names', () => {
  const [, , { layer: labels, before }] = layersFor();
  const text = (zoom: number, props: Record<string, unknown>) =>
    String(layoutValue('symbol', 'text-field', labels.layout['text-field'], zoom, props) ?? '');

  it('writes along the line, with the region’s other labels', () => {
    expect(labels).toMatchObject({ id: routesLabelLayerId('regions-z8-15-routes'), type: 'symbol', minzoom: 11 });
    expect(labels.layout['symbol-placement']).toBe('line');
    expect(labels.filter).toEqual(['has', 'name']);
    expect(before).toBe('first-label');
  });

  it('names national and regional routes from z11, local ones from z14', () => {
    expect(text(11, NATIONAL)).toBe('West Highland Way');
    expect(text(11, REGIONAL)).toBe('Affric Kintail Way');
    expect(text(13, LOCAL)).toBe('');
    expect(text(14, LOCAL)).toBe('Grosse Scheidegg - Schreckfeld');
  });

  it('places national names before regional, regional before local', () => {
    const key = (props: Record<string, unknown>) =>
      layoutValue('symbol', 'symbol-sort-key', labels.layout['symbol-sort-key'], 14, props) as number;
    expect(key(NATIONAL)).toBeLessThan(key(REGIONAL));
    expect(key(REGIONAL)).toBeLessThan(key(LOCAL));
  });

  it('is drawn in the route ink, haloed like the other map text', () => {
    const ink = mapInk('light');
    expect(labels.paint['text-color']).toBe(ink.walkRouteText);
    expect(labels.paint['text-halo-color']).toBe(ink.labelHalo);
  });
});

describe('routeSwatch', () => {
  it('has a legend entry per tier: diamonds along a path for national, a tint round one for the others', () => {
    expect(ROUTES_LEGEND.map((e) => e.tier)).toEqual(['national', 'regional', 'local']);
    for (const theme of ['light', 'dark'] as const) {
      const ink = mapInk(theme);
      const national = routeSwatch('national', ink);
      expect(national).toContain(ink.walkNational);
      expect(national.match(/<polygon/g)).toHaveLength(3);
      expect(routeSwatch('regional', ink)).toContain(ink.walkRouteTint[0]);
      expect(routeSwatch('local', ink)).toContain(ink.walkRouteTint[1]);
      for (const entry of ROUTES_LEGEND) expect(routeSwatch(entry.tier, ink)).toContain(ink.pathLine);
    }
  });

  it('names its layers after the source, so the Layers toggle finds them', () => {
    expect(routesLineLayerId('regions-z8-15-routes')).toMatch(/-routes-line$/);
    expect(routesLabelLayerId('regions-z8-15-routes')).toMatch(/-routes-labels$/);
  });
});
