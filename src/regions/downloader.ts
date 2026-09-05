import { artifactUrl, type Region, type RegionArtifact } from './manifest';
import { WakeLock } from '../wake-lock';
import {
  deleteArtifact,
  finalizePartial,
  hasArtifact,
  listArtifactNames,
  partialName,
  partialSize,
} from './opfs-store';
import { openPartialWriter } from './opfs-writer';

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
 * How many chunks may be outstanding at once — in flight plus fetched-but-not-yet-written.
 *
 * Concurrency is where nearly all the download speed is. Measured against Krystal on one
 * connection (2026-09-04, identical 37 MB artifact): 1-way 2.73 MB/s, 4-way 3.58, 8-way
 * 5.06, 12-way 7.22, against a Cloudflare-edge control of 9.57 on the same link at the
 * same moment. So a plain object store at 12-way reaches ~75% of a CDN — most of what
 * looked like a "we need a CDN" problem was just under-parallelised fetching. Civo and
 * Scaleway benchmarked within noise of these numbers, so this is not Krystal-specific.
 *
 * (An earlier version of this comment cited ~1.5 MB/s single-stream and claimed
 * diminishing returns past 4. Those measurements were taken through a VPN tunnel that
 * held the default route, which halved everything and flattened the differences.)
 *
 * The ceiling is memory, not the network: this bounds *total* outstanding work, so peak
 * usage is FETCH_CONCURRENCY × CHUNK_BYTES = 48 MB of ArrayBuffers. That is the number to
 * weigh if downloads start failing on memory-constrained phones — it is the reason this
 * caps total outstanding rather than just in-flight requests.
 */
const FETCH_CONCURRENCY = 12;

/**
 * How long a chunk may go with **no bytes arriving at all** before it's treated as
 * stalled and retried.
 *
 * A `fetch()` with no timeout only ends via error or the caller's own abort — it does not
 * time out on its own. On mobile that gap matters: a cell-tower handoff, a Wi-Fi↔cellular
 * switch, or iOS briefly suspending network on backgrounding can leave a request neither
 * resolving nor rejecting. Because chunks are only ever written to OPFS in strict offset
 * order (`nextToWrite` below), one such hang doesn't just lose a chunk — it permanently
 * freezes the whole artifact at that byte offset, with nothing to show for it: no error,
 * no retry, progress just stops advancing.
 *
 * This is an *idle* timeout, deliberately: it measures silence, not elapsed time. It was
 * originally a deadline on the whole chunk transfer, which cannot tell a hung connection
 * from a merely slow one — and killed both. At 4 MiB a chunk, a 20 s deadline demands
 * 210 kB/s sustained *per chunk*, and with FETCH_CONCURRENCY splitting the link that is
 * ~20 Mbit/s aggregate before any chunk can finish at all. Measured on an emulated (but
 * otherwise healthy) connection: at 1 Mbit/s a 16 MB region transferred **zero bytes in
 * 110 s** before giving up, and at 10 Mbit/s a 75 MB region crawled to 16.8 MB and then
 * gave up — every chunk aborted mid-transfer and retried from scratch, each retry
 * discarding megabytes of good data and starving the chunks still running. Users on a
 * weak signal — i.e. exactly the people downloading maps before going somewhere remote —
 * could never finish a large region.
 */
const CHUNK_STALL_TIMEOUT_MS = 20_000;

/** Chunk attempts before giving up and failing the whole download. */
const MAX_CHUNK_ATTEMPTS = 5;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DownloadCancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadCancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface DownloadProgress {
  regionId: string;
  /** Bytes stored for this region so far, across all its artifacts. */
  receivedBytes: number;
  totalBytes: number;
  /** The artifact currently transferring, for UI detail. */
  currentArtifact: string | null;
  done: boolean;
  /** Smoothed transfer rate. Null until there is enough signal to be worth showing. */
  bytesPerSecond: number | null;
  /** Seconds remaining at the current rate. Null when no rate is available yet. */
  etaSeconds: number | null;
}

export type ProgressListener = (progress: DownloadProgress) => void;

/** Weight given to the newest sample. Low enough to ride out a single slow chunk. */
const RATE_SMOOTHING = 0.3;
/** Rate samples required before quoting an ETA at all. */
const SETTLE_SAMPLES = 3;
/** Progress emits closer together than this don't carry a usable rate. */
const MIN_SAMPLE_SECONDS = 0.1;

/**
 * Exponentially-weighted transfer rate, for the ETA.
 *
 * A lifetime average is the obvious approach and the wrong one here: throughput against
 * the bucket genuinely swings about 2x minute to minute (measured across providers
 * 2026-09-04), so a lifetime average keeps quoting a speed the download stopped achieving
 * ten minutes ago, and an ETA that only ever drifts upward reads as broken.
 *
 * Reports null rather than a guess until it has settled. An estimate that opens at "4
 * hours" and collapses to "30 seconds" once the window fills is worse than showing
 * nothing — it is the same crying-wolf failure C1 warns about for the detail notice, and
 * on a download people are deciding whether to sit and wait for, it matters more.
 */
export class RateEstimator {
  private lastAt: number | null = null;
  private lastBytes = 0;
  private rate: number | null = null;
  private samples = 0;

  /** @param bytes absolute bytes transferred so far — never an increment. */
  update(bytes: number, now: number): void {
    if (this.lastAt === null) {
      this.lastAt = now;
      this.lastBytes = bytes;
      return;
    }

    const seconds = (now - this.lastAt) / 1000;
    const delta = bytes - this.lastBytes;

    // Advance the baseline even when the sample is unusable, so the *next* sample measures
    // its own interval rather than including this one. That is what keeps an instant jump
    // — resuming a part-downloaded region, or skipping an artifact already in OPFS — from
    // being read as infinite throughput and poisoning the average.
    this.lastAt = now;
    this.lastBytes = bytes;
    if (seconds < MIN_SAMPLE_SECONDS || delta <= 0) return;

    const instant = delta / seconds;
    this.rate = this.rate === null ? instant : RATE_SMOOTHING * instant + (1 - RATE_SMOOTHING) * this.rate;
    this.samples += 1;
  }

  /** Null until settled, so callers can render "calculating" rather than a wild guess. */
  get bytesPerSecond(): number | null {
    return this.samples >= SETTLE_SAMPLES ? this.rate : null;
  }

  secondsRemaining(receivedBytes: number, totalBytes: number): number | null {
    const rate = this.bytesPerSecond;
    const remaining = totalBytes - receivedBytes;
    if (rate === null || rate <= 0 || remaining <= 0) return null;
    return remaining / rate;
  }
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelled';
  }
}

/**
 * A chunk that stopped transferring — nothing arrived for {@link CHUNK_STALL_TIMEOUT_MS},
 * on every attempt.
 *
 * A distinct type because otherwise this is indistinguishable from a deliberate cancel:
 * aborting a fetch rejects with a DOMException named `AbortError` whichever of the two
 * fired it, and the regions sheet reported any AbortError as "Paused — progress is kept",
 * the same words a user's own Cancel produces. A connection dying therefore looked like
 * the user had stopped the download themselves, with no error anywhere.
 */
export class DownloadStalled extends Error {
  constructor(filename: string, start: number) {
    super(
      `${filename} stopped transferring at byte ${start}: nothing received for ` +
        `${CHUNK_STALL_TIMEOUT_MS / 1000}s across ${MAX_CHUNK_ATTEMPTS} attempts.`,
    );
    this.name = 'DownloadStalled';
  }
}

/**
 * @param onBytes called every time the connection proves it is still alive — on the
 *   response headers, and on each block of body bytes. Resets the caller's stall
 *   watchdog, which is what lets a slow transfer run as long as it needs to.
 */
async function fetchChunk(
  url: string,
  filename: string,
  start: number,
  end: number,
  signal: AbortSignal,
  onBytes: () => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });

  // Headers are already proof the connection is alive, before a single body byte lands.
  onBytes();

  // 206 is the expected success. A 200 means the server ignored the Range header and is
  // sending the whole file — writing that at a non-zero offset would corrupt the
  // archive, so refuse rather than produce a broken map.
  if (response.status !== 206) {
    throw new Error(
      `Expected 206 Partial Content for ${filename}, got ${response.status}. ` +
        'The storage bucket may not support range requests.',
    );
  }

  const expected = end - start + 1;

  // Read the body as a stream rather than with `arrayBuffer()`. Both produce the same
  // bytes, but `arrayBuffer()` is one opaque await that reports nothing until the whole
  // chunk has landed — so the watchdog above it cannot tell "still downloading, slowly"
  // from "died silently", which is the entire bug this streaming exists to fix.
  //
  // Allocated once, up front, and filled in place: accumulating parts and concatenating
  // afterwards would briefly hold two copies of every in-flight chunk, doubling the
  // FETCH_CONCURRENCY × CHUNK_BYTES memory ceiling that bounds this whole design.
  const body = response.body;
  if (!body) {
    // No streaming body — a test double, or some exotic environment. Fall back to
    // buffering, accepting that the watchdog degrades to a whole-transfer deadline here.
    const buffered = await response.arrayBuffer();
    onBytes();
    return checkedChunk(buffered, expected, filename, start);
  }

  const reader = body.getReader();
  const chunk = new Uint8Array(expected);
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (received + value.byteLength > expected) {
      throw new Error(
        `${filename} sent more than the ${expected} bytes requested at offset ${start}`,
      );
    }
    chunk.set(value, received);
    received += value.byteLength;
    onBytes();
  }

  return checkedChunk(chunk.buffer.slice(0, received), expected, filename, start);
}

/**
 * Refuse a chunk that isn't the length the range asked for.
 *
 * A short 206 would otherwise be written at the current offset and the *next* chunk
 * fetched from `start + CHUNK_BYTES` of the source — quietly misaligning everything after
 * it, and `finalizePartial` would promote the result as a complete archive. Same
 * principle as C1: fail loudly rather than hand someone a map that is wrong.
 */
function checkedChunk(
  chunk: ArrayBuffer,
  expected: number,
  filename: string,
  start: number,
): ArrayBuffer {
  if (chunk.byteLength === 0) {
    throw new Error(`Empty chunk for ${filename} at offset ${start}`);
  }
  if (chunk.byteLength !== expected) {
    throw new Error(
      `Short read for ${filename} at offset ${start}: got ${chunk.byteLength} of ` +
        `${expected} bytes`,
    );
  }
  return chunk;
}

/**
 * `fetchChunk`, but bounded by `CHUNK_TIMEOUT_MS` and retried on both timeout and ordinary
 * network failure — a flaky mobile connection produces both, and treating only one as
 * recoverable would still stall the whole download on the other.
 *
 * The timeout is a *derived* AbortController, not the caller's `signal` — the caller's
 * signal means "cancel", the timeout's means "try again", and collapsing them would turn
 * every retry into a permanent cancellation.
 */
export async function fetchChunkWithRetry(
  url: string,
  filename: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw new DownloadCancelled();

    const attemptController = new AbortController();
    const onOuterAbort = () => attemptController.abort();
    signal.addEventListener('abort', onOuterAbort);

    // Re-armed on every sign of life rather than set once, so the deadline is on silence
    // and not on the transfer. `stalled` records that *we* aborted: an AbortError alone
    // cannot say whether it came from this watchdog or from the user pressing Cancel.
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        attemptController.abort();
      }, CHUNK_STALL_TIMEOUT_MS);
    };
    watchdog();

    try {
      return await fetchChunk(url, filename, start, end, attemptController.signal, watchdog);
    } catch (err) {
      if (signal.aborted) throw new DownloadCancelled();
      const failure = stalled ? new DownloadStalled(filename, start) : err;
      if (attempt >= MAX_CHUNK_ATTEMPTS) throw failure;
      // Exponential backoff so a genuinely down connection doesn't hammer the bucket with
      // immediate retries — capped well under CHUNK_STALL_TIMEOUT_MS.
      await sleep(Math.min(500 * 2 ** (attempt - 1), 8_000), signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
    }
  }
}

/**
 * @param onStored called with the *absolute* number of bytes stored for this artifact so
 *   far — never an increment. Resume makes increments easy to double-count.
 */
export async function downloadArtifact(
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

  // Fetches run concurrently and can resolve out of order, but they are only ever
  // committed to OPFS in strict offset order (`nextToWrite`) — resolved chunks that arrive
  // early just wait in `ready`. That's what keeps `partialSize()` an honest contiguous
  // prefix: a crash mid-batch can only ever leave the file exactly as far along as the
  // original serial version would have, never with a gap in the middle that a later resume
  // would silently treat as real data (C1).
  //
  // `ready` counts against the concurrency budget as well as `inFlight`. Bounding only the
  // in-flight requests would let one stalled chunk pile every subsequent chunk up in
  // memory — each completion dispatching a replacement while nothing drains — so a slow
  // chunk 3 could buffer the rest of a multi-GB artifact into ArrayBuffers.
  let nextToDispatch = 0;
  let nextToWrite = 0;
  const inFlight = new Map<number, Promise<ArrayBuffer>>();
  const ready = new Map<number, ArrayBuffer>();

  const outstanding = (): number => inFlight.size + ready.size;

  const dispatch = (index: number): void => {
    const start = starts[index];
    const end = Math.min(start + CHUNK_BYTES, artifact.bytes) - 1;
    inFlight.set(index, fetchChunkWithRetry(url, artifact.filename, start, end, signal));
  };

  const fillWindow = (): void => {
    while (nextToDispatch < starts.length && outstanding() < FETCH_CONCURRENCY) {
      dispatch(nextToDispatch);
      nextToDispatch += 1;
    }
  };

  fillWindow();

  // One writer for the whole artifact. It holds an exclusive lock on the `.part` file, so
  // it has to be released before finalizePartial() can rename it — hence the finally.
  const writer = await openPartialWriter(artifact.filename);

  try {
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
        fillWindow();
        continue;
      }

      const chunk = ready.get(nextToWrite)!;
      ready.delete(nextToWrite);
      // The writer reports the length: it may have transferred the buffer, which leaves
      // `chunk.byteLength` reading 0 here.
      offset += await writer.append(chunk, offset);
      onStored(offset);
      nextToWrite += 1;

      // Writing out of `ready` frees a concurrency slot the same as a fetch resolving does
      // — skip this and the window never refills once the writer catches up to a batch
      // that resolved faster than it could be drained, which stalls forever the moment
      // `inFlight` and `ready` are both empty: `Promise.race([])` never settles. That dead
      // end lands at exactly FETCH_CONCURRENCY × CHUNK_BYTES every time, not at some
      // network-dependent point, which is what "stuck at the same byte count on different
      // downloads" was.
      fillWindow();
    }
  } finally {
    await writer.close();
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
    bytesPerSecond: null,
    etaSeconds: null,
  };

  const rate = new RateEstimator();
  // Monotonic, not Date.now(): a clock adjustment part-way through a multi-hundred-MB
  // download would otherwise show up as a negative or enormous interval.
  const emit = (): void => {
    rate.update(progress.receivedBytes, performance.now());
    progress.bytesPerSecond = rate.bytesPerSecond;
    progress.etaSeconds = rate.secondsRemaining(progress.receivedBytes, progress.totalBytes);
    options.onProgress?.({ ...progress });
  };

  try {
    let completedBytes = 0;

    for (const artifact of region.artifacts) {
      progress.currentArtifact = artifact.kind;

      await downloadArtifact(artifact, options.signal, (bytesStored) => {
        progress.receivedBytes = completedBytes + bytesStored;
        emit();
      });

      completedBytes += artifact.bytes;
      progress.receivedBytes = completedBytes;
      emit();
    }

    progress.currentArtifact = null;
    progress.done = true;
    progress.etaSeconds = null;
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
