import { describe, expect, it } from 'vitest';
import { GAME } from '../src/game/config.js';
import {
  aimLabel,
  calculateReward,
  clampAim,
  coinPhase,
  screenAimToWorld,
  worldAimToScreen,
} from '../src/game/rules.js';

describe('coinPhase', () => {
  it('does not score until a coin reaches the tray', () => {
    expect(coinPhase({ counted: false, falling: false }, { y: 0, z: GAME.edgeZ - 0.1 })).toBe('cross');
    expect(coinPhase({ counted: false, falling: true }, { y: GAME.trayY + 0.1, z: -4 })).toBeNull();
    expect(coinPhase({ counted: false, falling: true }, { y: GAME.trayY - 0.1, z: -4 })).toBe('score');
  });

  it('never double-counts and silently recycles escapees', () => {
    expect(coinPhase({ counted: true, falling: true }, { y: -2, z: -4 })).toBeNull();
    expect(coinPhase({ counted: false, falling: false }, { y: GAME.lostY - 1, z: 0 })).toBe('lost');
  });
});

describe('calculateReward', () => {
  it('values premium coins at three points', () => {
    expect(calculateReward([{ isPremium: false }, { isPremium: true }], 0, Infinity)).toEqual({
      base: 4,
      combo: 2,
      bonus: 0,
      total: 4,
    });
  });

  it('awards a combo bonus at five consecutive coins', () => {
    expect(calculateReward([{ isPremium: false }, { isPremium: false }], 3, 0.5)).toEqual({
      base: 2,
      combo: 5,
      bonus: GAME.comboBonus,
      total: 2 + GAME.comboBonus,
    });
  });
});

describe('aim helpers', () => {
  it('clamps the aim to the playable shelf', () => {
    expect(clampAim(-9)).toBe(-1.95);
    expect(clampAim(9)).toBe(1.95);
    expect(clampAim(0.5)).toBe(0.5);
  });

  it('provides a concise accessible label', () => {
    expect(aimLabel(-1)).toBe('偏左');
    expect(aimLabel(0)).toBe('置中');
    expect(aimLabel(1)).toBe('偏右');
  });

  it('maps screen-right to world negative X for the front-facing camera', () => {
    expect(screenAimToWorld(1)).toBe(-1);
    expect(screenAimToWorld(-1)).toBe(1);
    expect(worldAimToScreen(-1)).toBe(1);
  });
});
