import { describe, expect, it } from 'vitest';
import { RESET_CONFIRM_MS, resetConfirmed } from '../src/ui.js';

describe('reset confirmation', () => {
  it('needs a second tap inside the window, and a first tap only arms', () => {
    expect(resetConfirmed(-Infinity, 1000)).toBe(false);
    expect(resetConfirmed(1000, 1000 + RESET_CONFIRM_MS)).toBe(true);
    expect(resetConfirmed(1000, 1001 + RESET_CONFIRM_MS)).toBe(false);
  });
});
