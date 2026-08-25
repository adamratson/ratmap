// Geometry primitives shared by the route planner, the elevation profile and route
// following. No dependencies — everything here is pure maths over [lng, lat] pairs so it
// stays unit-testable without a Map instance.
//
// Coordinates are GeoJSON order ([lng, lat]) throughout, because that is what MapLibre
// sources, GPX export and the vector tiles all speak. Mixing the two orders is the
// classic silent bug in this kind of code, so there is exactly one convention.

/** [lng, lat] — GeoJSON order, degrees. */
export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the cheaper equirectangular approximation: leg lengths accumulate
 * into the total distance a walker plans their day around, and this is not on a hot path
 * — the hot path (nearest-point search) uses the local projection below instead.
 */
export function distanceMetres(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const dLat = lat2 - lat1;
  const dLng = (b[0] - a[0]) * DEG;

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline in metres. */
export function pathLengthMetres(coords: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distanceMetres(coords[i - 1], coords[i]);
  return total;
}

/**
 * A local metre-space projection centred on `origin`.
 *
 * Nearest-point search runs this over thousands of vertices per query, where haversine
 * per candidate is wasteful and — worse — cannot be used for the perpendicular projection
 * onto a segment at all. Over the few kilometres a snap radius or a route leg spans, a
 * plane tangent at the origin is accurate to well under a metre.
 */
function projector(origin: LngLat): (p: LngLat) => [number, number] {
  const lngScale = Math.cos(origin[1] * DEG) * EARTH_RADIUS_M * DEG;
  const latScale = EARTH_RADIUS_M * DEG;
  return (p) => [(p[0] - origin[0]) * lngScale, (p[1] - origin[1]) * latScale];
}

export interface NearestOnPath {
  /** The projected point itself. */
  point: LngLat;
  /** Perpendicular distance from the query point, metres. */
  distanceM: number;
  /** Index of the segment's first vertex. */
  segmentIndex: number;
  /** Position along that segment, 0..1. */
  t: number;
  /** Distance from the start of the path to `point`, metres. */
  alongM: number;
}

/**
 * Closest point on a polyline to `query`.
 *
 * Returns the point *on a segment*, not the nearest vertex: for route following, snapping
 * to vertices would report a walker as off-route by up to half a segment length while they
 * are standing squarely on the line.
 */
export function nearestPointOnPath(coords: readonly LngLat[], query: LngLat): NearestOnPath | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    return {
      point: coords[0],
      distanceM: distanceMetres(coords[0], query),
      segmentIndex: 0,
      t: 0,
      alongM: 0,
    };
  }

  const project = projector(query);
  const q: [number, number] = [0, 0];

  let best: NearestOnPath | null = null;
  let travelled = 0;

  for (let i = 1; i < coords.length; i++) {
    const a = project(coords[i - 1]);
    const b = project(coords[i]);
    const segLength = Math.hypot(b[0] - a[0], b[1] - a[1]);

    // Degenerate (duplicate) vertices are common in tile geometry after quantisation;
    // treat them as the point itself rather than dividing by zero.
    const t =
      segLength === 0
        ? 0
        : clamp(
            ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (segLength * segLength),
            0,
            1,
          );

    const cx = a[0] + (b[0] - a[0]) * t;
    const cy = a[1] + (b[1] - a[1]) * t;
    const distanceM = Math.hypot(cx - q[0], cy - q[1]);

    if (!best || distanceM < best.distanceM) {
      best = {
        point: [
          coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
          coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
        ],
        distanceM,
        segmentIndex: i - 1,
        t,
        alongM: travelled + segLength * t,
      };
    }

    travelled += segLength;
  }

  return best;
}

/** The point `distanceM` along a polyline, clamped to its ends. */
export function pointAlongPath(coords: readonly LngLat[], distanceM: number): LngLat | null {
  if (coords.length === 0) return null;
  if (distanceM <= 0) return coords[0];

  let remaining = distanceM;
  for (let i = 1; i < coords.length; i++) {
    const segment = distanceMetres(coords[i - 1], coords[i]);
    if (segment >= remaining) {
      const t = segment === 0 ? 0 : remaining / segment;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ];
    }
    remaining -= segment;
  }

  return coords[coords.length - 1];
}

/**
 * Insert intermediate vertices so no segment exceeds `spacingM`.
 *
 * The elevation profile needs this. A straight leg drawn across a corrie may be a single
 * two-point segment, and sampling only its endpoints would report a flat crossing of a
 * 300 m deep glen — an ascent total that is wrong in the direction that gets someone into
 * trouble.
 */
export function densify(coords: readonly LngLat[], spacingM: number): LngLat[] {
  if (coords.length < 2 || !(spacingM > 0)) return [...coords];

  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const steps = Math.ceil(distanceMetres(a, b) / spacingM);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

export type Bbox = [number, number, number, number];

/** Bounding box of a set of points, as [west, south, east, north]. */
export function boundsOf(points: readonly LngLat[], padM = 0): Bbox | null {
  if (points.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  if (padM > 0) {
    const latPad = padM / (EARTH_RADIUS_M * DEG);
    // Guard the cosine: at the poles the longitude pad would explode to infinity.
    const cos = Math.max(0.01, Math.cos(((north + south) / 2) * DEG));
    const lngPad = latPad / cos;
    west -= lngPad;
    east += lngPad;
    south -= latPad;
    north += latPad;
  }

  return [west, south, east, north];
}

export function bboxContains(bbox: Bbox, point: LngLat): boolean {
  return (
    point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Human-readable distance: metres below a kilometre, kilometres above. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 2 : 1)} km`;
}

/** Compass points, coarse enough to be useful at a glance and read aloud. */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Rough compass direction from `from` to `to`.
 *
 * Eight points, not sixteen: this answers "which way is it", and nobody navigates off a
 * search result. Computed on the equirectangular approximation the search index already
 * ranks with, which is accurate enough for a bearing over the distances involved.
 */
export function compassBearing(from: LngLat, to: LngLat): string {
  const scale = Math.cos((from[1] * Math.PI) / 180);
  const east = (to[0] - from[0]) * scale;
  const north = to[1] - from[1];
  if (east === 0 && north === 0) return 'here';

  const degrees = (Math.atan2(east, north) * 180) / Math.PI;
  const index = Math.round(((degrees + 360) % 360) / 45) % COMPASS.length;
  return COMPASS[index];
}
