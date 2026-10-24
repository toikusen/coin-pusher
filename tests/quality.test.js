import { describe, expect, it } from 'vitest';
import { isLowPower } from '../src/game/config.js';

describe('isLowPower', () => {
  it('does not treat WebKit\'s missing deviceMemory as a small device', () => {
    expect(isLowPower({ memory: undefined, cores: 8 })).toBe(false);
    expect(isLowPower({ memory: undefined, cores: undefined })).toBe(false);
  });

  it('takes the cheap path when asked or when the device says it is small', () => {
    expect(isLowPower({ reducedMotion: true, memory: 8, cores: 8 })).toBe(true);
    expect(isLowPower({ memory: 2, cores: 8 })).toBe(true);
    expect(isLowPower({ memory: 8, cores: 2 })).toBe(true);
  });
});
