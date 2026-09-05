import { appendToPartial, partialName } from './opfs-store';
import type { WorkerResponse } from './opfs-writer.worker';

// Main-thread side of the partial-download write path. See opfs-writer.worker.ts for why
// the fast path lives in a worker at all.

export interface PartialWriter {
  /**
   * Append a chunk at an absolute file offset.
   *
   * @returns bytes written. Returned rather than read back off the caller's buffer
   *   because the worker path *transfers* it, which leaves the caller's view detached
   *   with a `byteLength` of 0 — advancing an offset by that would silently stall a
   *   download at whatever byte the first chunk landed on.
   */
  append(chunk: ArrayBuffer, at: number): Promise<number>;
  /** Release the file. Must happen before the artifact can be finalized. */
  close(): Promise<void>;
}

/** Worker-backed writer: one sync access handle, held open for the whole artifact. */
class SyncHandleWriter implements PartialWriter {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (written: number) => void; reject: (err: Error) => void }
  >();

  private readonly worker: Worker;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.ok) waiting.resolve(message.written ?? 0);
      else waiting.reject(new Error(message.error));
    };
    // A worker that dies takes every outstanding write with it. Without this the
    // download would wait on a promise nothing can ever settle — the exact silent hang
    // the chunk watchdog exists to prevent on the network side.
    worker.onerror = () => this.failAll(new Error('OPFS writer worker failed'));
  }

  private failAll(err: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(err);
    this.pending.clear();
  }

  private send(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<number> {
    const id = this.nextId++;
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  open(name: string): Promise<number> {
    return this.send({ type: 'open', name });
  }

  async append(chunk: ArrayBuffer, at: number): Promise<number> {
    // Transferred, not copied: at FETCH_CONCURRENCY × CHUNK_BYTES in flight, structured
    // cloning every chunk across the boundary would double this path's memory ceiling.
    const size = chunk.byteLength;
    const written = await this.send({ type: 'write', chunk, at }, [chunk]);
    return written || size;
  }

  async close(): Promise<void> {
    try {
      await this.send({ type: 'close' });
    } finally {
      this.worker.terminate();
      this.failAll(new Error('OPFS writer closed'));
    }
  }
}

/**
 * Fallback writer, using the same main-thread `createWritable` path this replaced.
 *
 * Kept because losing downloads entirely is a far worse failure than losing the fast
 * path: sync access handles need a module worker and OPFS support that is broad but not
 * universal, and a browser that lacks either still has to be able to download a region.
 */
class BufferedWriter implements PartialWriter {
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  async append(chunk: ArrayBuffer, at: number): Promise<number> {
    await appendToPartial(this.filename, chunk, at);
    return chunk.byteLength;
  }

  async close(): Promise<void> {}
}

/**
 * Open a writer for an artifact's `.part` file, preferring the worker.
 *
 * Falls back rather than throwing: any failure to start the worker, load it, or take the
 * file's lock leaves downloads working at the old speed instead of not working.
 */
export async function openPartialWriter(filename: string): Promise<PartialWriter> {
  if (typeof Worker === 'undefined') return new BufferedWriter(filename);

  let worker: Worker;
  try {
    worker = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return new BufferedWriter(filename);
  }

  const writer = new SyncHandleWriter(worker);
  try {
    await writer.open(partialName(filename));
    return writer;
  } catch {
    worker.terminate();
    return new BufferedWriter(filename);
  }
}
