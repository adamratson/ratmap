import { isNetworkFailure } from '../map/network-status';
import type { StatusCentre } from '../ui/status';

// The last line of error handling: whatever nothing else caught.
//
// Every failure the app anticipates is handled where it happens — a download says why it
// stopped, a save says it did not save. This is for the ones nobody anticipated. Before
// it, a promise that rejected with no handler, or a throw inside an event listener,
// reached nothing but a console no one on a hill will ever open: the app would simply
// stop doing something, with no sign that anything had gone wrong.

const CONDITION_KEY = 'uncaught';

/** Report uncaught errors and unhandled rejections as a dismissable error condition. */
export function reportUncaughtErrors(
  status: Pick<StatusCentre, 'setCondition'>,
  target: Pick<Window, 'addEventListener'> = window,
): void {
  const report = (reason: unknown): void => {
    // Still logged in full, with its stack, for whoever does open the console.
    console.error('Uncaught', reason);

    // Read by shape, not `instanceof Error`: a DOMException — what an abort rejects with —
    // is not an Error in every engine, and a cancellation must not be reported as a fault.
    const error =
      typeof reason === 'object' && reason !== null && 'message' in reason
        ? (reason as Error)
        : undefined;
    // A cancellation is the app working as intended — a superseded route, a closed sheet.
    if (error?.name === 'AbortError') return;
    // Lost signal is an expected state with a condition of its own ("No connection"),
    // raised by the map as tiles fail. Calling it a fault here would contradict it.
    if (isNetworkFailure(error)) return;

    const detail = error?.message || (typeof reason === 'string' ? reason : 'unknown error');
    status.setCondition(CONDITION_KEY, {
      message: `Something went wrong: ${detail}. If part of the app stops responding, reopening it should help.`,
      kind: 'error',
      // Unlike the conditions that track something still true, nothing will clear this on
      // its own — so the person reading it can.
      action: { label: 'Dismiss', onSelect: () => status.setCondition(CONDITION_KEY, null) },
    });
  };

  target.addEventListener('unhandledrejection', (event) => report((event as PromiseRejectionEvent).reason));
  target.addEventListener('error', (event) => report((event as ErrorEvent).error ?? (event as ErrorEvent).message));
}
