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
 * Writes every change at once, coalescing only while a write is still in flight: changes
 * that arrive during one — a route's legs landing one after another — become one more
 * write of the latest state when it lands.
 *
 * Not on a timer. With even half a second's pause, saving a route straight after editing
 * it and then reloading brought it back as "Not saved": the copy from before the save,
 * since the one after was still waiting out the pause. A write takes milliseconds.
 */
export class DraftKeeper {
  private writing = false;
  /** A change arrived while a write was in flight. */
  private pending = false;
  private failed = false;
  private readonly read: () => DraftSnapshot | null;
  private readonly onError: (err: Error) => void;

  constructor(read: () => DraftSnapshot | null, onError: (err: Error) => void) {
    this.read = read;
    this.onError = onError;
  }

  /** Something changed: write it now, or as soon as the write in flight lands. */
  changed(): void {
    if (this.writing) {
      this.pending = true;
      return;
    }
    this.write();
  }

  private write(): void {
    this.writing = true;
    writeDraft(this.read())
      .then(
        () => {
          this.failed = false;
        },
        (err: Error) => {
          // Said once, not on every edit: the route on screen is still there, it just will
          // not survive a reload until storage works again.
          if (!this.failed) this.onError(err);
          this.failed = true;
        },
      )
      .finally(() => {
        this.writing = false;
        if (!this.pending) return;
        this.pending = false;
        this.write();
      });
  }
}
