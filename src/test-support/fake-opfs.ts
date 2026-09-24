import { vi } from 'vitest';

/**
 * An in-memory Origin Private File System: nested directories, files, and writables that
 * commit on close — the parts of the API ratmap's own code calls.
 *
 * `failWrites` makes every write fail the way a full disk does, for testing what happens
 * then. Install with {@link installFakeOpfs}; `vi.unstubAllGlobals()` removes it.
 */
export class FakeDirectory {
  readonly kind = 'directory';
  readonly files = new Map<string, string>();
  readonly dirs = new Map<string, FakeDirectory>();
  failWrites: DOMException | null = null;

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
      dir = new FakeDirectory();
      dir.failWrites = this.failWrites;
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
      this.files.set(name, '');
    }
    return {
      kind: 'file' as const,
      getFile: async () => {
        const text = this.files.get(name) ?? '';
        return { size: text.length, text: async () => text };
      },
      createWritable: async () => {
        let pending = '';
        return {
          write: async (data: string) => {
            if (this.failWrites) throw this.failWrites;
            pending += data;
          },
          close: async () => void this.files.set(name, pending),
          abort: async () => {},
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new DOMException(`${name} not found`, 'NotFoundError');
    }
  }

  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, { kind: 'file' }];
    for (const [name, dir] of this.dirs) yield [name, dir];
  }
}

export function installFakeOpfs(root = new FakeDirectory()): FakeDirectory {
  vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => root } });
  return root;
}
