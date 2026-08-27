import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the *production build*, not the dev server: the things
// worth testing here — service-worker precaching, offline cold starts, the /ratmap/ base
// path — only exist in a real build. `vite preview` serves exactly what deploys.
const PORT = 5210;
const BASE_PATH = '/ratmap/';

export default defineConfig({
  testDir: './e2e',
  // Region downloads are tens of MB over the network; the default 30 s is not enough.
  // Comfortably above the downloader's own limit in e2e/helpers.ts, so a slow bucket
  // surfaces as that helper's explanatory error rather than as a bare test timeout.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // Serial by default: these tests share OPFS and a service worker per origin, so
  // running them in parallel would have them fight over the same downloaded region.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
