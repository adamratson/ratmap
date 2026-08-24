// Minimal declaration for the test-only vector tile encoder. vt-pbf ships no types, and
// only `fromGeojsonVt` is used — to build real MVT bytes as fixtures for
// `path-tiles.test.ts`, so the decoder is tested against the wire format rather than
// against a hand-rolled stand-in for it.
declare module 'vt-pbf' {
  interface GeojsonVtFeature {
    /** 1 = point, 2 = line, 3 = polygon. */
    type: number;
    geometry: number[][][];
    tags: Record<string, string | number | boolean>;
  }

  interface GeojsonVtLayer {
    features: GeojsonVtFeature[];
  }

  export function fromGeojsonVt(
    layers: Record<string, GeojsonVtLayer>,
    options?: { version?: number; extent?: number },
  ): Uint8Array;
}
