import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerResponse } from './opfs-writer.worker';

// The worker is a message handler on `self`. Under jsdom `self` is the window, so the
// handler can be driven directly: install fakes for `postMessage` and OPFS, import the
// module, and call what it assigned to `self.onmessage`.

interface FakeAccess {
  writes: Array<{ bytes: number[]; at: number | undefined }>;
  flushes: number;
  closed: boolean;
}

let replies: WorkerResponse[];
let access: FakeAccess;
let supportsSyncAccess: boolean;

const worker = self as unknown as {
  onmessage: (event: MessageEvent) => Promise<void>;
  postMessage: (message: WorkerResponse) => void;
};

async function send(data: Record<string, unknown>): Promise<WorkerResponse> {
  await worker.onmessage({ data } as MessageEvent);
  return replies.at(-1)!;
}

beforeEach(async () => {
  vi.resetModules();
  replies = [];
  access = { writes: [], flushes: 0, closed: false };
  supportsSyncAccess = true;

  worker.postMessage = (message) => void replies.push(message);
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async () =>
          supportsSyncAccess
            ? {
                createSyncAccessHandle: async () => ({
                  write: (buffer: Uint8Array, options?: { at?: number }) => {
                    access.writes.push({ bytes: [...buffer], at: options?.at });
                    return buffer.byteLength;
                  },
                  flush: () => void (access.flushes += 1),
                  close: () => void (access.closed = true),
                  getSize: () => 0,
                }),
              }
            : {},
      }),
    },
  });

  await import('./opfs-writer.worker');
});

describe('the OPFS writer worker', () => {
  it('opens, writes at the offset it is told, and reports the bytes written', async () => {
    expect(await send({ id: 1, type: 'open', name: 'x.pmtiles.part' })).toEqual({ id: 1, ok: true });

    const reply = await send({ id: 2, type: 'write', chunk: new Uint8Array([1, 2, 3]).buffer, at: 4096 });

    expect(reply).toEqual({ id: 2, ok: true, written: 3 });
    expect(access.writes).toEqual([{ bytes: [1, 2, 3], at: 4096 }]);
  });

  it('flushes every chunk before saying it is stored', async () => {
    // A resume trusts the file's length to be real data (C1). A chunk reported as written
    // but still in a buffer would be a lie a force-quit could expose.
    await send({ id: 1, type: 'open', name: 'x.pmtiles.part' });
    await send({ id: 2, type: 'write', chunk: new ArrayBuffer(8), at: 0 });
    await send({ id: 3, type: 'write', chunk: new ArrayBuffer(8), at: 8 });

    expect(access.flushes).toBe(2);
  });

  it('closes the handle, releasing the lock the rename needs', async () => {
    await send({ id: 1, type: 'open', name: 'x.pmtiles.part' });

    expect(await send({ id: 2, type: 'close' })).toEqual({ id: 2, ok: true });
    expect(access.closed).toBe(true);
  });

  it('answers a write before open with an error, not silence', async () => {
    expect(await send({ id: 7, type: 'write', chunk: new ArrayBuffer(1), at: 0 })).toEqual({
      id: 7,
      ok: false,
      error: 'write before open',
    });
  });

  it('says so when the browser has no sync access handles', async () => {
    supportsSyncAccess = false;

    const reply = await send({ id: 1, type: 'open', name: 'x.pmtiles.part' });

    expect(reply).toMatchObject({ id: 1, ok: false, error: expect.stringContaining('createSyncAccessHandle') });
  });

  it('refuses writes again once closed', async () => {
    await send({ id: 1, type: 'open', name: 'x.pmtiles.part' });
    await send({ id: 2, type: 'close' });

    expect(await send({ id: 3, type: 'write', chunk: new ArrayBuffer(1), at: 0 })).toMatchObject({ ok: false });
  });
});
