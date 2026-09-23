import { execFileSync } from 'node:child_process';
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

/**
 * Build identity, from the commit — see src/app/version.ts for why it is a sha and not a
 * clock. `GITHUB_SHA` first because Actions checks out a detached HEAD; `git` locally.
 * Falls back to 'dev' rather than throwing: a missing version string must not be able to
 * fail a build.
 */
function resolveBuildId(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 8);
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

const BUILD_ID = resolveBuildId();

// Service worker caches the app shell only (C5). Tile archives (.pmtiles) live in
// OPFS, never in the SW Cache API — do not add runtime caching rules for them here.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? GH_PAGES_BASE : '/',
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_ID),
  },
  // Dependencies in chunks of their own, so a deploy that only changes the app leaves them
  // alone. Without this the app was one 1.42 MB chunk, 1.06 MB of it maplibre-gl, and every
  // deploy changed its hash — if only through __APP_VERSION__ above — so every installed
  // phone re-downloaded all of it to pick up an app change. Measured 2026-09-23: the app
  // chunk is now 134 kB, and building with a different __APP_VERSION__ changes that name
  // alone; maplibre (1.03 MB) and vendor (259 kB) keep theirs, so their precache entries
  // stand and the service worker re-fetches only what changed.
  //
  // The CSS splits along the same lines — maplibre's and the fonts' stylesheets load ahead
  // of style.css, in the order main.ts imports them — and the rules are the same, in the
  // same order, as the single stylesheet this replaced.
  //
  // App code has to stay in the entry chunk: test/service-worker.test.ts reads index-*.js
  // for the update wiring, and naming neither group "index" keeps that unambiguous.
  // `codeSplitting` is Rolldown's option (Vite 8.2 / Rolldown 1.2); `manualChunks` still
  // exists there only as a deprecated alias.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl[\\/]/, priority: 2 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    // `test/` holds the node-side tests — the ones that read built artifacts off disk.
    // They are typechecked by tsconfig.e2e.json, which is the config that has node types;
    // the app's own tsconfig deliberately does not.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
  plugins: [
    VitePWA({
      // 'prompt' + `injectRegister: false` means: generate the worker, but let src/app/update.ts
      // own registration and the decision to swap. Not cosmetic — 'autoUpdate' with the
      // default injectRegister forces `workbox.skipWaiting = true` (vite-plugin-pwa
      // resolves this internally), which activates a new worker the moment it installs and
      // lets `cleanupOutdatedCaches()` delete the precache under a page still running the
      // old bundle. See the header comment in src/app/update.ts.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'ratmap',
        short_name: 'ratmap',
        description: 'Offline-first OpenStreetMap mountain map',
        // start_url / scope / id deliberately omitted: vite-plugin-pwa derives them
        // from the resolved `base` above. Hardcoding '/ratmap/' here too would just
        // be a second place for that path to go stale.
        display: 'standalone',
        // Graphite (--surface, night). Android builds its launch screen from this plus
        // the icon, so it matches the icon's own ground. Also in index.html's theme-color
        // meta and src/ui/theme.ts — keep the three in step.
        background_color: '#0e1114',
        theme_color: '#0e1114',
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
        // Stated rather than inherited, because the pair is load-bearing for updates:
        //
        // skipWaiting:false — a new build installs and *waits*. src/app/update.ts posts
        // SKIP_WAITING when reloading is safe, which is the only thing standing between a
        // deploy and a reload in the middle of someone's region download (C12).
        //
        // clientsClaim:true — only bites on a first install, where it lets the worker
        // control the page that registered it without a reload, so the app is offline-
        // ready on the first visit. On an update the worker is waiting, so it claims
        // nothing until asked.
        skipWaiting: false,
        clientsClaim: true,
        // App shell precache only — see module comment. pbf/json/png added alongside
        // js/css/html/svg so the vendored glyphs (C7) and sprites actually precache;
        // without this, "vendored locally" would still mean "missing offline" the
        // first time the app boots with no network, since only globPatterns-matched
        // build output gets into the precache manifest.
        //
        // wasm + sqlite are here for offline search (C9): the SQLite WASM runtime and
        // the FTS5 index both have to be cached, or search silently fails on a cold
        // offline start — exactly what Phase 2's acceptance test checks.
        //
        // woff2 for the chrome's self-hosted fonts (the @fontsource imports in main.ts).
        // Not woff: fontsource emits it as a fallback, but every browser that can run
        // this app picks the woff2 source first, so caching both would only double the
        // download.
        globPatterns: ['**/*.{js,css,html,svg,pbf,png,json,wasm,sqlite,woff2}'],
        // The iOS splash screens are ~230 KB across eleven device sizes, and each device
        // only ever uses one. Precaching all eleven would cost every install, Android
        // included. Not verified on a device: whether iOS re-fetches its splash on an
        // offline launch or keeps the copy it took at Home Screen install. If it
        // re-fetches, an offline launch falls back to the graphite page background,
        // which is what a splash-less launch showed before.
        globIgnores: ['splash/**'],
        // Default is 2 MiB, which silently drops the sqlite index and the wasm runtime
        // from the precache manifest. Raised to cover them; still app-shell only —
        // .pmtiles archives go to OPFS, never here (C5).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
}));
