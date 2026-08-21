// Tile/data artifact locations. Phase 1 built these into our own R2 bucket
// (infra/scripts/build-*.sh + upload.sh); C15 — we serve our own copies, never hotlink
// Protomaps' or Mapterhorn's buckets.
//
// R2_BASE defaults to the bucket's public .r2.dev development URL. That host is
// rate-limited and explicitly not for production traffic — Phase 3 swaps in a custom
// domain by setting VITE_R2_BASE_URL, no code change needed here.
const R2_BASE =
  import.meta.env.VITE_R2_BASE_URL ?? 'https://pub-1a40001ed7db4ec58589d03151a30bad.r2.dev';

// C13: artifact filenames carry their build date, so a refresh is an explicit, reviewable
// change here rather than a silent "latest" that can shift schema under us. C3: these are
// also the registry keys, so they must stay globally unique.
export const BASEMAP_PMTILES_URL =
  import.meta.env.VITE_BASEMAP_PMTILES_URL ?? `${R2_BASE}/world-catalog-2026-08-21.pmtiles`;

export const TERRAIN_PMTILES_URL =
  import.meta.env.VITE_TERRAIN_PMTILES_URL ?? `${R2_BASE}/terrain-global-2026-08-21.pmtiles`;

export const PEAKS_PMTILES_URL =
  import.meta.env.VITE_PEAKS_PMTILES_URL ?? `${R2_BASE}/peaks-global.pmtiles`;

// The world catalog is a deliberately low-zoom extract (§8.2 catalog-only): it holds
// z0-5 only, so MapLibre must be told to overzoom rather than request tiles that do not
// exist. Per-region archives (Phase 4) supply real detail above this.
export const BASEMAP_MAX_ZOOM = 5;

// terrain-global is likewise a coarse z0-4 extract — enough for context hillshade, not
// for a real elevation profile. Phase 4 region terrain replaces it locally.
export const TERRAIN_MAX_ZOOM = 4;

// Peaks are points; tippecanoe chose z0-5 for the current (Scotland-only) build. Overzoom
// so markers stay visible when zoomed past the archive's own maxzoom.
export const PEAKS_MAX_ZOOM = 5;

// AWS Open Data terrarium terrain — the plan's documented §2 fallback. Kept as an opt-in
// escape hatch (VITE_USE_FALLBACK_TERRAIN=1) now that our own terrain archive works, so
// there's a one-flag way to isolate "is this our archive or MapLibre?" when debugging.
export const FALLBACK_TERRAIN_RASTER_DEM_URL =
  import.meta.env.VITE_FALLBACK_TERRAIN_URL ??
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const USE_FALLBACK_TERRAIN = import.meta.env.VITE_USE_FALLBACK_TERRAIN === '1';

export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
export const TERRAIN_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a>';

// The FTS5 search index (C9). Shipped in public/ and precached by the service worker
// rather than fetched from R2, because Phase 2's acceptance test requires search to work
// on a cold offline start — an R2 fetch would need its own download+cache flow to survive
// that. §3 puts the places index in OPFS long-term; Phase 4 moves it there per-region,
// at which point this becomes the fallback for "no region downloaded yet".
// Refresh with: infra/scripts/build-places.sh && cp infra/dist/places.sqlite public/data/
export const PLACES_DB_URL = `${window.location.origin}${import.meta.env.BASE_URL}data/places.sqlite`;

// C7: vendored locally (infra/scripts/vendor-assets.sh) into public/fonts, public/sprites
// — Regular/Italic/Medium only, matching the app's current {lang:'en'} usage in main.ts.
// Origin-qualified, not left root-relative: MapLibre's style spec requires an *absolute*
// sprite URL and rejects a root-relative one outright ("Invalid sprite URL ..., must be
// absolute") — verified by hitting exactly that error during Phase 1 (2026-08-21).
//
// Plain string concatenation, deliberately not new URL(...): GLYPHS_URL's {fontstack}/
// {range} are literal placeholder tokens MapLibre substitutes itself — confirmed
// new URL('/x/{fontstack}/{range}.pbf', origin) percent-encodes the braces to %7B/%7D,
// which would silently break that substitution (glyph requests hitting the wrong path).
const ORIGIN_BASE = `${window.location.origin}${import.meta.env.BASE_URL}`;
export const GLYPHS_URL = `${ORIGIN_BASE}fonts/{fontstack}/{range}.pbf`;
export const SPRITE_URL = `${ORIGIN_BASE}sprites/light`;
