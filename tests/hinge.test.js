import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false, getState: vi.fn(), addListener: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.enabled },
  registerPlugin: () => ({ getState: native.getState, addListener: native.addListener }),
}));

import { hasHinge, watchHinge } from '../src/hinge.js';

describe('watchHinge', () => {
  beforeEach(() => {
    native.enabled = false;
    native.getState.mockReset();
    native.addListener.mockReset();
  });

  it('does nothing on the web and returns an unsubscribe function', () => {
    const onChange = vi.fn();
    const unsubscribe = watchHinge(onChange);

    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    expect(onChange).not.toHaveBeenCalled();
    expect(native.getState).not.toHaveBeenCalled();
    expect(native.addListener).not.toHaveBeenCalled();
  });

  it('delivers the initial state and updates, then removes the listener', async () => {
    native.enabled = true;
    const initial = { angle: 180, status: 'fullyOpen' };
    const updated = { angle: 92, status: 'partiallyOpen' };
    const remove = vi.fn();
    let emitChange;
    native.getState.mockResolvedValue(initial);
    native.addListener.mockImplementation(async (_event, callback) => {
      emitChange = callback;
      return { remove };
    });
    const onChange = vi.fn();

    const unsubscribe = watchHinge(onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(initial));
    emitChange(updated);
    expect(onChange).toHaveBeenLastCalledWith(updated);
    unsubscribe();
    emitChange({ angle: null, status: 'unknown' });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe('hasHinge', () => {
  it('takes a phone that reports no hinge for a plain phone', () => {
    expect(hasHinge({ angle: null, status: 'unknown' })).toBe(false);
    expect(hasHinge({ angle: null, status: 'fullyOpen' })).toBe(true);
    expect(hasHinge({ angle: 120, status: 'partiallyOpen' })).toBe(true);
    expect(hasHinge({ angle: 30, status: 'closed' })).toBe(true);
  });
});
