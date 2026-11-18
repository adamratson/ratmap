import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import { layoutValue, paintValue, styleColor } from '../test-support/paint-value';
import { addRoutesLayers, ROUTES_LEGEND, routeSwatch, routesLabelLayerId, routesLineLayerId } from './routes';

function layersFor(minzoom = 0) {
  const added: Array<{ layer: Record<string, any>; before?: string }> = [];
  const map = {
    addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })),
  } as unknown as MLMap;
  addRoutesLayers(map, 'regions-z8-15-routes', {
    minzoom,
    ink: mapInk('light'),
    beforeLine: 'casing',
    beforeLabels: 'first-label',
  });
  return added;
}

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

  it('is a line in the route ink below z12, and its tier’s tint, wider than the grade band, from z12', () => {
    const ink = mapInk('light');
    expect(color(11, NATIONAL)).toEqual(styleColor(ink.walkRoute));
    expect(width(11, NATIONAL)).toBeLessThan(3);
    expect([color(12, NATIONAL), color(12, REGIONAL), color(12, LOCAL)]).toEqual(ink.walkRouteTint.map(styleColor));
    // The SAC band is 4 px at z12 and 12 px at z16 (src/overlays/sac.ts).
    expect(width(12, LOCAL)).toBeGreaterThan(4);
    expect(width(16, LOCAL)).toBeGreaterThan(12);
  });

  it('is opaque, so crowded joins do not build up into dark marks', () => {
    expect(line.paint['line-opacity']).toBeUndefined();
  });

  it('draws national routes heavier than regional, regional than local', () => {
    for (const zoom of [9, 13, 16]) {
      expect(width(zoom, NATIONAL)).toBeGreaterThan(width(zoom, REGIONAL));
      expect(width(zoom, REGIONAL)).toBeGreaterThan(width(zoom, LOCAL));
    }
  });

  it('counts international routes as national', () => {
    expect(width(14, { network: 'iwn' })).toBe(width(14, NATIONAL));
  });

  it('draws national routes over local ones where they share a path', () => {
    const key = (props: Record<string, unknown>) =>
      layoutValue('line', 'line-sort-key', line.layout['line-sort-key'], 13, props) as number;
    expect(key(NATIONAL)).toBeGreaterThan(key(REGIONAL));
    expect(key(REGIONAL)).toBeGreaterThan(key(LOCAL));
  });
});

describe('the route names', () => {
  const [, { layer: labels, before }] = layersFor();
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
  it('has a legend entry per tier, each its tier’s tint around a path', () => {
    expect(ROUTES_LEGEND.map((e) => e.tier)).toEqual(['national', 'regional', 'local']);
    for (const theme of ['light', 'dark'] as const) {
      const ink = mapInk(theme);
      for (const entry of ROUTES_LEGEND) {
        const svg = routeSwatch(entry.tier, ink);
        expect(svg).toContain(ink.walkRouteTint[ROUTES_LEGEND.indexOf(entry)]);
        expect(svg).toContain(ink.pathLine);
      }
    }
  });

  it('names its layers after the source, so the Layers toggle finds them', () => {
    expect(routesLineLayerId('regions-z8-15-routes')).toMatch(/-routes-line$/);
    expect(routesLabelLayerId('regions-z8-15-routes')).toMatch(/-routes-labels$/);
  });
});
