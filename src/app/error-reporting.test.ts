import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Condition, StatusCentre } from '../ui/status';
import { reportUncaughtErrors } from './error-reporting';

let target: EventTarget;
let status: { setCondition: Mock<StatusCentre['setCondition']> };

function rejectUnhandled(reason: unknown): void {
  target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
}
function throwUncaught(error: unknown): void {
  target.dispatchEvent(Object.assign(new Event('error'), { error, message: String(error) }));
}
const shown = () => status.setCondition.mock.lastCall?.[1] as Condition | null | undefined;

beforeEach(() => {
  target = new EventTarget();
  status = { setCondition: vi.fn() };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reportUncaughtErrors(status, target as unknown as Window);
});

describe('reportUncaughtErrors', () => {
  it('turns an unhandled rejection into an error condition, rather than nothing', () => {
    rejectUnhandled(new Error('IndexedDB blocked'));

    expect(status.setCondition).toHaveBeenCalledWith('uncaught', expect.objectContaining({ kind: 'error' }));
    expect(shown()!.message).toMatch(/Something went wrong: IndexedDB blocked/);
  });

  it('does the same for a throw inside an event listener', () => {
    throwUncaught(new TypeError("Cannot read properties of null (reading 'x')"));

    expect(shown()!.message).toMatch(/reading 'x'/);
  });

  it('still logs the whole error, stack and all, for whoever opens the console', () => {
    const error = new Error('boom');
    rejectUnhandled(error);

    expect(console.error).toHaveBeenCalledWith('Uncaught', error);
  });

  it('stays quiet about a cancellation, which is the app working as intended', () => {
    rejectUnhandled(new DOMException('The operation was aborted.', 'AbortError'));
    expect(status.setCondition).not.toHaveBeenCalled();
  });

  it('leaves lost signal to the "No connection" condition, rather than calling it a fault', () => {
    rejectUnhandled(new TypeError('Failed to fetch'));
    expect(status.setCondition).not.toHaveBeenCalled();
  });

  it('copes with something thrown that is not an Error', () => {
    rejectUnhandled('plain string');
    expect(shown()!.message).toMatch(/Something went wrong: plain string/);
  });

  it('can be dismissed, since nothing else will clear it', () => {
    rejectUnhandled(new Error('boom'));

    shown()!.action!.onSelect();

    expect(status.setCondition).toHaveBeenLastCalledWith('uncaught', null);
  });
});
