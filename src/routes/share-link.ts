import { pathLengthMetres, type LngLat } from './geo';
import { newWaypointId, type Waypoint } from './route-model';
import type { ComputedLeg } from './router';

// A route as a link: plans/route-sharing.md §4. The whole route travels in the URL's
// fragment, which never reaches any server, so a route is exactly as private as the channel
// it is sent through, and it draws, follows and exports with no region and no network — C10
// extended to sharing.
//
// The bytes, in order. Varints are unsigned LEB128; coordinates are zigzag deltas.
//
//   version            1 byte, FORMAT_VERSION
//   flags              1 byte, FLAG_*
//   route name         varint length + UTF-8
//   waypoint count     varint
//   each waypoint      lng and lat at 1e-6°, delta from the last; name, as the route name
//   each leg           kind (LEG_*); distance in decimetres; interior vertex count;
//                      interior vertices at 1e-5°, delta from the leg's start
//   sender's stats     ascent and descent in whole metres (FLAG_STATS only)
//   CRC-32             4 bytes, little-endian, over everything before it
//
// A leg's ends are its waypoints, so they are not stored twice. The checksum is what makes a
// messenger that truncates a long URL produce "damaged" rather than a shorter route that
// decodes cleanly, and it is checked before anything else is read.

const FORMAT_VERSION = 1;

/** Every leg carries its geometry. Links without it (compact links, Stage C) are not read yet. */
const FLAG_GEOMETRY = 1 << 0;
const FLAG_STATS = 1 << 1;
const KNOWN_FLAGS = FLAG_GEOMETRY | FLAG_STATS;

const LEG_SNAPPED = 0;
const LEG_STRAIGHT = 1;
const LEG_FREEHAND = 2;

const WAYPOINT_SCALE = 1e6;
const VERTEX_SCALE = 1e5;
const DISTANCE_SCALE = 10;

const MAX_ROUTE_NAME_BYTES = 120;
const MAX_WAYPOINT_NAME_BYTES = 80;
const MAX_WAYPOINTS = 500;
const MAX_VERTICES = 20_000;
/** The longest payload read, in characters, checked before any of it is decoded. */
const MAX_PAYLOAD_CHARS = 64 * 1024;
const MAX_STAT_M = 100_000;

/**
 * How far a leg's line may be simplified, metres (§6 decision 2).
 *
 * Nothing against the 60 m off-route threshold in follow.ts, and the leg's measured
 * distance travels with it, so the figure on screen is exact however the line was thinned.
 */
const SIMPLIFY_TOLERANCE_M = 2;

const PAYLOAD_KEY = 'r=';

/** The link is cut short or corrupted. Nothing from it may be shown. */
export class LinkDamaged extends Error {
  constructor(detail: string) {
    super(`This route link is damaged: ${detail}.`);
    this.name = 'LinkDamaged';
  }
}

/** A later ratmap wrote this. Refused whole, never half-read — see CatalogueTooNew. */
export class LinkTooNew extends Error {
  constructor() {
    super('This route link needs a newer version of ratmap.');
    this.name = 'LinkTooNew';
  }
}

/** The route will not fit in a link. The sender can still send a file. */
export class LinkTooLong extends Error {
  constructor() {
    super('This route is too long for a link.');
    this.name = 'LinkTooLong';
  }
}

export interface SenderStats {
  ascentM: number;
  descentM: number;
}

/** What a link carries, as the planner holds it. */
export interface LinkRoute {
  name: string;
  waypoints: Pick<Waypoint, 'lng' | 'lat' | 'name'>[];
  legs: Pick<ComputedLeg, 'coords' | 'distanceM' | 'kind' | 'freehand'>[];
  /** The sender's own climb. Null when they had no profile to take it from. */
  stats: SenderStats | null;
}

/** A decoded link, ready for `RoutePlanner.load`. */
export interface ReceivedRoute {
  name: string;
  coords: LngLat[];
  waypoints: Waypoint[];
  legs: ComputedLeg[];
  stats: SenderStats | null;
}

// --- Writing --------------------------------------------------------------------------

class ByteWriter {
  private readonly bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value);
  }

  varint(value: number): void {
    let rest = value;
    // Arithmetic, not bit shifts: shifts wrap at 32 bits.
    while (rest >= 0x80) {
      this.bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.bytes.push(rest);
  }

  signed(value: number): void {
    this.varint(value < 0 ? -2 * value - 1 : 2 * value);
  }

  text(value: Uint8Array): void {
    this.varint(value.length);
    for (const byte of value) this.bytes.push(byte);
  }

  finish(): Uint8Array {
    const body = Uint8Array.from(this.bytes);
    const out = new Uint8Array(body.length + 4);
    out.set(body);
    new DataView(out.buffer).setUint32(body.length, crc32(body), true);
    return out;
  }
}

/** The name as UTF-8 within `maxBytes`, cut between characters rather than through one. */
function nameBytes(name: string | undefined, maxBytes: number): Uint8Array {
  const encoder = new TextEncoder();
  let text = cleanName(name ?? '');
  let bytes = encoder.encode(text);
  while (bytes.length > maxBytes) {
    text = [...text].slice(0, -1).join('');
    bytes = encoder.encode(text);
  }
  return bytes;
}

/** The fragment payload for a route. Throws {@link LinkTooLong} if it cannot fit. */
export function encodeRouteLink(route: LinkRoute): string {
  if (route.waypoints.length < 2 || route.legs.length !== route.waypoints.length - 1) {
    throw new Error('A route link needs at least two waypoints and a leg between each.');
  }
  if (route.waypoints.length > MAX_WAYPOINTS) throw new LinkTooLong();

  const writer = new ByteWriter();
  writer.byte(FORMAT_VERSION);
  writer.byte(FLAG_GEOMETRY | (route.stats ? FLAG_STATS : 0));
  writer.text(nameBytes(route.name, MAX_ROUTE_NAME_BYTES));

  writer.varint(route.waypoints.length);
  let lastLng = 0;
  let lastLat = 0;
  for (const waypoint of route.waypoints) {
    const lng = Math.round(waypoint.lng * WAYPOINT_SCALE);
    const lat = Math.round(waypoint.lat * WAYPOINT_SCALE);
    writer.signed(lng - lastLng);
    writer.signed(lat - lastLat);
    lastLng = lng;
    lastLat = lat;
    writer.text(nameBytes(waypoint.name, MAX_WAYPOINT_NAME_BYTES));
  }

  let vertices = 0;
  route.legs.forEach((leg, index) => {
    const start = route.waypoints[index];
    writer.byte(leg.freehand ? LEG_FREEHAND : leg.kind === 'straight' ? LEG_STRAIGHT : LEG_SNAPPED);
    writer.varint(Math.round(leg.distanceM * DISTANCE_SCALE));

    const interior = interiorVertices(leg.coords);
    vertices += interior.length;
    if (vertices > MAX_VERTICES) throw new LinkTooLong();

    writer.varint(interior.length);
    let lastX = Math.round(start.lng * VERTEX_SCALE);
    let lastY = Math.round(start.lat * VERTEX_SCALE);
    for (const [x, y] of interior) {
      writer.signed(x - lastX);
      writer.signed(y - lastY);
      lastX = x;
      lastY = y;
    }
  });

  if (route.stats) {
    writer.varint(Math.round(route.stats.ascentM));
    writer.varint(Math.round(route.stats.descentM));
  }

  const payload = toBase64Url(writer.finish());
  if (payload.length > MAX_PAYLOAD_CHARS) throw new LinkTooLong();
  return payload;
}

/**
 * A leg's interior vertices, simplified and on the 1e-5° grid.
 *
 * Quantised after simplifying, and repeats dropped: two vertices a metre apart can land on
 * one grid point, and a zero delta is two wasted bytes that draw nothing.
 */
function interiorVertices(coords: readonly LngLat[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lng, lat] of simplify(coords, SIMPLIFY_TOLERANCE_M).slice(1, -1)) {
    const x = Math.round(lng * VERTEX_SCALE);
    const y = Math.round(lat * VERTEX_SCALE);
    const previous = out[out.length - 1];
    if (!previous || previous[0] !== x || previous[1] !== y) out.push([x, y]);
  }
  return out;
}

/**
 * Ramer–Douglas–Peucker in a local metric projection, both ends fixed.
 *
 * An explicit stack: a recorded GPX track can be tens of thousands of vertices, and the
 * recursive form can run out of call stack on one that defeats the midpoint split.
 */
export function simplify(coords: readonly LngLat[], toleranceM: number): LngLat[] {
  if (coords.length <= 2) return [...coords];

  const metresPerLat = 111_320;
  const metresPerLng = metresPerLat * Math.cos((coords[0][1] * Math.PI) / 180);
  const x = (index: number) => coords[index][0] * metresPerLng;
  const y = (index: number) => coords[index][1] * metresPerLat;

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let furthest = -1;
    let furthestM = toleranceM;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(x(i), y(i), x(first), y(first), x(last), y(last));
      if (distance > furthestM) {
        furthest = i;
        furthestM = distance;
      }
    }
    if (furthest !== -1) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }

  return coords.filter((_, index) => keep[index] === 1);
}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// --- Reading --------------------------------------------------------------------------

class ByteReader {
  private readonly bytes: Uint8Array;
  private readonly end: number;
  private offset = 0;

  constructor(bytes: Uint8Array, end: number) {
    this.bytes = bytes;
    this.end = end;
  }

  get finished(): boolean {
    return this.offset === this.end;
  }

  byte(): number {
    if (this.offset >= this.end) throw new LinkDamaged('it ends too soon');
    return this.bytes[this.offset++];
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    // Six bytes is past anything a valid link holds, and stops well short of the point
    // where a double loses integers.
    for (let i = 0; i < 6; i++) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
    throw new LinkDamaged('a number in it is too long');
  }

  signed(): number {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  text(maxBytes: number): string {
    const length = this.varint();
    if (length > maxBytes) throw new LinkDamaged('a name in it is too long');
    if (this.offset + length > this.end) throw new LinkDamaged('it ends too soon');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    try {
      return cleanName(new TextDecoder('utf-8', { fatal: true }).decode(slice));
    } catch {
      throw new LinkDamaged('a name in it is not text');
    }
  }
}

/**
 * Read a link's payload.
 *
 * Treated as untrusted from the first byte, the same rule as imported GPX and OSM names:
 * the checksum only proves the link arrived as it was sent, and anyone can compute one.
 * Everything is bounded and range-checked, and one bad field refuses the whole link.
 */
export function decodeRouteLink(payload: string): ReceivedRoute {
  if (payload.length > MAX_PAYLOAD_CHARS) throw new LinkDamaged('it is too long');
  const bytes = fromBase64Url(payload);
  if (bytes.length < 6) throw new LinkDamaged('it ends too soon');

  // Version first: a later format might checksum differently, and "update ratmap" is the
  // true answer for it where "damaged" would send someone asking for the link again.
  if (bytes[0] !== FORMAT_VERSION) throw new LinkTooNew();

  const end = bytes.length - 4;
  const expected = new DataView(bytes.buffer, bytes.byteOffset).getUint32(end, true);
  if (crc32(bytes.subarray(0, end)) !== expected) throw new LinkDamaged('its checksum does not match');

  const reader = new ByteReader(bytes, end);
  reader.byte();
  const flags = reader.byte();
  if (flags & ~KNOWN_FLAGS || !(flags & FLAG_GEOMETRY)) throw new LinkTooNew();

  const name = reader.text(MAX_ROUTE_NAME_BYTES) || 'Shared route';

  const count = reader.varint();
  if (count < 2 || count > MAX_WAYPOINTS) throw new LinkDamaged('it has the wrong number of waypoints');

  const waypoints: Waypoint[] = [];
  let lng = 0;
  let lat = 0;
  for (let i = 0; i < count; i++) {
    lng += reader.signed();
    lat += reader.signed();
    const point = checkedPoint(lng / WAYPOINT_SCALE, lat / WAYPOINT_SCALE);
    const label = reader.text(MAX_WAYPOINT_NAME_BYTES);
    waypoints.push({
      id: newWaypointId(),
      lng: point[0],
      lat: point[1],
      ...(label ? { name: label } : {}),
    });
  }

  const legs: ComputedLeg[] = [];
  let vertices = 0;
  for (let i = 0; i < count - 1; i++) {
    const kind = reader.byte();
    if (kind !== LEG_SNAPPED && kind !== LEG_STRAIGHT && kind !== LEG_FREEHAND) {
      throw new LinkDamaged('a leg in it is of an unknown kind');
    }
    const distanceM = reader.varint() / DISTANCE_SCALE;

    const interior = reader.varint();
    vertices += interior;
    if (vertices > MAX_VERTICES) throw new LinkDamaged('it has too many points');

    const start = waypoints[i];
    const coords: LngLat[] = [[start.lng, start.lat]];
    let x = Math.round(start.lng * VERTEX_SCALE);
    let y = Math.round(start.lat * VERTEX_SCALE);
    for (let v = 0; v < interior; v++) {
      x += reader.signed();
      y += reader.signed();
      coords.push(checkedPoint(x / VERTEX_SCALE, y / VERTEX_SCALE));
    }
    const finish = waypoints[i + 1];
    coords.push([finish.lng, finish.lat]);

    if (!distanceFits(distanceM, pathLengthMetres(coords))) {
      throw new LinkDamaged('a leg’s distance does not match its line');
    }

    if (kind === LEG_FREEHAND) finish.freehand = true;
    legs.push({
      coords,
      distanceM,
      kind: kind === LEG_SNAPPED ? 'snapped' : 'straight',
      wayNames: [],
      ...(kind === LEG_FREEHAND ? { freehand: true as const } : {}),
    });
  }

  let stats: SenderStats | null = null;
  if (flags & FLAG_STATS) {
    const ascentM = reader.varint();
    const descentM = reader.varint();
    if (ascentM > MAX_STAT_M || descentM > MAX_STAT_M) throw new LinkDamaged('its climb is out of range');
    stats = { ascentM, descentM };
  }

  if (!reader.finished) throw new LinkDamaged('it has bytes left over');

  return {
    name,
    coords: legs.flatMap((leg, index) => (index === 0 ? leg.coords : leg.coords.slice(1))),
    waypoints,
    legs,
    stats,
  };
}

function checkedPoint(lng: number, lat: number): LngLat {
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new LinkDamaged('a point in it is off the map');
  return [lng, lat];
}

/**
 * Whether a carried distance can belong to this line.
 *
 * The figure on screen comes from the link, because simplifying always shortens the line
 * (§2.1) — but a link is untrusted, and a distance nothing checks would put any number at
 * all in front of someone planning a day on it. The margin covers simplification, which
 * measured 0.35% at 2 m, and the grid's jitter, which can go either way on a short leg.
 */
function distanceFits(carriedM: number, lineM: number): boolean {
  return carriedM >= lineM * 0.95 - 20 && carriedM <= lineM * 1.25 + 100;
}

/** Control characters and bidi overrides: a name must not be able to reorder the UI's text. */
function cleanName(name: string): string {
  return name.replace(/[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu, '').trim();
}

// --- URLs -----------------------------------------------------------------------------

/** The link for a payload. Built from where the app is running, never a hardcoded host. */
export function routeLinkUrl(payload: string): string {
  return `${location.origin}${import.meta.env.BASE_URL}#${PAYLOAD_KEY}${payload}`;
}

/** The payload in a URL fragment, or null if it holds none. */
export function payloadFromHash(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of fragment.split('&')) {
    if (part.startsWith(PAYLOAD_KEY)) return part.slice(PAYLOAD_KEY.length);
  }
  return null;
}

/**
 * The payload in pasted text, or null if the text is not a route link.
 *
 * Any origin counts: only the fragment matters, so a link from an address ratmap has since
 * moved away from still opens when pasted in.
 */
export function payloadFromText(text: string): string | null {
  const trimmed = text.trim();
  const hash = trimmed.indexOf('#');
  if (hash === -1) return null;
  return payloadFromHash(trimmed.slice(hash));
}

// --- Bytes ----------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new LinkDamaged('it has characters that do not belong');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new LinkDamaged('it is cut off mid-character');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
