import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({ impact: vi.fn(), notification: vi.fn() }));
vi.mock('@capacitor/haptics', () => ({
  Haptics: plugin,
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM' },
  NotificationType: { Success: 'SUCCESS' },
}));

import { tapHaptic, thudHaptic, winHaptic } from '../src/haptics.js';

describe('haptics', () => {
  beforeEach(() => {
    plugin.impact.mockReset();
    plugin.notification.mockReset();
  });

  it('maps each moment to its feel', async () => {
    plugin.impact.mockResolvedValue();
    plugin.notification.mockResolvedValue();
    await tapHaptic();
    await thudHaptic();
    await winHaptic();
    expect(plugin.impact.mock.calls).toEqual([[{ style: 'LIGHT' }], [{ style: 'MEDIUM' }]]);
    expect(plugin.notification).toHaveBeenCalledWith({ type: 'SUCCESS' });
  });

  // A phone without a Taptic Engine, or a browser, rejects: that must never reach a payout.
  it('swallows a rejected call', async () => {
    plugin.impact.mockRejectedValue(new Error('unavailable'));
    plugin.notification.mockRejectedValue(new Error('unavailable'));
    await expect(tapHaptic()).resolves.toBeUndefined();
    await expect(winHaptic()).resolves.toBeUndefined();
  });
});
