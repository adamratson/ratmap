import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the Source Cooperative basemap mirror and AWS terrarium URLs when unset', async () => {
    // Explicitly cleared, not merely "not set": a developer's .env.local (which points at
    // our real R2 bucket) is loaded by Vitest too and would otherwise make this assert
    // whatever happens to be configured locally rather than the actual fallback.
    vi.stubEnv('VITE_DEMO_BASEMAP_PMTILES_URL', undefined);
    vi.stubEnv('VITE_FALLBACK_TERRAIN_URL', undefined);

    const config = await import('./config');
    expect(config.DEMO_BASEMAP_PMTILES_URL).toBe(
      'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles',
    );
    expect(config.FALLBACK_TERRAIN_RASTER_DEM_URL).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    );
  });

  it('prefers VITE_DEMO_BASEMAP_PMTILES_URL / VITE_FALLBACK_TERRAIN_URL when set (.env.local override)', async () => {
    vi.stubEnv('VITE_DEMO_BASEMAP_PMTILES_URL', 'https://example.com/mine.pmtiles');
    vi.stubEnv('VITE_FALLBACK_TERRAIN_URL', 'https://example.com/{z}/{x}/{y}.png');

    const config = await import('./config');

    expect(config.DEMO_BASEMAP_PMTILES_URL).toBe('https://example.com/mine.pmtiles');
    expect(config.FALLBACK_TERRAIN_RASTER_DEM_URL).toBe('https://example.com/{z}/{x}/{y}.png');
  });

  it('exposes local (C7-vendored) glyph/sprite URLs as origin-qualified absolute URLs', async () => {
    const config = await import('./config');
    const originBase = `${window.location.origin}${import.meta.env.BASE_URL}`;
    // MapLibre rejects a root-relative sprite URL outright (§ comment in config.ts) —
    // this is the regression test for that, not just a value check.
    expect(config.GLYPHS_URL).toBe(`${originBase}fonts/{fontstack}/{range}.pbf`);
    expect(config.SPRITE_URL).toBe(`${originBase}sprites/light`);
    expect(config.SPRITE_URL).toMatch(/^https?:\/\//);
  });
});
