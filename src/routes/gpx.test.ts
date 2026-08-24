import { describe, expect, it } from 'vitest';
import { parseGeoJson, parseGpx, parseRouteFile, toGeoJson, toGpx } from './gpx';
import type { LngLat } from './geo';
import type { Waypoint } from './route-model';

const COORDS: LngLat[] = [
  [-5.076, 56.8094],
  [-5.04, 56.803],
  [-5.0037, 56.7969],
];

const WAYPOINTS: Waypoint[] = [
  { id: 'a', lng: -5.076, lat: 56.8094, name: 'Achintee' },
  { id: 'b', lng: -5.0037, lat: 56.7969, name: 'Ben Nevis', ele: 1345 },
];

describe('toGpx', () => {
  it('writes a track of every coordinate', () => {
    const gpx = toGpx({ name: 'Ben Nevis', coords: COORDS });
    expect(gpx).toContain('<trkseg>');
    expect(gpx.match(/<trkpt/g)).toHaveLength(3);
    expect(gpx).toContain('lat="56.8094000"');
    expect(gpx).toContain('lon="-5.0760000"');
  });

  it('writes elevations where the profile has them', () => {
    const gpx = toGpx({ name: 'Ben Nevis', coords: COORDS, elevations: [20, null, 1345] });
    expect(gpx).toContain('<ele>1345.0</ele>');
    // A missing height must not become 0 — that would export sea level as fact.
    expect(gpx).not.toContain('<ele>0.0</ele>');
    expect(gpx.match(/<ele>/g)).toHaveLength(2);
  });

  it('writes the planning waypoints alongside the track', () => {
    const gpx = toGpx({ name: 'Ben Nevis', coords: COORDS, waypoints: WAYPOINTS });
    expect(gpx.match(/<wpt/g)).toHaveLength(2);
    expect(gpx).toContain('<name>Achintee</name>');
  });

  it('escapes names rather than emitting broken XML', () => {
    // Route names are user input and OSM place names; both contain ampersands.
    const gpx = toGpx({ name: 'Ben & Càrn <Mòr>', coords: COORDS });
    expect(gpx).toContain('Ben &amp; Càrn &lt;Mòr&gt;');
    expect(parseGpx(gpx).name).toBe('Ben & Càrn <Mòr>');
  });

  it('round-trips through the parser', () => {
    const gpx = toGpx({ name: 'Ben Nevis', coords: COORDS, waypoints: WAYPOINTS });
    const parsed = parseGpx(gpx);
    expect(parsed.name).toBe('Ben Nevis');
    expect(parsed.coords).toHaveLength(3);
    expect(parsed.coords[2][0]).toBeCloseTo(-5.0037, 6);
    expect(parsed.waypoints.map((w) => w.name)).toEqual(['Achintee', 'Ben Nevis']);
    expect(parsed.waypoints[1].ele).toBe(1345);
  });
});

describe('parseGpx', () => {
  it('reads a track from a file written by another tool', () => {
    const gpx = `<?xml version="1.0"?>
      <gpx version="1.1" creator="Garmin" xmlns="http://www.topografix.com/GPX/1/1">
        <trk><name>Carn Mor Dearg Arete</name><trkseg>
          <trkpt lat="56.8094" lon="-5.076"><ele>24.0</ele></trkpt>
          <trkpt lat="56.7969" lon="-5.0037"><ele>1345.0</ele></trkpt>
        </trkseg></trk>
      </gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.name).toBe('Carn Mor Dearg Arete');
    expect(parsed.coords).toEqual([
      [-5.076, 56.8094],
      [-5.0037, 56.7969],
    ]);
  });

  it('falls back to route points when there is no track', () => {
    const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <rte><rtept lat="56.8" lon="-5.07" /><rtept lat="56.79" lon="-5.0" /></rte>
    </gpx>`;
    expect(parseGpx(gpx).coords).toHaveLength(2);
  });

  it('reads a file that carries only waypoints', () => {
    const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="56.8" lon="-5.07"><name>Start</name></wpt>
      <wpt lat="56.79" lon="-5.0"><name>Summit</name></wpt>
    </gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.waypoints).toHaveLength(2);
    // Rejecting the file would be worse than treating the waypoints as the line.
    expect(parsed.coords).toHaveLength(2);
  });

  it('reads a namespace-prefixed file', () => {
    const gpx = `<g:gpx version="1.1" xmlns:g="http://www.topografix.com/GPX/1/1">
      <g:trk><g:trkseg>
        <g:trkpt lat="56.8" lon="-5.07" /><g:trkpt lat="56.79" lon="-5.0" />
      </g:trkseg></g:trk>
    </g:gpx>`;
    expect(parseGpx(gpx).coords).toHaveLength(2);
  });

  it('rejects malformed XML with a readable message', () => {
    expect(() => parseGpx('<gpx><trk>')).toThrow(/not valid XML/i);
  });

  it('rejects a valid GPX with nothing in it', () => {
    // "Nothing happened" is the worst possible response to an import.
    expect(() =>
      parseGpx('<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"></gpx>'),
    ).toThrow(/no track/i);
  });

  it('skips a point with a blank coordinate rather than placing it on the equator', () => {
    // Number('') is 0, so a naive parse imports a missing lat as latitude zero — a
    // plausible-looking position in the Gulf of Guinea.
    const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="56.8" lon="-5.07" /><trkpt lat="" lon="-5.0" /><trkpt lat="56.79" lon="-5.0" />
      </trkseg></trk></gpx>`;
    expect(parseGpx(gpx).coords).toEqual([
      [-5.07, 56.8],
      [-5.0, 56.79],
    ]);
  });

  it('skips a coordinate outside the possible range', () => {
    const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="56.8" lon="-5.07" /><trkpt lat="956.79" lon="-5.0" /><trkpt lat="56.79" lon="-5.0" />
      </trkseg></trk></gpx>`;
    expect(parseGpx(gpx).coords).toHaveLength(2);
  });
});

describe('GeoJSON', () => {
  it('exports the route as a LineString with heights as the third ordinate', () => {
    const collection = toGeoJson({
      name: 'Ben Nevis',
      coords: COORDS,
      elevations: [24, null, 1345],
    });
    const track = collection.features[0];
    expect(track.geometry.type).toBe('LineString');
    const line = track.geometry as { coordinates: number[][] };
    expect(line.coordinates[0]).toEqual([-5.076, 56.8094, 24]);
    // No height means two ordinates, not a zero.
    expect(line.coordinates[1]).toHaveLength(2);
  });

  it('exports waypoints as points beside the line', () => {
    const collection = toGeoJson({ name: 'Ben Nevis', coords: COORDS, waypoints: WAYPOINTS });
    expect(collection.features).toHaveLength(3);
    expect(collection.features[1].properties?.kind).toBe('waypoint');
  });

  it('round-trips', () => {
    const collection = toGeoJson({ name: 'Ben Nevis', coords: COORDS, waypoints: WAYPOINTS });
    const parsed = parseGeoJson(JSON.stringify(collection));
    expect(parsed.name).toBe('Ben Nevis');
    expect(parsed.coords).toHaveLength(3);
    expect(parsed.waypoints).toHaveLength(2);
  });

  it('joins a MultiLineString rather than importing only its first part', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'Feature',
        properties: { name: 'Split walk' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-5.07, 56.8],
              [-5.05, 56.8],
            ],
            [
              [-5.03, 56.79],
              [-5.0, 56.79],
            ],
          ],
        },
      }),
    );
    expect(parsed.coords).toHaveLength(4);
  });

  it('accepts a bare geometry object', () => {
    const parsed = parseGeoJson(
      JSON.stringify({
        type: 'LineString',
        coordinates: [
          [-5.07, 56.8],
          [-5.0, 56.79],
        ],
      }),
      'walk',
    );
    expect(parsed.coords).toHaveLength(2);
    expect(parsed.name).toBe('walk');
  });

  it('rejects invalid JSON readably', () => {
    expect(() => parseGeoJson('{oops')).toThrow(/not valid JSON/i);
  });

  it('rejects a collection with no usable geometry', () => {
    expect(() => parseGeoJson('{"type":"FeatureCollection","features":[]}')).toThrow(/no line/i);
  });
});

describe('parseRouteFile', () => {
  it('detects GeoJSON from its content, not its extension', () => {
    const json = JSON.stringify(toGeoJson({ name: 'x', coords: COORDS }));
    expect(parseRouteFile(json, 'route.gpx').coords).toHaveLength(3);
  });

  it('detects GPX from its content', () => {
    const gpx = toGpx({ name: 'x', coords: COORDS });
    expect(parseRouteFile(gpx, 'route.json').coords).toHaveLength(3);
  });

  it('names an unnamed import after its file', () => {
    const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg><trkpt lat="56.8" lon="-5.07" /><trkpt lat="56.79" lon="-5" /></trkseg></trk>
    </gpx>`;
    expect(parseRouteFile(gpx, 'ben-nevis.gpx').name).toBe('ben-nevis');
  });

  it('rejects an empty file', () => {
    expect(() => parseRouteFile('   ')).toThrow(/empty/i);
  });
});
