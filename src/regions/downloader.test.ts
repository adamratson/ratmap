import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegionArtifact } from './manifest';

const opfsMocks = vi.hoisted(() => ({
  hasArtifact: vi.fn(async () => false),
  partialSize: vi.fn(async () => 0),
  appendToPartial: vi.fn(async () => {}),
  finalizePartial: vi.fn(async () => {}),
  deleteArtifact: vi.fn(async () => {}),
  listArtifactNames: vi.fn(async () => new Set<string>()),
  partialName: (filename: string) => `${filename}.part`,
}));

vi.mock('./opfs-store', () => opfsMocks);

const { DownloadCancelled, DownloadStalled, downloadArtifact, fetchChunkWithRetry } =
  await import('./downloader');

// Regression coverage for the "downloads get stuck on mobile" bug: a Range request that
// never resolves or rejects (common on flaky mobile connections — a hung TCP connection,
// not a network error) used to freeze the whole download forever, because a bare fetch()
// has no timeout of its own. fetchChunkWithRetry is the seam that fixes that, so it's
// tested directly rather than through the full downloadArtifact/OPFS stack.

function okResponse(bytes: number): Response {
  return {
    status: 206,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  } as unknown as Response;
}

/**
 * A 206 whose body trickles in: `parts` blocks of `partBytes`, `gapMs` apart.
 *
 * The point of the streaming read is that total transfer time is irrelevant — only
 * silence counts — so this deliberately takes far longer overall than the stall timeout
 * while never once going quiet for that long.
 */
function tricklingResponse(parts: number, partBytes: number, gapMs: number): Response {
  let sent = 0;
  return {
    status: 206,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= parts) return { done: true, value: undefined };
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          sent += 1;
          return { done: false, value: new Uint8Array(partBytes) };
        },
      }),
    },
  } as unknown as Response;
}

/**
 * A 206 whose headers arrive and whose body then never produces a byte.
 *
 * Rejects on abort like a real body stream does — a reader that merely never settles
 * would only prove the test times out, not that the watchdog fired.
 */
function silentBodyResponse(signal: AbortSignal | null | undefined): Response {
  return {
    status: 206,
    body: {
      getReader: () => ({
        read: (): Promise<never> =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      }),
    },
  } as unknown as Response;
}

/** A fetch stand-in that never settles on its own, but rejects like real fetch() does
 *  when its AbortSignal fires — that's the behaviour a stalled mobile connection needs to
 *  reproduce, since simply never resolving would only prove the test times out too. */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as unknown as typeof fetch;
}

describe('fetchChunkWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries a chunk stalled past the timeout instead of hanging forever', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        call += 1;
        if (call === 1) {
          // First attempt: hangs until aborted by the timeout, like a stalled connection.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }
        return Promise.resolve(okResponse(1024));
      }),
    );

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry('https://example/x.pmtiles', 'x.pmtiles', 0, 1023, controller.signal);

    // Let the first attempt's timeout fire, then its backoff delay.
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await resultPromise;
    expect(result.byteLength).toBe(1024);
    expect(call).toBe(2);
  });

  it('gives up after repeated stalls and says it stalled', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry('https://example/x.pmtiles', 'x.pmtiles', 0, 1023, controller.signal);
    // Specifically DownloadStalled, not a bare AbortError: the UI tells a stalled
    // connection apart from a user's Cancel on the type alone, and reported one as the
    // other for as long as this threw whatever the abort happened to produce.
    const assertion = expect(resultPromise).rejects.toBeInstanceOf(DownloadStalled);

    // 5 attempts: timeout, backoff, timeout, backoff, ... enough ticks to exhaust retries.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(8_000);
    }

    await assertion;
  });

  it('lets a slow transfer run as long as it keeps delivering bytes', async () => {
    // The regression that made large regions undownloadable on a weak signal. The old
    // timeout was a deadline on the whole chunk, so a connection that was working
    // perfectly — just slowly — had every chunk killed at 20 s and retried until the
    // attempts ran out. 40 blocks 15 s apart is 600 s of transfer, thirty times the stall
    // timeout, without ever being silent for 20 s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tricklingResponse(40, 1024, 15_000)),
    );

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry(
      'https://example/x.pmtiles',
      'x.pmtiles',
      0,
      40 * 1024 - 1,
      controller.signal,
    );

    await vi.advanceTimersByTimeAsync(40 * 15_000 + 1_000);

    const result = await resultPromise;
    expect(result.byteLength).toBe(40 * 1024);
  });

  it('still gives up when the body goes quiet mid-transfer', async () => {
    // The other half of the same contract: an idle timeout must not become no timeout.
    // Headers arrive, so the request looks healthy, and then nothing ever comes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => silentBodyResponse(init?.signal)),
    );

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry('https://example/x.pmtiles', 'x.pmtiles', 0, 1023, controller.signal);
    const assertion = expect(resultPromise).rejects.toBeInstanceOf(DownloadStalled);

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(8_000);
    }

    await assertion;
  });

  it('refuses a chunk shorter than the range asked for', async () => {
    // A short 206 would be written at the current offset and the next chunk fetched from
    // start + CHUNK_BYTES, misaligning the rest of the archive — and finalizePartial
    // would promote it as complete.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tricklingResponse(1, 512, 0)),
    );

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry('https://example/x.pmtiles', 'x.pmtiles', 0, 1023, controller.signal);
    const assertion = expect(resultPromise).rejects.toThrow(/Short read/);

    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(8_000);

    await assertion;
  });

  it('stops immediately on cancellation rather than waiting out a retry', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry('https://example/x.pmtiles', 'x.pmtiles', 0, 1023, controller.signal);
    const assertion = expect(resultPromise).rejects.toBeInstanceOf(DownloadCancelled);

    await vi.advanceTimersByTimeAsync(20_000); // let the first attempt time out and start backoff
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await assertion;
  });
});

describe('downloadArtifact', () => {
  // Mirrors downloader.ts's own tuning constants — not exported, since they're an
  // implementation detail everywhere except here, where the test needs to know exactly
  // where the old concurrency-window boundary sat.
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const FETCH_CONCURRENCY = 12;

  beforeEach(() => {
    opfsMocks.hasArtifact.mockResolvedValue(false);
    opfsMocks.partialSize.mockResolvedValue(0);
    opfsMocks.appendToPartial.mockClear();
    opfsMocks.finalizePartial.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps dispatching past the first concurrency window when chunks resolve out of order', async () => {
    // Regression test for the real "stuck at 50.3 MB" bug: two separate downloads froze
    // at the exact same byte count (FETCH_CONCURRENCY × CHUNK_BYTES = 12 × 4 MiB), which
    // ruled out random network flakiness and pointed at something deterministic in the
    // pipeline itself — see downloader.ts's `fillWindow()` comment at the write site.
    //
    // Reproducing it needs the first window's chunks to resolve *out of order*: `ready`
    // only grows one entry per `Promise.race` call, so in-order resolution never lets more
    // than one entry sit ahead of the writer, and the write branch's missing `fillWindow()`
    // call never gets exposed. Real mobile networks resolve concurrent requests out of
    // order routinely (per-request latency jitter); this drives the first window's 12
    // chunks to resolve in strict reverse order, which piles all 12 into `ready` by the
    // time chunk 0 lands — the exact condition that let the writer blow through indices
    // 1..11 via the write-only branch and never dispatch chunk 12.
    const totalChunks = FETCH_CONCURRENCY + 8;
    const artifact: RegionArtifact = {
      kind: 'basemap',
      filename: 'test-region-basemap.pmtiles',
      path: 'regions/test-region/test-region-basemap.pmtiles',
      bytes: CHUNK_BYTES * totalChunks,
    };

    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))),
    );
    opfsMocks.appendToPartial.mockResolvedValue(undefined);

    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    const receivedBytes: number[] = [];
    const controller = new AbortController();
    const donePromise = downloadArtifact(artifact, controller.signal, (bytes) => receivedBytes.push(bytes));

    while (resolvers.length < FETCH_CONCURRENCY) await tick();

    // Resolve the first window in reverse order, one at a time, so each is consumed by its
    // own `Promise.race` before the next lands — exactly what piles the whole window into
    // `ready` ahead of the writer.
    for (let i = FETCH_CONCURRENCY - 1; i >= 0; i -= 1) {
      resolvers[i](okResponse(CHUNK_BYTES));
      await tick();
    }

    // Everything from here on (chunk 12+) only exists if the window kept refilling —
    // resolve it as soon as it's dispatched.
    const drainRest = (async () => {
      for (let index = FETCH_CONCURRENCY; index < totalChunks; index += 1) {
        while (resolvers.length <= index) await tick();
        resolvers[index](okResponse(CHUNK_BYTES));
      }
    })();

    await Promise.all([donePromise, drainRest]);

    expect(opfsMocks.appendToPartial).toHaveBeenCalledTimes(totalChunks);
    expect(opfsMocks.finalizePartial).toHaveBeenCalledTimes(1);
    expect(receivedBytes.at(-1)).toBe(artifact.bytes);

    // The old deadlock boundary (50,331,648 bytes, "50.3 MB") must be passed through on
    // the way to completion, never the final value.
    expect(receivedBytes).toContain(FETCH_CONCURRENCY * CHUNK_BYTES);
    expect(receivedBytes.at(-1)).not.toBe(FETCH_CONCURRENCY * CHUNK_BYTES);
  }, 10_000);
});
