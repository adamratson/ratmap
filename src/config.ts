// Phase 0 placeholders only. Both defaults point at third-party demo/public data —
// neither is ours, neither is pinned. Phase 1 replaces both with our own pinned,
// R2-hosted builds (C13, C15 — this is fine for local dev, not for production).
// Override locally via .env.local without touching this file.

// Protomaps' own demo-bucket.protomaps.com/v4.pmtiles (used in all their official
// examples) 404s as of 2026-08-20 — confirmed via curl and in-browser (see
// docs/IMPLEMENTATION.md C13 for what that failure looks like). This points at their
// Source Cooperative mirror instead (data.source.coop/protomaps/openstreetmap/v4.pmtiles,
// documented at docs.protomaps.com/basemaps/downloads), confirmed live: 206 Partial
// Content on a Range request, CORS allow-origin: *. It's a ~135 GB planet archive, but
// PMTiles range-fetches only the tiles a viewport needs, so that's fine for browsing.
export const DEMO_BASEMAP_PMTILES_URL =
  import.meta.env.VITE_DEMO_BASEMAP_PMTILES_URL ??
  'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';

// AWS Open Data terrarium terrain — the plan's explicit fallback (§2) for online
// hillshade when a pmtiles-hosted raster-dem source isn't available yet.
export const FALLBACK_TERRAIN_RASTER_DEM_URL =
  import.meta.env.VITE_FALLBACK_TERRAIN_URL ??
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Vendor locally per C7 before this ships offline (Phase 1). Remote for now.
export const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
export const SPRITE_URL = 'https://protomaps.github.io/basemaps-assets/sprites/v4/light';
