import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the update strategy at the point where it is actually decided: the generated
// worker. Every part of it is a build-time switch in vite.config.ts, so a one-word edit
// there — `registerType: 'autoUpdate'` — silently restores the behaviour src/update.ts
// exists to avoid, with nothing at runtime to notice. That is precisely the kind of
// regression this repo keeps hitting, so it gets a test rather than a comment.
//
// Reads real build output, like archive-route.test.ts, and skips when there is none.
// CI builds before it tests so this runs there.
const SW = 'dist/sw.js';
const INDEX = 'dist/index.html';

function appBundle(): string {
  const dir = 'dist/assets';
  const entry = readdirSync(dir).find((f) => f.startsWith('index-') && f.endsWith('.js'));
  if (!entry) throw new Error(`No index-*.js in ${dir}`);
  return readFileSync(`${dir}/${entry}`, 'utf8');
}

describe.skipIf(!existsSync(SW))('the generated service worker', () => {
  it('waits to be asked before taking over', () => {
    // workbox emits this message listener only when built with `skipWaiting: false`; with
    // skipWaiting it emits a bare `self.skipWaiting()` and no listener at all. So the
    // presence of the literal is an exact read on which of the two was built — and the
    // whole staged-update design rests on it, because a worker that activates on its own
    // lets cleanupOutdatedCaches() delete the precache under a page still running the old
    // bundle, and takes an in-flight region download with it (C12).
    expect(readFileSync(SW, 'utf8')).toContain('SKIP_WAITING');
  });

  it('is registered by the app, not by an injected script', () => {
    // vite-plugin-pwa's own registerSW.js registers and then never checks again — no
    // polling, no reload — which is the gap src/update.ts fills. Two registrars would
    // also race each other over the same scope.
    expect(existsSync('dist/registerSW.js')).toBe(false);
    expect(readFileSync(INDEX, 'utf8')).not.toContain('registerSW.js');
    expect(appBundle()).toContain('sw.js');
  });

  it('registers with the HTTP cache bypassed for the worker and its imports', () => {
    expect(appBundle()).toMatch(/updateViaCache:\s*[`'"]none[`'"]/);
  });
});
