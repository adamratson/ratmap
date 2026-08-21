import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const R2_ARTIFACT_VARS = [
  'VITE_R2_BASE_URL',
  'VITE_BASEMAP_PMTILES_URL',
  'VITE_TERRAIN_PMTILES_URL',
  'VITE_PEAKS_PMTILES_URL',
  'VITE_FALLBACK_TERRAIN_URL',
  'VITE_USE_FALLBACK_TERRAIN',
] as const;

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    // Explicitly cleared, not merely "not set": a developer's .env.local is loaded by
    // Vitest too, and would otherwise make these assert whatever happens to be configured
    // on this machine rather than the committed defaults.
    for (const name of R2_ARTIFACT_VARS) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults every artifact to our own R2 bucket (C15 — we serve our own copies)', async () => {
    const config = await import('./config');

    for (const url of [
      config.BASEMAP_PMTILES_URL,
      config.TERRAIN_PMTILES_URL,
      config.PEAKS_PMTILES_URL,
    ]) {
      expect(url).toMatch(/^https:\/\/.+\.pmtiles$/);
      // Must not point at Protomaps'/Mapterhorn's buckets — C15 says copy, don't hotlink.
      expect(url).not.toMatch(/protomaps\.com|source\.coop|mapterhorn\.com/);
    }
  });

  it('lets VITE_R2_BASE_URL move every artifact at once (Phase 3 custom domain swap)', async () => {
    vi.stubEnv('VITE_R2_BASE_URL', 'https://tiles.example.com');

    const config = await import('./config');

    expect(config.BASEMAP_PMTILES_URL).toMatch(/^https:\/\/tiles\.example\.com\//);
    expect(config.TERRAIN_PMTILES_URL).toMatch(/^https:\/\/tiles\.example\.com\//);
    expect(config.PEAKS_PMTILES_URL).toMatch(/^https:\/\/tiles\.example\.com\//);
  });

  it('lets a single artifact be overridden without moving the others', async () => {
    vi.stubEnv('VITE_PEAKS_PMTILES_URL', 'https://example.com/my-peaks.pmtiles');

    const config = await import('./config');

    expect(config.PEAKS_PMTILES_URL).toBe('https://example.com/my-peaks.pmtiles');
    expect(config.BASEMAP_PMTILES_URL).not.toContain('example.com');
  });

  it('keeps the AWS terrarium fallback opt-in, off by default', async () => {
    const off = await import('./config');
    expect(off.USE_FALLBACK_TERRAIN).toBe(false);
    expect(off.FALLBACK_TERRAIN_RASTER_DEM_URL).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    );

    vi.resetModules();
    vi.stubEnv('VITE_USE_FALLBACK_TERRAIN', '1');
    const on = await import('./config');
    expect(on.USE_FALLBACK_TERRAIN).toBe(true);
  });

  it('caps zooms to what the catalog-only extracts actually contain (§8.2)', async () => {
    const config = await import('./config');
    // Requesting above an archive's real maxzoom makes the layer silently disappear
    // rather than overzoom, so these must match the built artifacts.
    expect(config.BASEMAP_MAX_ZOOM).toBe(5);
    expect(config.TERRAIN_MAX_ZOOM).toBe(4);
    expect(config.PEAKS_MAX_ZOOM).toBe(5);
  });

  it('exposes local (C7-vendored) glyph/sprite URLs as origin-qualified absolute URLs', async () => {
    const config = await import('./config');
    const originBase = `${window.location.origin}${import.meta.env.BASE_URL}`;
    // MapLibre rejects a root-relative sprite URL outright (see comment in config.ts) —
    // this is the regression test for that, not just a value check.
    expect(config.GLYPHS_URL).toBe(`${originBase}fonts/{fontstack}/{range}.pbf`);
    expect(config.SPRITE_URL).toBe(`${originBase}sprites/light`);
    expect(config.SPRITE_URL).toMatch(/^https?:\/\//);
  });
});
