import { describe, expect, it } from 'vitest';
import { GAME } from '../src/game/config.js';
import {
  CHARGE_SECONDS,
  calculateReward,
  chargeToPower,
  coinPhase,
  launchSpeedFor,
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

  it('pays the bonus once per chain, not on every payout above the threshold', () => {
    const next = calculateReward([{ isPremium: false }], GAME.comboThreshold, 0.5);
    expect(next).toMatchObject({ combo: GAME.comboThreshold + 1, bonus: 0, total: 1 });
  });

  // A payout is one frame's worth of coins, so an avalanche is delivered over several calls.
  // Splitting it must not change what it is worth, or the score tracks the frame rate.
  it('scores an avalanche the same whether it lands in one frame or many', () => {
    const coins = Array.from({ length: 12 }, () => ({ isPremium: false }));
    const single = calculateReward(coins, 0, Infinity);

    let combo = 0;
    let total = 0;
    let elapsed = Infinity;
    for (const size of [3, 4, 3, 2]) {
      const result = calculateReward(coins.slice(0, size), combo, elapsed);
      combo = result.combo;
      total += result.total;
      elapsed = 0.02;
    }

    expect(combo).toBe(single.combo);
    expect(total).toBe(single.total);
  });
});

// Hold-to-charge is the only control now, so the curve it produces is the whole input contract.
describe('charge', () => {
  it('reaches full power exactly at the hold time, and never past it', () => {
    expect(chargeToPower(CHARGE_SECONDS)).toBe(1);
    expect(chargeToPower(CHARGE_SECONDS * 4)).toBe(1);
  });

  // A tap has to be a usable weak launch, not a wasted coin, and holding forever must not be
  // punished either - between them that is what makes the control forgiving.
  it('treats a tap as the weakest launch rather than nothing', () => {
    expect(chargeToPower(0)).toBe(0);
    expect(chargeToPower(-1)).toBe(0);
    expect(launchSpeedFor(chargeToPower(0))).toBeCloseTo(GAME.railSpeedMin, 8);
  });

  it('rises evenly across the hold', () => {
    expect(chargeToPower(CHARGE_SECONDS / 2)).toBeCloseTo(0.5, 8);
  });
});
