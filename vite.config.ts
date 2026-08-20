import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project site: served at https://<user>.github.io/ratmap/, not the
// domain root. Only applies to `vite build` — dev and `vitest` keep base '/' so
// `npm run dev` still serves from http://localhost:5173/ directly.
const GH_PAGES_BASE = '/ratmap/';

// Service worker caches the app shell only (C5). Tile archives (.pmtiles) live in
// OPFS, never in the SW Cache API — do not add runtime caching rules for them here.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? GH_PAGES_BASE : '/',
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
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
        // App shell precache only — see module comment.
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
}));
