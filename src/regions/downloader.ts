import { artifactUrl, type Region, type RegionArtifact } from './manifest';
import { WakeLock } from '../wake-lock';
import {
  appendToPartial,
  deleteArtifact,
  finalizePartial,
  hasArtifact,
  listArtifactNames,
  partialName,
  partialSize,
} from './opfs-store';

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
 * How many region downloads are running right now.
 *
 * Read by the app-update controller (src/update.ts) to hold a reload back. A reload here
 * aborts an in-flight multi-hundred-MB transfer, and C12 means nothing carries it on in
 * the background — on iOS there is no Background Fetch and no Background Sync. Resume
 * would recover the bytes already on disk, but interrupting someone's download to ship a
 * routine deploy is not a trade worth making.
 */
let inFlight = 0;

export function downloadsInFlight(): number {
  return inFlight;
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
  inFlight += 1;
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
    inFlight -= 1;
    await wakeLock.release();
  }
}

export async function deleteRegion(region: Region): Promise<void> {
  for (const artifact of region.artifacts) {
    await deleteArtifact(artifact.filename);
  }
}

export type RegionState = 'absent' | 'partial' | 'downloaded';

/**
 * The state of many regions from a single directory listing.
 *
 * Asking per region is the same question repeated once per artifact; across a global
 * catalogue that is thousands of OPFS lookups, run on the startup path. Callers holding a
 * list — the catalogue sheet, the startup restore — ask here so the listing is read once.
 */
export async function regionStatuses(regions: Region[]): Promise<Map<string, RegionState>> {
  const present = await listArtifactNames();
  return new Map(regions.map((region) => [region.id, statusFrom(region, present)]));
}

function statusFrom(region: Region, present: Set<string>): RegionState {
  let complete = 0;
  let partial = 0;

  for (const artifact of region.artifacts) {
    if (present.has(artifact.filename)) complete += 1;
    else if (present.has(partialName(artifact.filename))) partial += 1;
  }

  if (complete === region.artifacts.length) return 'downloaded';
  if (complete > 0 || partial > 0) return 'partial';
  return 'absent';
}
