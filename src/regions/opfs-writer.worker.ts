// The hot write path for a partial region download.
//
// This exists in a worker for one reason: `createSyncAccessHandle()` is only available
// off the main thread, and it is the only OPFS write API that does not copy the file it
// is appending to.
//
// The main thread's alternative, `createWritable({ keepExistingData: true })`, is backed
// by a swap file that starts as a *copy* of the existing data — so appending chunk N
// re-copies everything already written. Measured in Chromium: ~1.2 ms per MB of existing
// file, i.e. an append cost that climbs linearly and a total cost that is quadratic in
// artifact size. For a 1 GB region that is ~130 GB copied and minutes of pure disk work
// on a fast desktop SSD; on phone flash it is far worse, and it is why large regions
// appeared to crawl to a halt near the end. A sync access handle writes straight into the
// file at an offset: flat ~5.5 ms per 4 MiB chunk however large the file has grown
// (37x faster over a 240 MB run, and it writes 240 MB rather than ~7 GB).

/** Not in TypeScript's DOM lib yet, so the parts we use are declared here. */
interface SyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
}

type Request =
  | { id: number; type: 'open'; name: string }
  | { id: number; type: 'write'; chunk: ArrayBuffer; at: number }
  | { id: number; type: 'close' };

export type WorkerResponse =
  | { id: number; ok: true; written?: number }
  | { id: number; ok: false; error: string };

// `self` is typed as a Window under the DOM lib; the worker globals we need are narrowed
// here rather than by adding the webworker lib, which conflicts with DOM project-wide.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

let access: SyncAccessHandle | null = null;

ctx.onmessage = async (event: MessageEvent<Request>): Promise<void> => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'open': {
        const root = await navigator.storage.getDirectory();
        const handle = (await root.getFileHandle(message.name, {
          create: true,
        })) as FileSystemFileHandle & {
          createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
        };
        if (typeof handle.createSyncAccessHandle !== 'function') {
          throw new Error('createSyncAccessHandle is unavailable');
        }
        access = await handle.createSyncAccessHandle();
        ctx.postMessage({ id: message.id, ok: true });
        break;
      }

      case 'write': {
        if (!access) throw new Error('write before open');
        const written = access.write(new Uint8Array(message.chunk), { at: message.at });
        // Flushed per chunk, not per artifact. `partialSize()` on the main thread is what
        // a resume trusts to be a contiguous prefix of real data (C1), so every chunk this
        // reports as stored has to actually be on disk before the next one is fetched —
        // otherwise a force-quit mid-download would leave the file claiming bytes it never
        // wrote. Costs about 5 ms a chunk, which is the whole budget of this path anyway.
        access.flush();
        ctx.postMessage({ id: message.id, ok: true, written });
        break;
      }

      case 'close': {
        // The handle holds an exclusive lock: finalizePartial() cannot rename the file
        // out from under it, so closing is not optional bookkeeping.
        access?.flush();
        access?.close();
        access = null;
        ctx.postMessage({ id: message.id, ok: true });
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({ id: message.id, ok: false, error: (err as Error).message });
  }
};
