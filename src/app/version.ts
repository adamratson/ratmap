// Build identity, stamped in by vite.config.ts.
//
// Derived from the git commit rather than the build clock on purpose: it ends up inside
// the JS bundle, so it changes the bundle hash, which changes the precache manifest,
// which is what makes the service worker consider itself a new version. A timestamp would
// therefore declare a "new version" on every rebuild of an unchanged commit — every user
// reloading for nothing. A commit sha declares one exactly when the code differs.
//
// `typeof` rather than a bare reference so this still resolves if the define is missing
// (a bare `__APP_VERSION__` would throw a ReferenceError at import time and take the whole
// app down over a version string).
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
