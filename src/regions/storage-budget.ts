import type { Region } from './manifest';

// C1: refuse to start a region download unless we can actually keep it. Two independent
// gates, both of which must pass:
//
//   1. persist() was granted — otherwise the browser may evict the archive with no
//      warning, and the user finds out with no signal, on a mountain.
//   2. estimate() shows room for the region — otherwise the download fails partway
//      through and wastes a long transfer.
//
// Never silently proceed on "probably fine": explain which gate failed.

export type DownloadGate =
  | { allowed: true; availableBytes: number | null }
  | { allowed: false; reason: 'not-persisted' | 'insufficient-space' | 'unsupported'; message: string };

export interface StorageSnapshot {
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  availableBytes: number | null;
}

export async function readStorage(): Promise<StorageSnapshot> {
  const persisted = (await navigator.storage?.persisted?.()) ?? false;

  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    usageBytes = estimate.usage ?? null;
    quotaBytes = estimate.quota ?? null;
  }

  const availableBytes =
    usageBytes !== null && quotaBytes !== null ? Math.max(quotaBytes - usageBytes, 0) : null;

  return { persisted, usageBytes, quotaBytes, availableBytes };
}

/**
 * Headroom kept free on top of the region size. Quota is an estimate, not a promise, and
 * filling it exactly tends to fail near the end — which is the most expensive moment.
 */
const HEADROOM_BYTES = 50 * 1024 * 1024;

export function evaluateGate(region: Region, storage: StorageSnapshot): DownloadGate {
  if (!storage.persisted) {
    return {
      allowed: false,
      reason: 'not-persisted',
      message:
        'Persistent storage has not been granted, so downloaded maps could be deleted by ' +
        'the browser without warning. Install the app to your home screen first.',
    };
  }

  if (storage.availableBytes === null) {
    // Can't measure. Allow, because refusing on every browser that lacks estimate() would
    // block downloads that would work fine — but say so rather than implying we checked.
    return { allowed: true, availableBytes: null };
  }

  if (storage.availableBytes < region.totalBytes + HEADROOM_BYTES) {
    return {
      allowed: false,
      reason: 'insufficient-space',
      message:
        `Not enough free storage for ${region.name}. Needs about ` +
        `${Math.ceil((region.totalBytes + HEADROOM_BYTES) / 1e6)} MB, but only ` +
        `${Math.floor(storage.availableBytes / 1e6)} MB is available.`,
    };
  }

  return { allowed: true, availableBytes: storage.availableBytes };
}
