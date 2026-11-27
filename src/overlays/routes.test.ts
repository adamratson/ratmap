import { describe, expect, it, vi } from 'vitest';
import type { Map as MLMap } from 'maplibre-gl';
import { mapInk } from '../map/flavor';
import { SAC_BAND_WIDTH } from './sac';
import { layoutValue, paintValue, styleColor } from '../test-support/paint-value';
import { featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  addRoutesLayers,
  ROUTES_LEGEND,
  routeSwatch,
  routesLabelLayerId,
  routesLineLayerId,
  routesPathLayerId,
} from './routes';

const SOURCE = 'regions-z8-15-routes';

function layersFor(minzoom = 0, theme: 'light' | 'dark' = 'light') {
  const added: Array<{ layer: Record<string, any>; before?: string }> = [];
  const map = { addLayer: vi.fn((layer: Record<string, unknown>, before?: string) => added.push({ layer, before })) } as unknown as MLMap;
  addRoutesLayers(map, SOURCE, {
    minzoom,
    ink: mapInk(theme),
    beforeLine: 'ground',
    beforePath: 'roads',
    beforeLabels: 'first-label',
  });
  return added;
}

const layer = (id: string, minzoom = 0, theme: 'light' | 'dark' = 'light') =>
  layersFor(minzoom, theme).find((a) => a.layer.id === id)!;

/** Whether a layer's filter keeps a route on this network. */
const keeps = (layer: Record<string, any>, props: Record<string, unknown>) =>
  layer.filter === undefined ||
  featureFilter(layer.filter as FilterSpecification).filter({ zoom: 11 }, { type: 2, properties: props } as never);

const INTERNATIONAL = { network: 'iwn', name: 'E4' };
const NATIONAL = { network: 'nwn', name: 'West Highland Way' };
const REGIONAL = { network: 'rwn', name: 'Affric Kintail Way' };
const LOCAL = { network: 'lwn', name: 'Grosse Scheidegg - Schreckfeld' };

describe('the route layers', () => {
  it('are the tint, the paths and the names, each before its own anchor, and nothing else', () => {
    expect(layersFor().map((a) => [a.layer.id, a.before])).toEqual([
      [routesLineLayerId(SOURCE), 'ground'],
      [routesPathLayerId(SOURCE), 'roads'],
      [routesLabelLayerId(SOURCE), 'first-label'],
    ]);
  });

  it('draw no icons: a route is told by its tint and its name', () => {
    expect(layersFor().filter((a) => a.layer.layout?.['icon-image'] !== undefined)).toEqual([]);
  });
});

describe('the route tint', () => {
  const { layer: line } = layer(routesLineLayerId(SOURCE));
  const width = (zoom: number, props: Record<string, unknown>) =>
    paintValue('line', 'line-width', line.paint['line-width'], zoom, props) as number;
  const color = (zoom: number, props: Record<string, unknown>) =>
    paintValue('line', 'line-color', line.paint['line-color'], zoom, props);

  it('starts at z12, where the paths do: below it every path drawn is a route', () => {
    expect(line).toMatchObject({ type: 'line', 'source-layer': 'routes', minzoom: 12 });
    expect(layer(routesLineLayerId(SOURCE), 13).layer.minzoom).toBe(13);
  });

  it('tints every route, the same at every level above local', () => {
    for (const props of [INTERNATIONAL, NATIONAL, REGIONAL, LOCAL]) expect(keeps(line, props)).toBe(true);
    const ink = mapInk('light');
    for (const props of [INTERNATIONAL, NATIONAL, REGIONAL]) {
      expect(color(13, props)).toEqual(styleColor(ink.walkRouteTint[0]));
      expect(width(13, props)).toBe(width(13, LOCAL));
    }
  });

  it('tints local routes fainter, and under the rest, so a longer route can be followed through them', () => {
    const ink = mapInk('light');
    expect(color(13, LOCAL)).toEqual(styleColor(ink.walkRouteTint[1]));
    const key = (props: Record<string, unknown>) =>
      layoutValue('line', 'line-sort-key', line.layout['line-sort-key'], 13, props) as number;
    expect(key(NATIONAL)).toBeGreaterThan(key(LOCAL));
    expect(key(REGIONAL)).toBeGreaterThan(key(LOCAL));
  });

  it('is wider than the grade band, so both show round a graded path', () => {
    expect(width(12, LOCAL)).toBeGreaterThan(SAC_BAND_WIDTH[0]);
    expect(width(16, LOCAL)).toBeGreaterThan(SAC_BAND_WIDTH[1]);
  });

  it('is opaque, so crowded joins do not build up into dark marks', () => {
    expect(line.paint['line-opacity']).toBeUndefined();
  });
});

describe('the routes drawn as paths', () => {
  const { layer: path } = layer(routesPathLayerId(SOURCE));

  it('draw national and regional routes at z10-11, before the paths archive starts', () => {
    expect(path).toMatchObject({ type: 'line', 'source-layer': 'routes', minzoom: 10, maxzoom: 12 });
    for (const props of [INTERNATIONAL, NATIONAL, REGIONAL]) expect(keeps(path, props)).toBe(true);
    // Local routes come in at z12 with the rest of the network.
    expect(keeps(path, LOCAL)).toBe(false);
  });

  it('look like the paths they hand over to: the path ink, dashed, with no casing below z14', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(layer(routesPathLayerId(SOURCE), 0, theme).layer.paint['line-color']).toBe(mapInk(theme).pathLine);
    }
    expect(layersFor().some((a) => /casing/.test(a.layer.id))).toBe(false);
    expect(path.paint['line-dasharray']).toEqual([2.5, 1.5]);
    // A footpath is 1 px at z12 (addPathLayers, src/regions/region-layers.ts).
    expect(paintValue('line', 'line-width', path.paint['line-width'], 11.99, {})).toBeCloseTo(1, 1);
    expect(paintValue('line', 'line-width', path.paint['line-width'], 10, {})).toBeLessThan(1);
  });
});

describe('the route names', () => {
  const { layer: labels, before } = layer(routesLabelLayerId(SOURCE));
  const text = (zoom: number, props: Record<string, unknown>) =>
    String(layoutValue('symbol', 'text-field', labels.layout['text-field'], zoom, props) ?? '');

  it('writes along the line, with the region’s other labels', () => {
    expect(labels).toMatchObject({ type: 'symbol', minzoom: 11 });
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

  it('places national and regional names before local ones where they collide', () => {
    const key = (props: Record<string, unknown>) =>
      layoutValue('symbol', 'symbol-sort-key', labels.layout['symbol-sort-key'], 14, props) as number;
    expect(key(NATIONAL)).toBe(key(REGIONAL));
    expect(key(REGIONAL)).toBeLessThan(key(LOCAL));
  });

  it('is drawn in the route ink, haloed like the other map text', () => {
    const ink = mapInk('light');
    expect(labels.paint['text-color']).toBe(ink.walkRouteText);
    expect(labels.paint['text-halo-color']).toBe(ink.labelHalo);
  });
});

describe('routeSwatch', () => {
  it('has a legend entry per tint: a path in the stronger one, a path in the fainter one', () => {
    expect(ROUTES_LEGEND.map((e) => e.tier)).toEqual(['main', 'local']);
    for (const theme of ['light', 'dark'] as const) {
      const ink = mapInk(theme);
      expect(routeSwatch('main', ink)).toContain(ink.walkRouteTint[0]);
      expect(routeSwatch('local', ink)).toContain(ink.walkRouteTint[1]);
      for (const entry of ROUTES_LEGEND) {
        expect(routeSwatch(entry.tier, ink)).toContain(ink.pathLine);
        expect(routeSwatch(entry.tier, ink)).not.toContain('<polygon');
      }
    }
  });

  it('names its layers after the source, so the Layers toggle finds them', () => {
    expect(routesLineLayerId(SOURCE)).toMatch(/-routes-line$/);
    expect(routesPathLayerId(SOURCE)).toMatch(/-routes-path$/);
    expect(routesLabelLayerId(SOURCE)).toMatch(/-routes-labels$/);
  });
});
