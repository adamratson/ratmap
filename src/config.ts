// Phase 0 placeholders only. Both defaults point at third-party demo/public data —
// neither is ours, neither is pinned, and the basemap default has been observed
// returning 404 directly from Protomaps' own bucket (confirmed via curl on 2026-08-20,
// see docs/IMPLEMENTATION.md C13). Phase 1 replaces both with our own pinned,
// R2-hosted builds. Override locally via .env.local without touching this file.

export const DEMO_BASEMAP_PMTILES_URL =
  import.meta.env.VITE_DEMO_BASEMAP_PMTILES_URL ??
  'https://demo-bucket.protomaps.com/v4.pmtiles';

// AWS Open Data terrarium terrain — the plan's explicit fallback (§2) for online
// hillshade when a pmtiles-hosted raster-dem source isn't available yet.
export const FALLBACK_TERRAIN_RASTER_DEM_URL =
  import.meta.env.VITE_FALLBACK_TERRAIN_URL ??
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Vendor locally per C7 before this ships offline (Phase 1). Remote for now.
export const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
export const SPRITE_URL = 'https://protomaps.github.io/basemaps-assets/sprites/v4/light';
