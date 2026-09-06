import { open } from 'node:fs/promises';

/**
 * A pmtiles `Source` over a local file — the Node-side stand-in for the browser's
 * `FileSource`, which reads an OPFS `File`.
 *
 * Shared by the tests that run the real app code against real built archives off disk
 * (`archive-route.test.ts`, `sac-grades.test.ts`). Those archives are gitignored build
 * output, so every test using this also skips when the file is absent.
 */
export class NodeFileSource {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return {
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    } finally {
      await handle.close();
    }
  }
}
