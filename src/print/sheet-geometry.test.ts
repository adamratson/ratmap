import { describe, expect, it } from 'vitest';
import {
  DETAIL_BOOST,
  MAP_CSS_PX_PER_MM,
  MARGIN_MM,
  formatScale,
  groundSize,
  mapCssPx,
  mapMmFromCssPx,
  metresPerCssPx,
  parallelCircumference,
  scaleBar,
  sheetLayout,
  zoomForScale,
} from './sheet-geometry';

describe('sheetLayout', () => {
  it('fits the map and footer inside the margins of an A4 page', () => {
    for (const orientation of ['portrait', 'landscape'] as const) {
      const { page, map, footer } = sheetLayout(orientation);
      expect(page.w * page.h).toBe(210 * 297);
      expect(map.x).toBe(MARGIN_MM);
      expect(footer.y + footer.h).toBe(page.h - MARGIN_MM);
      expect(map.x + map.w).toBe(page.w - MARGIN_MM);
    }
    expect(sheetLayout('portrait').page).toEqual({ w: 210, h: 297 });
    expect(sheetLayout('landscape').page).toEqual({ w: 297, h: 210 });
  });

  it('never makes the map wider than its margin, only a fraction of a mm narrower', () => {
    for (const orientation of ['portrait', 'landscape'] as const) {
      const layout = sheetLayout(orientation);
      const css = mapCssPx(layout);
      const w = mapMmFromCssPx(css.w);
      expect(w).toBeLessThanOrEqual(layout.map.w);
      expect(layout.map.w - w).toBeLessThan(1 / MAP_CSS_PX_PER_MM);
    }
  });
});

describe('parallelCircumference', () => {
  it('is the WGS84 equator at 0°, and nothing at the pole', () => {
    expect(parallelCircumference(0)).toBeCloseTo(40_075_016.686, 2);
    expect(parallelCircumference(90)).toBeCloseTo(0, 6);
  });

  it('is longer than the sphere would give at mid-latitudes (prime-vertical radius)', () => {
    const sphere = 2 * Math.PI * 6_371_008.8 * Math.cos((56.8 * Math.PI) / 180);
    const ratio = parallelCircumference(56.8) / sphere;
    expect(ratio).toBeGreaterThan(1.003);
    expect(ratio).toBeLessThan(1.005);
  });
});

describe('zoomForScale', () => {
  it('makes a mm of paper cover `scale` mm of ground, east-west at the centre', () => {
    for (const lat of [0, 46.5, 56.8, -43.6]) {
      for (const scale of [25_000, 50_000] as const) {
        const z = zoomForScale(scale, lat);
        const groundMetresPerPaperMm = metresPerCssPx(z, lat) * MAP_CSS_PX_PER_MM;
        expect(groundMetresPerPaperMm).toBeCloseTo(scale / 1000, 9);
      }
    }
  });

  it('renders DETAIL_BOOST zooms above the screen-sized zoom for the same scale', () => {
    // At screen symbol sizes, 1:25 000 in Scotland is z12.665 — under the z13 where every
    // contour is drawn. The boost is what brings the detail onto the paper.
    expect(zoomForScale(25_000, 56.8)).toBeCloseTo(12.665 + DETAIL_BOOST, 3);
    expect(zoomForScale(50_000, 56.8)).toBeCloseTo(11.665 + DETAIL_BOOST, 3);
  });

  it('halving the scale is exactly one zoom level', () => {
    expect(zoomForScale(25_000, 50) - zoomForScale(50_000, 50)).toBeCloseTo(1, 12);
  });
});

describe('groundSize', () => {
  it('covers about 4.7 × 6.6 km on a portrait 1:25 000 sheet', () => {
    const ground = groundSize(sheetLayout('portrait'), 25_000);
    expect(ground.w).toBeCloseTo(4750, -1);
    expect(ground.h).toBeCloseTo(6575, -1);
  });
});

describe('scaleBar', () => {
  it('picks a round length and gives its true printed length', () => {
    expect(scaleBar(25_000, 40)).toEqual({ metres: 1000, mm: 40, divisions: 5 });
    expect(scaleBar(50_000, 40)).toEqual({ metres: 2000, mm: 40, divisions: 4 });
  });
});

describe('formatScale', () => {
  it('groups thousands with a thin space', () => {
    expect(formatScale(25_000)).toBe('1:25 000');
  });
});
