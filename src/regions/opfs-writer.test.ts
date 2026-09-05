import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opfsMocks = vi.hoisted(() => ({
  appendToPartial: vi.fn(async () => {}),
  partialName: (filename: string) => `${filename}.part`,
}));

vi.mock('./opfs-store', () => opfsMocks);

const { openPartialWriter } = await import('./opfs-writer');

type Reply = Record<string, unknown> | null;

/** A stand-in worker whose answers — or silence — the test decides. */
class StubWorker {
  static instances: StubWorker[] = [];
  /** Return null to say nothing back at all, which is how a killed worker behaves. */
  static answer: (message: Record<string, unknown>) => Reply = () => null;

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;

  constructor() {
    StubWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    const reply = StubWorker.answer(message);
    if (reply === null) return;
    queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
  }

  terminate(): void {
    this.terminated = true;
  }
}

const opensThenGoesQuiet = (message: Record<string, unknown>): Reply =>
  message.type === 'open' ? { id: message.id, ok: true } : null;

describe('openPartialWriter', () => {
  beforeEach(() => {
    StubWorker.instances = [];
    StubWorker.answer = opensThenGoesQuiet;
    opfsMocks.appendToPartial.mockClear();
    vi.stubGlobal('Worker', StubWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails a write the worker never answers, rather than waiting forever', async () => {
    // The reported symptom this exists for: a download frozen at a byte count with the
    // row still offering "Cancel", because nothing had thrown. iOS terminating a worker
    // under memory pressure raises no error event — it just stops replying — so only a
    // timeout can turn that back into something the download can report and recover from.
    vi.useFakeTimers();
    const writer = await openPartialWriter('x.pmtiles');

    const pending = writer.append(new ArrayBuffer(8), 0);
    const assertion = expect(pending).rejects.toThrow(/stopped responding/);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    // The dead worker is disposed of, so its lock on the .part file goes with it and a
    // Resume can open a fresh one.
    expect(StubWorker.instances.at(-1)?.terminated).toBe(true);
  });

  it('falls back to the main-thread writer when the worker cannot start', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('workers unavailable');
        }
      },
    );

    const writer = await openPartialWriter('x.pmtiles');
    await writer.append(new ArrayBuffer(4), 16);

    // Still writing, just by the slower route — a browser without sync access handles has
    // to be able to download a region at all.
    expect(opfsMocks.appendToPartial).toHaveBeenCalledWith('x.pmtiles', expect.anything(), 16);
  });

  it('falls back when the worker cannot take the file lock', async () => {
    // A handle stranded by a previous page that was killed mid-download keeps an
    // exclusive lock on the .part file, so opening can legitimately fail.
    StubWorker.answer = (message) =>
      message.type === 'open'
        ? { id: message.id, ok: false, error: 'NoModificationAllowedError' }
        : null;

    const writer = await openPartialWriter('x.pmtiles');
    await writer.append(new ArrayBuffer(4), 0);

    expect(opfsMocks.appendToPartial).toHaveBeenCalled();
    expect(StubWorker.instances.at(-1)?.terminated).toBe(true);
  });
});
