import type { ElevationProfile } from './profile';
import { formatDistance } from './geo';

// The elevation profile as an inline SVG.
//
// SVG rather than canvas: it scales with the panel, works with the app's CSS, and needs no
// device-pixel-ratio handling to stay sharp on a phone. The whole chart is a handful of
// path elements, so there is nothing here a canvas would do faster.

export interface ChartOptions {
  width?: number;
  height?: number;
  /**
   * Distance along the route to mark as "here", metres. Draws nothing when null/undefined,
   * outside the route, or landing inside a DEM coverage gap — a dot on invented ground
   * would be exactly the kind of confident wrong answer this chart otherwise avoids.
   */
  currentDistanceM?: number | null;
}

/**
 * Render the profile, or null when there is nothing worth drawing.
 *
 * Gaps in DEM coverage break the filled area into separate spans rather than being
 * interpolated across. A profile drawn straight through a hole reads as a gentle slope
 * over ground we have no data for, which is precisely the kind of confident wrong answer
 * this app is built to avoid.
 */
export function renderProfileChart(
  profile: ElevationProfile,
  options: ChartOptions = {},
): SVGSVGElement | null {
  const width = options.width ?? 320;
  const height = options.height ?? 90;
  const points = profile.points.filter((point) => point.ele !== null);
  if (points.length < 2 || profile.minEle === null || profile.maxEle === null) return null;

  const totalM = profile.points[profile.points.length - 1]?.distanceM ?? 0;
  if (totalM <= 0) return null;

  // A flat route would otherwise divide by a zero range and collapse to a line at the top.
  const low = profile.minEle;
  const high = profile.maxEle;
  const range = Math.max(1, high - low);

  const x = (distanceM: number): number => (distanceM / totalM) * width;
  const y = (ele: number): number => height - ((ele - low) / range) * (height - 8) - 4;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'profile-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `Elevation profile: ${Math.round(low)} to ${Math.round(high)} metres over ${formatDistance(totalM)}`,
  );

  for (const span of contiguousSpans(profile)) {
    const line: string[] = [];
    const area: string[] = [];

    span.forEach((point, index) => {
      const px = x(point.distanceM).toFixed(2);
      const py = y(point.ele!).toFixed(2);
      line.push(`${index === 0 ? 'M' : 'L'}${px},${py}`);
      area.push(`${index === 0 ? 'M' : 'L'}${px},${py}`);
    });

    const first = x(span[0].distanceM).toFixed(2);
    const last = x(span[span.length - 1].distanceM).toFixed(2);
    area.push(`L${last},${height}`, `L${first},${height}`, 'Z');

    svg.append(
      path(area.join(' '), 'profile-area'),
      path(line.join(' '), 'profile-line'),
    );
  }

  if (options.currentDistanceM != null) {
    const ele = elevationAt(profile, options.currentDistanceM);
    if (ele !== null) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      marker.setAttribute('cx', x(options.currentDistanceM).toFixed(2));
      marker.setAttribute('cy', y(ele).toFixed(2));
      marker.setAttribute('r', '4');
      marker.setAttribute('class', 'profile-position');
      svg.append(marker);
    }
  }

  return svg;
}

/**
 * Elevation at an arbitrary distance along the route, interpolated between the two
 * bracketing samples. Null outside the route or when either bracketing sample has no DEM
 * value — see the note on {@link ChartOptions.currentDistanceM}.
 */
function elevationAt(profile: ElevationProfile, distanceM: number): number | null {
  const points = profile.points;
  if (points.length === 0) return null;
  if (distanceM < points[0].distanceM || distanceM > points[points.length - 1].distanceM) {
    return null;
  }

  for (let i = 1; i < points.length; i++) {
    if (points[i].distanceM < distanceM) continue;
    const a = points[i - 1];
    const b = points[i];
    if (a.ele === null || b.ele === null) return null;
    if (b.distanceM === a.distanceM) return a.ele;
    const t = (distanceM - a.distanceM) / (b.distanceM - a.distanceM);
    return a.ele + t * (b.ele - a.ele);
  }

  return points[points.length - 1].ele;
}

function path(d: string, className: string): SVGPathElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  element.setAttribute('d', d);
  element.setAttribute('class', className);
  return element;
}

/** Runs of consecutive samples that have elevation data. */
function contiguousSpans(profile: ElevationProfile): ElevationProfile['points'][] {
  const spans: ElevationProfile['points'][] = [];
  let current: ElevationProfile['points'] = [];

  for (const point of profile.points) {
    if (point.ele === null) {
      if (current.length > 1) spans.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 1) spans.push(current);

  return spans;
}
