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

/**
 * How many chunk fetches run concurrently.
 *
 * Measured against the storage bucket (2026-09-01): a single connection sustains only
 * ~1.5 MB/s, and concurrent connections roughly double aggregate throughput before
 * flattening out — 4 gave ~2.4 MB/s, 8 gave ~2.9 MB/s. Diminishing enough past 4 that it
 * isn't worth the extra memory (each in-flight chunk is a full `CHUNK_BYTES` buffer).
 */
const FETCH_CONCURRENCY = 4;

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

async function fetchChunk(
  url: string,
  filename: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });

  // 206 is the expected success. A 200 means the server ignored the Range header and is
  // sending the whole file — writing that at a non-zero offset would corrupt the
  // archive, so refuse rather than produce a broken map.
  if (response.status !== 206) {
    throw new Error(
      `Expected 206 Partial Content for ${filename}, got ${response.status}. ` +
        'The storage bucket may not support range requests.',
    );
  }

  const chunk = await response.arrayBuffer();
  if (chunk.byteLength === 0) {
    throw new Error(`Empty chunk for ${filename} at offset ${start}`);
  }
  return chunk;
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

  // Chunks still to fetch, as their start offsets, in file order.
  const starts: number[] = [];
  for (let s = offset; s < artifact.bytes; s += CHUNK_BYTES) starts.push(s);

  // Fetches run up to FETCH_CONCURRENCY at a time and can resolve out of order, but they
  // are only ever committed to OPFS in strict offset order (`nextToWrite`) — resolved
  // chunks that arrive early just wait in `ready`. That's what keeps `partialSize()` an
  // honest contiguous prefix: a crash mid-batch can only ever leave the file exactly as
  // far along as the original serial version would have, never with a gap in the middle
  // that a later resume would silently treat as real data (C1).
  let nextToDispatch = 0;
  let nextToWrite = 0;
  const inFlight = new Map<number, Promise<ArrayBuffer>>();
  const ready = new Map<number, ArrayBuffer>();

  const dispatch = (index: number): void => {
    const start = starts[index];
    const end = Math.min(start + CHUNK_BYTES, artifact.bytes) - 1;
    inFlight.set(index, fetchChunk(url, artifact.filename, start, end, signal));
  };

  while (nextToDispatch < starts.length && inFlight.size < FETCH_CONCURRENCY) {
    dispatch(nextToDispatch);
    nextToDispatch += 1;
  }

  while (nextToWrite < starts.length) {
    if (signal.aborted) throw new DownloadCancelled();

    if (!ready.has(nextToWrite)) {
      // Not an orphaned request: a rejection here (abort, bad status, network error)
      // propagates out of this function, which is what we want — the other still-running
      // fetches are left to settle on their own rather than needing a second abort path
      // layered on top of the caller's own `signal`.
      const [doneIndex, chunk] = await Promise.race(
        [...inFlight.entries()].map(async ([index, pending]) => [index, await pending] as const),
      );
      inFlight.delete(doneIndex);
      ready.set(doneIndex, chunk);

      if (nextToDispatch < starts.length) {
        dispatch(nextToDispatch);
        nextToDispatch += 1;
      }
      continue;
    }

    const chunk = ready.get(nextToWrite)!;
    ready.delete(nextToWrite);
    await appendToPartial(artifact.filename, chunk, offset);
    offset += chunk.byteLength;
    onStored(offset);
    nextToWrite += 1;
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
