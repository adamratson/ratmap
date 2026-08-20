import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the documented Protomaps demo bucket and AWS terrarium URLs when unset', async () => {
    const config = await import('./config');
    expect(config.DEMO_BASEMAP_PMTILES_URL).toBe('https://demo-bucket.protomaps.com/v4.pmtiles');
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

  it('exposes the C7 glyph/sprite URLs used to symbolize the demo basemap', async () => {
    const config = await import('./config');
    expect(config.GLYPHS_URL).toBe(
      'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    );
    expect(config.SPRITE_URL).toBe('https://protomaps.github.io/basemaps-assets/sprites/v4/light');
  });
});
