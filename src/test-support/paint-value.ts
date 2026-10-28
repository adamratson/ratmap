// maplibre-gl's own style-spec package (a dependency of maplibre-gl, not of ratmap): the
// evaluator the renderer runs, so a test reads the value that would actually be drawn.
import { Color, createPropertyExpression, latest } from '@maplibre/maplibre-gl-style-spec';

type LayerType = 'fill' | 'line' | 'circle' | 'symbol';

/**
 * A paint property's value at a zoom, for a feature with the given properties.
 *
 * Throws when MapLibre would reject the expression, such as a zoom interpolate that is
 * not the outermost expression, so a malformed style fails the test instead of drawing
 * nothing in the browser.
 */
export function paintValue(
  layerType: LayerType,
  property: string,
  value: unknown,
  zoom: number,
  properties: Record<string, unknown> = {},
): unknown {
  return evaluate('paint', layerType, property, value, zoom, properties);
}

/** {@link paintValue} for a layout property, such as `symbol-sort-key`. */
export function layoutValue(
  layerType: LayerType,
  property: string,
  value: unknown,
  zoom: number,
  properties: Record<string, unknown> = {},
): unknown {
  return evaluate('layout', layerType, property, value, zoom, properties);
}

function evaluate(
  group: 'paint' | 'layout',
  layerType: LayerType,
  property: string,
  value: unknown,
  zoom: number,
  properties: Record<string, unknown>,
): unknown {
  const spec = (latest as unknown as Record<string, Record<string, unknown>>)[`${group}_${layerType}`][
    property
  ];
  if (!spec) throw new Error(`no ${group} property ${layerType}.${property}`);
  const parsed = createPropertyExpression(value, spec as never);
  if (parsed.result !== 'success') {
    throw new Error(`${property}: ${parsed.value.map((e) => e.message).join('; ')}`);
  }
  return parsed.value.evaluate({ zoom }, { type: 'Feature', properties } as never);
}

/** A CSS colour as the evaluator returns it, for comparing with a {@link paintValue}. */
export function styleColor(css: string): Color {
  const color = Color.parse(css);
  if (!color) throw new Error(`not a colour: ${css}`);
  return color;
}
