import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { distanceMetres, pathLengthMetres, type LngLat } from './geo';
import type { ComputedLeg, LegKind } from './router';
import type { LegSlot, Waypoint } from './route-model';
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
  /**
   * The legs the route was planned as. Written so that ratmap can rebuild them on import —
   * the waypoints in between, and which legs are straight lines rather than paths (C11).
   * Left out of the file unless they line up with `coords` exactly; see {@link legSpans}.
   */
  legs?: readonly LegSlot[];
  createdAt?: number;
}

export interface ImportedRoute {
  name: string;
  coords: LngLat[];
  waypoints: Waypoint[];
  /** Only for a file ratmap wrote, and only when its legs survived the trip intact. */
  legs?: ComputedLeg[];
  /** Something about how the file was read that the person opening it should be told. */
  note?: string;
}

/**
 * One leg, as vertex indices into the route's line, both inclusive. A leg starts on the
 * vertex the one before it ended on — written once — or on the next one, where the two did
 * not quite meet.
 */
export interface LegSpan {
  kind: LegKind;
  start: number;
  end: number;
}

const GPX_CREATOR = 'ratmap';

/**
 * Namespace of ratmap's own GPX extension, which carries the legs.
 *
 * A `tag:` URI rather than a URL: it only has to be unique and never change, and a dated tag
 * is both by construction (RFC 4151). A URL would name a host the app might not stay on —
 * which is still an open decision (plans/route-sharing.md §6).
 */
export const RATMAP_GPX_NS = 'tag:adamratson.github.io,2026:ratmap/gpx/1';

/** Version of the `ratmap` property on an exported GeoJSON route — GeoJSON's equivalent. */
const GEOJSON_LEGS_VERSION = 1;

const UNREADABLE_LEGS =
  'Its legs couldn’t be read, so it opens as one track, and any straight-line sections in it aren’t marked as such.';

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
  const spans = route.legs ? legSpans(route.coords, route.legs) : null;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${GPX_CREATOR}" xmlns="http://www.topografix.com/GPX/1/1"` +
      `${spans ? ` xmlns:ratmap="${RATMAP_GPX_NS}"` : ''}>`,
    '  <metadata>',
    `    <name>${escapeXml(route.name)}</name>`,
    `    <time>${time}</time>`,
    '  </metadata>',
  ];

  for (const waypoint of route.waypoints ?? []) {
    lines.push(`  <wpt lat="${coord(waypoint.lat)}" lon="${coord(waypoint.lng)}">`);
    // GPX 1.1 puts a waypoint's <ele> before its <name>.
    if (typeof waypoint.ele === 'number') lines.push(`    <ele>${waypoint.ele.toFixed(1)}</ele>`);
    if (waypoint.name) lines.push(`    <name>${escapeXml(waypoint.name)}</name>`);
    lines.push('  </wpt>');
  }

  lines.push('  <trk>', `    <name>${escapeXml(route.name)}</name>`);

  if (spans) {
    // The legs go in the track's own <extensions>, which the schema places before its
    // segments — not one <trkseg> per leg. A new segment means "signal was lost here" in
    // GPX 1.1, and another app may well draw it as a gap. With one segment, every other
    // tool sees exactly the track it always did.
    lines.push('    <extensions>', '      <ratmap:legs>');
    for (const span of spans) {
      lines.push(`        <ratmap:leg kind="${span.kind}" start="${span.start}" end="${span.end}" />`);
    }
    lines.push('      </ratmap:legs>', '    </extensions>');
  }

  lines.push('    <trkseg>');

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
  const spans = route.legs ? legSpans(route.coords, route.legs) : null;
  const track: Feature<LineString> = {
    type: 'Feature',
    properties: {
      name: route.name,
      kind: 'route',
      // GeoJSON has no namespaces, so the legs ride in a property of ratmap's own,
      // versioned, beside the ones every tool reads.
      ...(spans ? { ratmap: { version: GEOJSON_LEGS_VERSION, legs: spans } } : {}),
    },
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
  let fromTrack = false;
  // A track first, then a route: both are lines, and a file carrying both means the track
  // is the recorded one.
  for (const tag of ['trkpt', 'rtept']) {
    for (const point of byName(tag)) {
      const position = readLatLon(point);
      if (position) coords.push(position);
    }
    if (coords.length > 0) {
      fromTrack = tag === 'trkpt';
      break;
    }
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

  // ratmap's own extension, in a file ratmap wrote. Its indices count track points, so
  // against route points or bare waypoints it cannot mean anything.
  const legElements = [...doc.getElementsByTagNameNS(RATMAP_GPX_NS, 'leg')];
  const spans =
    legElements.length === 0
      ? null
      : fromTrack
        ? legElements.map((leg) => ({
            kind: leg.getAttribute('kind'),
            start: leg.getAttribute('start'),
            end: leg.getAttribute('end'),
          }))
        : [];

  return withLegs({ name, coords: geometry, waypoints }, spans);
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
  let spans: RawSpan[] | null = null;

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;

    if (geometry.type === 'LineString' && coords.length === 0) {
      for (const position of geometry.coordinates) coords.push([position[0], position[1]]);
      name ??= stringProp(feature, 'name');
      spans = geoJsonSpans(feature);
    } else if (geometry.type === 'MultiLineString' && coords.length === 0) {
      // Joined end to end: a multi-line route is one walk split at gaps, and dropping all
      // but the first segment would silently import a fraction of it.
      for (const part of geometry.coordinates) {
        for (const position of part) coords.push([position[0], position[1]]);
      }
      name ??= stringProp(feature, 'name');
    } else if (geometry.type === 'Point') {
      // A third ordinate, or failing that the `ele` property — which is where toGeoJson
      // writes a waypoint's height.
      const ele = geometry.coordinates[2] ?? feature.properties?.ele;
      waypoints.push({
        id: newWaypointId(),
        lng: geometry.coordinates[0],
        lat: geometry.coordinates[1],
        ...(stringProp(feature, 'name') ? { name: stringProp(feature, 'name')! } : {}),
        ...(typeof ele === 'number' && Number.isFinite(ele) ? { ele } : {}),
      });
    }
  }

  if (coords.length === 0 && waypoints.length === 0) {
    throw new Error('No line or point geometry found in that GeoJSON file.');
  }

  const geometry = coords.length > 0 ? coords : waypoints.map((w): LngLat => [w.lng, w.lat]);

  // toGeoJson names an unnamed waypoint "Waypoint 2" for the tools that list them. Read
  // back into ratmap as a route's own waypoints, that would become a name it never had.
  const named = spans
    ? waypoints.map((waypoint, i) =>
        waypoint.name === `Waypoint ${i + 1}` ? withoutName(waypoint) : waypoint,
      )
    : waypoints;

  return withLegs({ name: name ?? fallbackName, coords: geometry, waypoints: named }, spans);
}

/**
 * The legs a GeoJSON route of ratmap's carries: null when it has none, and an empty list
 * when it has something that is not legs this build can read.
 */
function geoJsonSpans(feature: Feature): RawSpan[] | null {
  const ratmap: unknown = feature.properties?.ratmap;
  if (ratmap === undefined) return null;

  const value = ratmap as { version?: unknown; legs?: unknown } | null;
  if (value?.version !== GEOJSON_LEGS_VERSION || !Array.isArray(value.legs)) return [];
  return value.legs.map((leg: { kind?: unknown; start?: unknown; end?: unknown } | null) => ({
    kind: leg?.kind,
    start: leg?.start,
    end: leg?.end,
  }));
}

function withoutName(waypoint: Waypoint): Waypoint {
  const copy = { ...waypoint };
  delete copy.name;
  return copy;
}

// --- Legs ------------------------------------------------------------------------------

/** A leg as a file states it, before anything about it is trusted. */
interface RawSpan {
  kind: unknown;
  start: unknown;
  end: unknown;
}

/**
 * Where each leg sits in `coords`, by vertex index — or null if they do not line up.
 *
 * `coords` is authoritative (C10) and the legs are editing state, so this describes one in
 * terms of the other only when they agree vertex for vertex, joined the way
 * RouteDraft.coordinates() joins them. A pending leg, or a record whose legs and line have
 * drifted apart, gets nothing: a file that says nothing about legs is better than one that
 * says something wrong about them.
 */
export function legSpans(coords: readonly LngLat[], legs: readonly LegSlot[]): LegSpan[] | null {
  if (legs.length === 0) return null;

  const spans: LegSpan[] = [];
  let next = 0;
  for (const leg of legs) {
    if (!leg || leg.coords.length < 2) return null;

    // RouteDraft.coordinates() writes the vertex two legs share once, if they meet within a
    // metre, and both otherwise.
    const previous = spans[spans.length - 1];
    const start =
      previous !== undefined && distanceMetres(coords[previous.end], leg.coords[0]) < 1 ? previous.end : next;
    const shared = start !== next;
    const end = start + leg.coords.length - 1;
    if (end >= coords.length) return null;

    for (let k = shared ? 1 : 0; k < leg.coords.length; k++) {
      const [lng, lat] = coords[start + k];
      if (lng !== leg.coords[k][0] || lat !== leg.coords[k][1]) return null;
    }

    spans.push({ kind: leg.kind, start, end });
    next = end + 1;
  }

  return next === coords.length ? spans : null;
}

/**
 * Rebuild the legs and waypoints a file of ratmap's was planned as.
 *
 * `spans` is null for a file without them, which is returned as it was read. Otherwise it is
 * all or nothing: a span that does not fit the line means something edited the file without
 * knowing what the legs are, and legs guessed from it could pass a straight line off as a
 * path (C11). So the file opens as one track instead, and says why.
 */
function withLegs(route: ImportedRoute, spans: readonly RawSpan[] | null): ImportedRoute {
  if (spans === null) return route;

  const valid = validSpans(spans, route.coords.length);
  if (!valid) return { ...route, note: UNREADABLE_LEGS };

  const legs: ComputedLeg[] = valid.map(({ kind, start, end }) => {
    const coords = route.coords.slice(start, end + 1);
    return { coords, distanceM: pathLengthMetres(coords), kind, wayNames: [] };
  });

  // A waypoint at each end of each leg. ratmap writes one <wpt> per waypoint, in order, so
  // when the counts agree those carry the names; the positions come from the line either
  // way, since that is what the legs are cut from.
  const ends: LngLat[] = [route.coords[valid[0].start], ...valid.map((span) => route.coords[span.end])];
  const named = route.waypoints.length === ends.length ? route.waypoints : null;
  const waypoints: Waypoint[] = ends.map(([lng, lat], i) => ({
    id: newWaypointId(),
    lng,
    lat,
    ...(named?.[i].name ? { name: named[i].name } : {}),
    ...(typeof named?.[i].ele === 'number' ? { ele: named[i].ele } : {}),
  }));

  return { ...route, waypoints, legs };
}

/** The spans, if every one is well-formed and together they cover the line exactly once. */
function validSpans(spans: readonly RawSpan[], vertexCount: number): LegSpan[] | null {
  const valid: LegSpan[] = [];
  for (const span of spans) {
    const { kind } = span;
    const start = wholeNumber(span.start);
    const end = wholeNumber(span.end);
    if ((kind !== 'snapped' && kind !== 'straight') || start === null || end === null || end <= start) {
      return null;
    }

    const previous = valid[valid.length - 1];
    if (previous ? start !== previous.end && start !== previous.end + 1 : start !== 0) return null;
    valid.push({ kind, start, end });
  }

  return valid.length > 0 && valid[valid.length - 1].end === vertexCount - 1 ? valid : null;
}

/**
 * A non-negative integer from an attribute or a JSON value, or null.
 *
 * Through a blank check rather than straight through Number(), for the same reason as
 * {@link numberAttribute}: `Number('')` is 0, which is a perfectly plausible index.
 */
function wholeNumber(value: unknown): number | null {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 0 ? number : null;
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
