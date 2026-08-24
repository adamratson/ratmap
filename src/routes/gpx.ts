import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { LngLat } from './geo';
import type { Waypoint } from './route-model';
import { newWaypointId } from './route-model';

// GPX and GeoJSON in and out.
//
// This is the escape hatch for irreplaceable user data. Routes live in an IndexedDB store
// inside a browser profile — one "clear site data" from gone — so getting them *out* in a
// format every other tool reads is not a nice-to-have. The same reasoning the spec applies
// to the bagging log in Phase 3.5 applies here.
//
// Import matters just as much in the other direction: a GPX someone already has must open
// and follow offline without a route ever having been planned in this app (§4 Phase 4,
// "offline route following ships in this phase and needs no engine").

export interface RouteExport {
  name: string;
  coords: LngLat[];
  /** Per-coordinate heights, index for index. Omitted points are written without <ele>. */
  elevations?: (number | null)[];
  waypoints?: Waypoint[];
  createdAt?: number;
}

export interface ImportedRoute {
  name: string;
  coords: LngLat[];
  waypoints: Waypoint[];
}

const GPX_CREATOR = 'ratmap';

/**
 * GPX 1.1 track.
 *
 * A `<trk>`, not a `<rte>`: a route in GPX terms is a sparse list of turn points, while a
 * track is the actual line on the ground — which is what we have and what other tools
 * render as a path. The waypoints are additionally written as `<wpt>` so the planning
 * points survive a round-trip through anything that keeps them.
 */
export function toGpx(route: RouteExport): string {
  const time = new Date(route.createdAt ?? Date.now()).toISOString();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${GPX_CREATOR}" xmlns="http://www.topografix.com/GPX/1/1">`,
    '  <metadata>',
    `    <name>${escapeXml(route.name)}</name>`,
    `    <time>${time}</time>`,
    '  </metadata>',
  ];

  for (const waypoint of route.waypoints ?? []) {
    lines.push(`  <wpt lat="${coord(waypoint.lat)}" lon="${coord(waypoint.lng)}">`);
    if (waypoint.name) lines.push(`    <name>${escapeXml(waypoint.name)}</name>`);
    if (typeof waypoint.ele === 'number') lines.push(`    <ele>${waypoint.ele.toFixed(1)}</ele>`);
    lines.push('  </wpt>');
  }

  lines.push('  <trk>', `    <name>${escapeXml(route.name)}</name>`, '    <trkseg>');

  for (let i = 0; i < route.coords.length; i++) {
    const [lng, lat] = route.coords[i];
    const ele = route.elevations?.[i];
    if (typeof ele === 'number' && Number.isFinite(ele)) {
      lines.push(
        `      <trkpt lat="${coord(lat)}" lon="${coord(lng)}"><ele>${ele.toFixed(1)}</ele></trkpt>`,
      );
    } else {
      lines.push(`      <trkpt lat="${coord(lat)}" lon="${coord(lng)}" />`);
    }
  }

  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}

export function toGeoJson(route: RouteExport): FeatureCollection {
  const track: Feature<LineString> = {
    type: 'Feature',
    properties: { name: route.name, kind: 'route' },
    geometry: {
      type: 'LineString',
      // GeoJSON positions take elevation as a third ordinate, which is exactly what the
      // profile produces — so an exported route carries its heights without a convention
      // of our own.
      coordinates: route.coords.map((position, i) => {
        const ele = route.elevations?.[i];
        return typeof ele === 'number' && Number.isFinite(ele)
          ? [position[0], position[1], Math.round(ele * 10) / 10]
          : [position[0], position[1]];
      }),
    },
  };

  const waypoints: Feature<Point>[] = (route.waypoints ?? []).map((waypoint, index) => ({
    type: 'Feature',
    properties: {
      name: waypoint.name ?? `Waypoint ${index + 1}`,
      kind: 'waypoint',
      ...(typeof waypoint.ele === 'number' ? { ele: waypoint.ele } : {}),
    },
    geometry: { type: 'Point', coordinates: [waypoint.lng, waypoint.lat] },
  }));

  return { type: 'FeatureCollection', features: [track, ...waypoints] };
}

/**
 * Parse a route out of GPX or GeoJSON text, detected from the content.
 *
 * Detected rather than taken from the file extension: files get renamed, and a `.txt`
 * holding valid GPX should still open. Throws with a readable message rather than
 * returning an empty route — "nothing happened" is the worst possible response to an
 * import.
 */
export function parseRouteFile(text: string, filename?: string): ImportedRoute {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('That file is empty.');

  const fallbackName = filename?.replace(/\.[^.]+$/, '') || 'Imported route';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseGeoJson(trimmed, fallbackName);
  }
  return parseGpx(trimmed, fallbackName);
}

export function parseGpx(text: string, fallbackName = 'Imported route'): ImportedRoute {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // A parse failure produces a document containing <parsererror>, not an exception.
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('That file is not valid XML, so it cannot be read as GPX.');
  }

  // Namespace-agnostic: GPX 1.0 and 1.1 use different namespace URIs, and plenty of files
  // in the wild carry a prefix or none at all.
  const byName = (name: string): Element[] => [...doc.getElementsByTagNameNS('*', name)];

  const coords: LngLat[] = [];
  // A track first, then a route: both are lines, and a file carrying both means the track
  // is the recorded one.
  for (const tag of ['trkpt', 'rtept']) {
    for (const point of byName(tag)) {
      const position = readLatLon(point);
      if (position) coords.push(position);
    }
    if (coords.length > 0) break;
  }

  const waypoints: Waypoint[] = [];
  for (const wpt of byName('wpt')) {
    const position = readLatLon(wpt);
    if (!position) continue;
    waypoints.push({
      id: newWaypointId(),
      lng: position[0],
      lat: position[1],
      ...nameOf(wpt),
      ...eleOf(wpt),
    });
  }

  if (coords.length === 0 && waypoints.length === 0) {
    throw new Error('No track, route or waypoints found in that GPX file.');
  }

  // A GPX of nothing but waypoints is a legitimate thing to import — treat them as the
  // line, in order, rather than rejecting the file.
  const geometry = coords.length > 0 ? coords : waypoints.map((w): LngLat => [w.lng, w.lat]);

  const name =
    textOf(doc.getElementsByTagNameNS('*', 'trk')[0], 'name') ??
    textOf(doc.getElementsByTagNameNS('*', 'metadata')[0], 'name') ??
    fallbackName;

  return { name, coords: geometry, waypoints };
}

export function parseGeoJson(text: string, fallbackName = 'Imported route'): ImportedRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  const features = collectFeatures(parsed);
  const coords: LngLat[] = [];
  const waypoints: Waypoint[] = [];
  let name: string | null = null;

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;

    if (geometry.type === 'LineString' && coords.length === 0) {
      for (const position of geometry.coordinates) coords.push([position[0], position[1]]);
      name ??= stringProp(feature, 'name');
    } else if (geometry.type === 'MultiLineString' && coords.length === 0) {
      // Joined end to end: a multi-line route is one walk split at gaps, and dropping all
      // but the first segment would silently import a fraction of it.
      for (const part of geometry.coordinates) {
        for (const position of part) coords.push([position[0], position[1]]);
      }
      name ??= stringProp(feature, 'name');
    } else if (geometry.type === 'Point') {
      const ele = geometry.coordinates[2];
      waypoints.push({
        id: newWaypointId(),
        lng: geometry.coordinates[0],
        lat: geometry.coordinates[1],
        ...(stringProp(feature, 'name') ? { name: stringProp(feature, 'name')! } : {}),
        ...(typeof ele === 'number' ? { ele } : {}),
      });
    }
  }

  if (coords.length === 0 && waypoints.length === 0) {
    throw new Error('No line or point geometry found in that GeoJSON file.');
  }

  const geometry = coords.length > 0 ? coords : waypoints.map((w): LngLat => [w.lng, w.lat]);
  return { name: name ?? fallbackName, coords: geometry, waypoints };
}

function collectFeatures(parsed: unknown): Feature[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const value = parsed as { type?: string; features?: Feature[]; geometry?: unknown };

  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) return value.features;
  if (value.type === 'Feature') return [value as Feature];
  // A bare geometry object is common enough from command-line tools to be worth handling.
  if (typeof value.type === 'string') {
    return [{ type: 'Feature', properties: {}, geometry: value as never }];
  }
  return [];
}

function stringProp(feature: Feature, key: string): string | null {
  const value = feature.properties?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readLatLon(element: Element): LngLat | null {
  // Parsed through a null/blank check rather than straight through Number(): `Number('')`
  // and `Number(null)` are both 0, so a point with a missing or empty coordinate would
  // import as a position off the Gulf of Guinea instead of being skipped — a plausible
  // coordinate, silently wrong, which is the worst kind.
  const lat = numberAttribute(element, 'lat');
  const lon = numberAttribute(element, 'lon');
  if (lat === null || lon === null) return null;
  // Out-of-range values mean a corrupt or misread file, not an exotic location.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

function numberAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function nameOf(element: Element): { name?: string } {
  const value = textOf(element, 'name');
  return value ? { name: value } : {};
}

function eleOf(element: Element): { ele?: number } {
  const value = Number(textOf(element, 'ele'));
  return Number.isFinite(value) && textOf(element, 'ele') !== null ? { ele: value } : {};
}

function textOf(parent: Element | undefined, tag: string): string | null {
  if (!parent) return null;
  const found = parent.getElementsByTagNameNS('*', tag)[0];
  const text = found?.textContent?.trim();
  return text ? text : null;
}

/** Trim to ~7 decimal places — about a centimetre, and far past what a GPS knows. */
function coord(value: number): string {
  return value.toFixed(7);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
