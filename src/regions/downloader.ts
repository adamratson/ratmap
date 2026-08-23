import { artifactUrl, type Region, type RegionArtifact } from './manifest';
import { appendToPartial, deleteArtifact, finalizePartial, hasArtifact, partialSize } from './opfs-store';

// C12 baseline: chunked, resumable, holds a Screen Wake Lock while running.
//
// On iOS there is no Background Fetch and no Background Sync, so a multi-hundred-MB
// download only progresses while the app is foregrounded — it *will* be interrupted, so
// resume is mandatory rather than a nicety. The Background Fetch enhancement (Chromium)
// is deliberately not built here: the plan says build the baseline first and never let
// the enhancement become a second code path of equal weight.

/** Range size per request. Small enough to make interruption cheap, large enough to keep
 *  request overhead irrelevant against a ~20 MB artifact. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface DownloadProgress {
  regionId: string;
  /** Bytes stored for this region so far, across all its artifacts. */
  receivedBytes: number;
  totalBytes: number;
  /** The artifact currently transferring, for UI detail. */
  currentArtifact: string | null;
  done: boolean;
}

export type ProgressListener = (progress: DownloadProgress) => void;

export class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelled';
  }
}

/**
 * Keeps the screen awake for the duration of a download (C12).
 *
 * Re-acquires on visibilitychange: the lock is released automatically whenever the page
 * is hidden, so without this a user who glances away loses it permanently and the screen
 * sleeps mid-download — which on iOS also stops the download.
 */
class WakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'visible') void this.acquire();
  };

  async acquire(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    } catch {
      // Denied (low battery, unsupported): downloads still work, they just need the
      // screen kept on manually. Not worth failing the download over.
    }
  }

  async release(): Promise<void> {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    try {
      await this.sentinel?.release();
    } catch {
      // Already released.
    }
    this.sentinel = null;
  }
}

/**
 * @param onStored called with the *absolute* number of bytes stored for this artifact so
 *   far — never an increment. Resume makes increments easy to double-count.
 */
async function downloadArtifact(
  artifact: RegionArtifact,
  signal: AbortSignal,
  onStored: (bytesStored: number) => void,
): Promise<void> {
  if (await hasArtifact(artifact.filename)) {
    onStored(artifact.bytes);
    return;
  }

  let offset = await partialSize(artifact.filename);

  // A partial larger than the expected size means the manifest changed under us (a
  // rebuilt artifact). Start clean rather than splice two different files together.
  if (offset > artifact.bytes) {
    await deleteArtifact(artifact.filename);
    offset = 0;
  }

  onStored(offset);

  const url = artifactUrl(artifact);

  while (offset < artifact.bytes) {
    if (signal.aborted) throw new DownloadCancelled();

    const end = Math.min(offset + CHUNK_BYTES, artifact.bytes) - 1;
    const response = await fetch(url, {
      headers: { Range: `bytes=${offset}-${end}` },
      signal,
    });

    // 206 is the expected success. A 200 means the server ignored the Range header and is
    // sending the whole file — writing that at a non-zero offset would corrupt the
    // archive, so refuse rather than produce a broken map.
    if (response.status !== 206) {
      throw new Error(
        `Expected 206 Partial Content for ${artifact.filename}, got ${response.status}. ` +
          'The storage bucket may not support range requests.',
      );
    }

    const chunk = await response.arrayBuffer();
    if (chunk.byteLength === 0) {
      throw new Error(`Empty chunk for ${artifact.filename} at offset ${offset}`);
    }

    await appendToPartial(artifact.filename, chunk, offset);
    offset += chunk.byteLength;
    onStored(offset);
  }

  await finalizePartial(artifact.filename);
}

/**
 * Download every artifact a region declares. Resumes from whatever is already in OPFS.
 * Iterates `region.artifacts` rather than known names, so a new artifact kind needs no
 * change here (C16).
 */
export async function downloadRegion(
  region: Region,
  options: { signal: AbortSignal; onProgress?: ProgressListener },
): Promise<void> {
  const wakeLock = new WakeLock();
  await wakeLock.acquire();

  const progress: DownloadProgress = {
    regionId: region.id,
    receivedBytes: 0,
    totalBytes: region.totalBytes,
    currentArtifact: null,
    done: false,
  };

  try {
    let completedBytes = 0;

    for (const artifact of region.artifacts) {
      progress.currentArtifact = artifact.kind;

      await downloadArtifact(artifact, options.signal, (bytesStored) => {
        progress.receivedBytes = completedBytes + bytesStored;
        options.onProgress?.({ ...progress });
      });

      completedBytes += artifact.bytes;
      progress.receivedBytes = completedBytes;
      options.onProgress?.({ ...progress });
    }

    progress.currentArtifact = null;
    progress.done = true;
    options.onProgress?.({ ...progress });
  } finally {
    await wakeLock.release();
  }
}

export async function deleteRegion(region: Region): Promise<void> {
  for (const artifact of region.artifacts) {
    await deleteArtifact(artifact.filename);
  }
}

export async function regionStatus(
  region: Region,
): Promise<'absent' | 'partial' | 'downloaded'> {
  let present = 0;
  let partial = 0;

  for (const artifact of region.artifacts) {
    if (await hasArtifact(artifact.filename)) present += 1;
    else if ((await partialSize(artifact.filename)) > 0) partial += 1;
  }

  if (present === region.artifacts.length) return 'downloaded';
  if (present > 0 || partial > 0) return 'partial';
  return 'absent';
}
