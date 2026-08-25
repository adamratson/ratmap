// OPFS storage for downloaded region archives (C5: .pmtiles live in OPFS, never the
// service-worker Cache API — that has a much smaller effective quota and no random-access
// file handles, which is exactly what PMTiles range reads need).
//
// Layout is flat, keyed by artifact filename, because C3 already guarantees those are
// globally unique and because FileSource.getKey() returns file.name — so the OPFS name,
// the registry key and the manifest filename are all deliberately the same string.
//
// Partial downloads live under `<filename>.part` and are only renamed into place once
// complete, so an interrupted download can never be mistaken for a usable archive.

const PARTIAL_SUFFIX = '.part';

export function isOpfsSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory);
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsSupported()) {
    throw new Error('OPFS (navigator.storage.getDirectory) unsupported in this browser');
  }
  return navigator.storage.getDirectory();
}

async function tryGetFile(name: string): Promise<File | null> {
  const dir = await root();
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function getArtifactFile(filename: string): Promise<File | null> {
  return tryGetFile(filename);
}

export async function hasArtifact(filename: string): Promise<boolean> {
  return (await tryGetFile(filename)) !== null;
}

/**
 * Every file currently in OPFS, by name — complete downloads and `.part` files alike.
 *
 * One directory read answers the whole catalogue. Asking per artifact costs two lookups
 * each, which was nothing across four regions and is several thousand round trips now
 * that the catalogue covers the globe — paid at startup, before a downloaded region can
 * be restored to the map.
 */
export async function listArtifactNames(): Promise<Set<string>> {
  const dir = await root();
  const names = new Set<string>();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') names.add(name);
  }
  return names;
}

export function partialName(filename: string): string {
  return `${filename}${PARTIAL_SUFFIX}`;
}

/** Bytes already written to a partial download, or 0 if there's nothing to resume. */
export async function partialSize(filename: string): Promise<number> {
  const file = await tryGetFile(`${filename}${PARTIAL_SUFFIX}`);
  return file?.size ?? 0;
}

/**
 * Append to a partial download. Returns the new total size.
 *
 * `keepExistingData: true` is what makes resume work — without it, createWritable()
 * truncates and every resume would silently restart from zero while still reporting
 * progress.
 */
export async function appendToPartial(
  filename: string,
  chunk: BlobPart,
  offset: number,
): Promise<void> {
  const dir = await root();
  const handle = await dir.getFileHandle(`${filename}${PARTIAL_SUFFIX}`, { create: true });
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await writable.write({ type: 'write', position: offset, data: chunk });
    await writable.close();
  } catch (err) {
    // abort(), not close(): Chromium backs createWritable() with a sibling swap file
    // ("<name>.N.crswap") and only discards it on abort. Closing a failed writable can
    // strand that swap file in OPFS, silently consuming the storage this whole feature
    // exists to manage — observed leaking 6.4 MB after one interrupted download.
    await writable.abort?.().catch(() => {});
    throw err;
  }
}

export async function finalizePartial(filename: string): Promise<void> {
  const dir = await root();
  const partialName = `${filename}${PARTIAL_SUFFIX}`;
  const partial = await dir.getFileHandle(partialName);

  // FileSystemHandle.move() is not universally available; fall back to copy + delete.
  //
  // Called with the two-argument (destinationDirectory, newName) form even though the
  // destination is the directory the file is already in: WebKit implements only that
  // overload and throws TypeError "Not enough arguments" for move(newName), while
  // Chromium accepts both. With the single-argument form, every completed iOS download
  // failed at exactly this point — the .part was full-size but could never be promoted,
  // so the region stayed stuck on "Resume" and each retry re-failed instantly.
  // (Verified in Safari 2026-08-23; the copy+delete path below is a real fallback, not
  // dead code, so a move() failure must not be fatal.)
  const movable = partial as FileSystemFileHandle & {
    move?: (destination: FileSystemDirectoryHandle, name?: string) => Promise<void>;
  };
  if (typeof movable.move === 'function') {
    try {
      await movable.move(dir, filename);
      await sweepSwapFiles();
      return;
    } catch {
      // Fall through and copy instead: slower, but it finishes the download.
    }
  }

  const source = await partial.getFile();
  const target = await dir.getFileHandle(filename, { create: true });
  const writable = await target.createWritable();
  try {
    await source.stream().pipeTo(writable);
  } catch (err) {
    await writable.abort?.();
    throw err;
  }
  await dir.removeEntry(partialName);
  await sweepSwapFiles();
}

export async function deleteArtifact(filename: string): Promise<void> {
  const dir = await root();
  for (const name of [filename, `${filename}${PARTIAL_SUFFIX}`]) {
    try {
      await dir.removeEntry(name);
    } catch {
      // Absent is the desired end state either way.
    }
  }
  await sweepSwapFiles();
}

/**
 * Remove stranded Chromium writable swap files ("<name>.N.crswap").
 *
 * abort() handles the paths we control, but a page torn down mid-write (backgrounded and
 * evicted on iOS, force-quit, crash) leaves them behind with nothing to clean up after —
 * and this app's whole premise is that interruption is normal (C12). Cheap to sweep,
 * and they are never live data: a swap file only matters to the writable that owns it,
 * which cannot outlive the page.
 */
export async function sweepSwapFiles(): Promise<number> {
  const dir = await root();
  const stale: string[] = [];

  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name.endsWith('.crswap')) stale.push(name);
  }

  let reclaimed = 0;
  for (const name of stale) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      reclaimed += file.size;
      await dir.removeEntry(name);
    } catch {
      // Still held open by a live writable — leave it.
    }
  }
  return reclaimed;
}
