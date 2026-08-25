import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PRESS_HOLD_MS, PRESS_HOLD_SLOP_PX, onPressHold } from './press-hold';

/**
 * jsdom has no PointerEvent constructor, but its listeners dispatch by event name — a
 * MouseEvent carrying the fields this module reads is indistinguishable to the code under
 * test.
 */
function pointer(type: string, init: Partial<PointerEvent> = {}): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX: 0, clientY: 0, ...init });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'touch' });
  return event as unknown as PointerEvent;
}

describe('onPressHold', () => {
  let element: HTMLElement;
  let onHold: Mock<() => void>;
  let onStart: Mock<() => void>;
  let onCancel: Mock<() => void>;
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement('div');
    document.body.append(element);
    onHold = vi.fn();
    onStart = vi.fn();
    onCancel = vi.fn();
    dispose = onPressHold(element, { onHold, onStart, onCancel });
  });

  afterEach(() => {
    dispose();
    element.remove();
    vi.useRealTimers();
  });

  it('fires after the press is held for the full duration', () => {
    element.dispatchEvent(pointer('pointerdown'));
    expect(onStart).toHaveBeenCalledOnce();
    expect(onHold).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PRESS_HOLD_MS);
    expect(onHold).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not fire when the press is released early', () => {
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(PRESS_HOLD_MS - 1);
    element.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(1000);

    expect(onHold).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not fire once the pointer has moved far enough to be a drag', () => {
    element.dispatchEvent(pointer('pointerdown'));
    element.dispatchEvent(pointer('pointermove', { clientX: PRESS_HOLD_SLOP_PX + 1 }));
    vi.advanceTimersByTime(1000);

    expect(onHold).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('tolerates the wobble of a finger resting on the target', () => {
    // MapLibre starts dragging at 3px; a hold that died there would read as broken.
    element.dispatchEvent(pointer('pointerdown'));
    element.dispatchEvent(pointer('pointermove', { clientX: 4, clientY: 3 }));
    vi.advanceTimersByTime(PRESS_HOLD_MS);

    expect(onHold).toHaveBeenCalledOnce();
  });

  it('ignores a secondary mouse button, which contextmenu already handles', () => {
    element.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }));
    vi.advanceTimersByTime(1000);

    expect(onStart).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('cancels when the pointer is cancelled by the browser', () => {
    element.dispatchEvent(pointer('pointerdown'));
    element.dispatchEvent(pointer('pointercancel'));
    vi.advanceTimersByTime(1000);

    expect(onHold).not.toHaveBeenCalled();
  });

  it('stops firing after it is disposed', () => {
    element.dispatchEvent(pointer('pointerdown'));
    dispose();
    vi.advanceTimersByTime(1000);

    expect(onHold).not.toHaveBeenCalled();
    // A disposer is not a cancellation the user made; it must not report one.
    expect(onCancel).not.toHaveBeenCalled();
  });
});
