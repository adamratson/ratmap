import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project site: served at https://<user>.github.io/ratmap/, not the
// domain root. Applies to `vite build` and `vite preview` — dev and `vitest` keep base
// '/' so `npm run dev` still serves from http://localhost:5173/ directly. `isPreview` is
// required alongside `command === 'build'`: preview's own `command` is 'serve', not
// 'build' (only `isPreview` distinguishes it) — get this wrong and `vite preview` serves
// with base '/' while the already-built dist/ files reference /ratmap/, so every asset
// request 404s (well, silently falls back to index.html — SPA fallback masks it as an
// odd hang, not a clean error). Verified by hitting exactly this bug during Phase 1 asset
// vendoring (2026-08-21).
const GH_PAGES_BASE = '/ratmap/';

// Service worker caches the app shell only (C5). Tile archives (.pmtiles) live in
// OPFS, never in the SW Cache API — do not add runtime caching rules for them here.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? GH_PAGES_BASE : '/',
  test: {
    environment: 'jsdom',
    // `test/` holds the node-side tests — the ones that read built artifacts off disk.
    // They are typechecked by tsconfig.e2e.json, which is the config that has node types;
    // the app's own tsconfig deliberately does not.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'ratmap',
        short_name: 'ratmap',
        description: 'Offline-first OpenStreetMap mountain map',
        // start_url / scope / id deliberately omitted: vite-plugin-pwa derives them
        // from the resolved `base` above. Hardcoding '/ratmap/' here too would just
        // be a second place for that path to go stale.
        display: 'standalone',
        background_color: '#1e293b',
        theme_color: '#1e293b',
        icons: [
          // Relative (no leading slash): resolved against the manifest's own URL,
          // so these survive being served from a subpath instead of the origin root.
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell precache only — see module comment. pbf/json/png added alongside
        // js/css/html/svg so the vendored glyphs (C7) and sprites actually precache;
        // without this, "vendored locally" would still mean "missing offline" the
        // first time the app boots with no network, since only globPatterns-matched
        // build output gets into the precache manifest.
        //
        // wasm + sqlite are here for offline search (C9): the SQLite WASM runtime and
        // the FTS5 index both have to be cached, or search silently fails on a cold
        // offline start — exactly what Phase 2's acceptance test checks.
        globPatterns: ['**/*.{js,css,html,svg,pbf,png,json,wasm,sqlite}'],
        // Default is 2 MiB, which silently drops the sqlite index and the wasm runtime
        // from the precache manifest. Raised to cover them; still app-shell only —
        // .pmtiles archives go to OPFS, never here (C5).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
}));
