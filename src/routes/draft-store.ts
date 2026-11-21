import { DRAFT_STORE, tx } from '../app/db';
import type { DraftSnapshot } from './route-planner';

// The route on screen, kept across a reload: one record, overwritten on every change.
//
// Not a saved route. Saving is still a decision the person makes; this is only so that
// iOS ending the app in the background, an update reloading the page, or a crash, does not
// take with it a route half planned — or the one being followed, on a hill.

const KEY = 'current';

interface StoredDraft extends DraftSnapshot {
  id: typeof KEY;
  savedAt: number;
}

/** Keep `draft` as the route on screen, or forget it when null. */
export async function writeDraft(draft: DraftSnapshot | null): Promise<void> {
  if (draft === null) {
    await tx(DRAFT_STORE, 'readwrite', (store) => store.delete(KEY));
    return;
  }
  const record: StoredDraft = { ...draft, id: KEY, savedAt: Date.now() };
  await tx(DRAFT_STORE, 'readwrite', (store) => store.put(record));
}

/** The route that was on screen when the page last went away, if there was one. */
export async function readDraft(): Promise<DraftSnapshot | null> {
  const record = await tx<StoredDraft | undefined>(DRAFT_STORE, 'readonly', (store) => store.get(KEY));
  if (!record || !Array.isArray(record.waypoints) || record.waypoints.length === 0) return null;
  const { id: _id, savedAt: _savedAt, ...draft } = record;
  return draft;
}

/**
 * Coalesces a burst of changes — a drag, a route's legs arriving one after another — into
 * one write, and writes at once when the page is hidden: the moment before iOS may end it.
 */
export class DraftKeeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;
  private readonly read: () => DraftSnapshot | null;
  private readonly onError: (err: Error) => void;
  private readonly delayMs: number;

  constructor(read: () => DraftSnapshot | null, onError: (err: Error) => void, delayMs = 500) {
    this.read = read;
    this.onError = onError;
    this.delayMs = delayMs;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
    window.addEventListener('pagehide', () => this.flush());
  }

  /** Something changed: write it soon. */
  changed(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Write now, if a write is waiting. */
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    writeDraft(this.read()).then(
      () => {
        this.failed = false;
      },
      (err: Error) => {
        // Said once, not on every edit: the route on screen is still there, it just will
        // not survive a reload until storage works again.
        if (!this.failed) this.onError(err);
        this.failed = true;
      },
    );
  }
}
