import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadCancelled, fetchChunkWithRetry } from './downloader';

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

  it('gives up after repeated stalls and surfaces an error', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const controller = new AbortController();
    const resultPromise = fetchChunkWithRetry('https://example/x.pmtiles', 'x.pmtiles', 0, 1023, controller.signal);
    const assertion = expect(resultPromise).rejects.toThrow();

    // 5 attempts: timeout, backoff, timeout, backoff, ... enough ticks to exhaust retries.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(8_000);
    }

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
