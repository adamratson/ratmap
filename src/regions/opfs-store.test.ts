import { afterEach, describe, expect, it } from 'vitest';
import { finalizePartial } from './opfs-store';

// A minimal in-memory stand-in for OPFS. Only the calls finalizePartial makes are
// modelled; `move` is deliberately configurable, because the whole point of these tests
// is that different engines implement it differently.

type MoveImpl = ((this: FakeFileHandle, ...args: unknown[]) => Promise<void>) | null;

class FakeFileHandle {
  readonly kind = 'file';
  readonly dir: FakeDirectoryHandle;
  name: string;

  constructor(dir: FakeDirectoryHandle, name: string) {
    this.dir = dir;
    this.name = name;
  }

  async getFile(): Promise<File> {
    const bytes = this.dir.files.get(this.name) ?? new Uint8Array();
    // jsdom's Blob has no stream(); real engines (including Safari) do, and the
    // copy fallback pipes through it.
    return {
      name: this.name,
      size: bytes.byteLength,
      stream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    } as unknown as File;
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStream> {
    const chunks: Uint8Array[] = [];
    if (options?.keepExistingData) {
      const existing = this.dir.files.get(this.name);
      if (existing) chunks.push(existing);
    }
    return new WritableStream({
      write: (chunk: Uint8Array) => {
        chunks.push(chunk);
      },
      close: () => {
        this.dir.files.set(this.name, concat(chunks));
      },
    });
  }
}

class FakeDirectoryHandle {
  readonly files = new Map<string, Uint8Array>();
  moveCalls: unknown[][] = [];
  private moveImpl: MoveImpl = null;

  withMove(impl: MoveImpl): this {
    this.moveImpl = impl;
    return this;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('not found', 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    const handle = new FakeFileHandle(this, name);
    if (this.moveImpl) {
      Object.assign(handle, {
        move: (...args: unknown[]) => {
          this.moveCalls.push(args);
          return this.moveImpl!.apply(handle, args);
        },
      });
    }
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FakeFileHandle]> {
    for (const name of [...this.files.keys()]) {
      yield [name, new FakeFileHandle(this, name)];
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Rename in place, the way a spec-compliant move(destination, name) behaves. */
async function renameInPlace(this: FakeFileHandle, ...args: unknown[]): Promise<void> {
  const name = args[1] as string;
  this.dir.files.set(name, this.dir.files.get(this.name)!);
  this.dir.files.delete(this.name);
  this.name = name;
}

function install(dir: FakeDirectoryHandle): FakeDirectoryHandle {
  Object.defineProperty(navigator, 'storage', {
    value: { getDirectory: async () => dir },
    configurable: true,
  });
  return dir;
}

function withPartial(dir: FakeDirectoryHandle): FakeDirectoryHandle {
  dir.files.set('lochaber-basemap.pmtiles.part', new Uint8Array([1, 2, 3, 4]));
  return dir;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'storage');
});

describe('finalizePartial', () => {
  it('moves with the two-argument form, which is the only one WebKit implements', async () => {
    // Safari throws TypeError "Not enough arguments" for move(newName) — the single-arg
    // overload other engines accept. That stranded every completed iOS download as a
    // full-size .part that could never be promoted, so the region sat on "Resume" and
    // each retry failed instantly.
    const dir = install(
      withPartial(
        new FakeDirectoryHandle().withMove(async function (this: FakeFileHandle, ...args) {
          if (args.length < 2) throw new TypeError('Not enough arguments');
          return renameInPlace.apply(this, args);
        }),
      ),
    );

    await finalizePartial('lochaber-basemap.pmtiles');

    expect(dir.moveCalls[0]).toEqual([dir, 'lochaber-basemap.pmtiles']);
    expect([...dir.files.keys()]).toEqual(['lochaber-basemap.pmtiles']);
  });

  it('copies and deletes when move() is unavailable', async () => {
    const dir = install(withPartial(new FakeDirectoryHandle()));

    await finalizePartial('lochaber-basemap.pmtiles');

    expect([...dir.files.keys()]).toEqual(['lochaber-basemap.pmtiles']);
    expect(dir.files.get('lochaber-basemap.pmtiles')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('falls back to copying when move() exists but fails', async () => {
    // A move() that rejects must not fail the whole download: the bytes are already on
    // disk and copying them is slow but correct.
    const dir = install(
      withPartial(
        new FakeDirectoryHandle().withMove(async () => {
          throw new TypeError('Not enough arguments');
        }),
      ),
    );

    await finalizePartial('lochaber-basemap.pmtiles');

    expect([...dir.files.keys()]).toEqual(['lochaber-basemap.pmtiles']);
    expect(dir.files.get('lochaber-basemap.pmtiles')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
