import { afterEach, describe, expect, it } from 'vitest';
import { CHEATS } from '../src/game/cheats.js';
import { GAME } from '../src/game/config.js';
import {
  CHARGE_SECONDS,
  calculateReward,
  chargeToPower,
  chestsDue,
  coinPhase,
  coinFallPhase,
  NATURAL_FALL_Y,
  gildTargets,
  launchSpeedFor,
  quakeKick,
  rollSlotResult,
  slotWin,
} from '../src/game/rules.js';

describe('coinPhase', () => {
  it('does not score until a coin reaches the tray', () => {
    expect(coinPhase({ counted: false, falling: false }, { y: 0, z: GAME.edgeZ - 0.1 })).toBe('cross');
    expect(coinPhase({ counted: false, falling: true }, { y: GAME.trayY + 0.1, z: GAME.edgeZ + 0.3 })).toBeNull();
    expect(coinPhase({ counted: false, falling: true }, { y: GAME.trayY - 0.1, z: GAME.edgeZ + 0.3 })).toBe('score');
  });

  // The bug: `cross` used to fire only on the first frame past the lip, where a coin still has
  // 0.31 of deck under it. One that balanced there was latched as falling and never touched
  // again - hangs of up to 51s in the headless sandbox, with the pile behind it dammed.
  it('keeps nudging a body that has crossed the lip but is still on the deck', () => {
    const coin = { counted: false, falling: true };
    expect(coinPhase(coin, { y: 0.05, z: GAME.edgeZ - 0.02 })).toBe('cross');
    expect(coinPhase(coin, { y: 0.4, z: GAME.edgeZ - 0.2 })).toBe('cross');
  });

  it('never double-counts and silently recycles escapees', () => {
    expect(coinPhase({ counted: true, falling: true }, { y: -2, z: -4 })).toBeNull();
    expect(coinPhase({ counted: false, falling: false }, { y: GAME.lostY - 1, z: 0 })).toBe('lost');
  });
});

describe('coinFallPhase', () => {
  const front = () => GAME.playfieldFrontZ;

  it('leaves a coin hanging on the lip alone', () => {
    const coin = { counted: false, falling: false };
    expect(coinFallPhase(coin, { y: 0.05, z: GAME.edgeZ - 0.02 })).toBeNull();
    // Centre past the face but still held up by the corner or the pile: not a fall yet.
    expect(coinFallPhase(coin, { y: 0.02, z: front() - 0.05 })).toBeNull();
  });

  it('latches a coin once it has gone over and below the deck, then pays it straight away', () => {
    expect(coinFallPhase({ counted: false, falling: false }, { y: NATURAL_FALL_Y - 0.01, z: front() - 0.1 })).toBe('fall');
    // Wherever it is: a coin wedged high in a flooded chute must still pay and leave.
    expect(coinFallPhase({ counted: false, falling: true }, { y: NATURAL_FALL_Y - 0.01, z: front() - 0.1 })).toBe('score');
    expect(coinFallPhase({ counted: false, falling: true }, { y: 0.4, z: front() - 1.5 })).toBe('score');
  });

  it('does not count a coin that slips below the deck behind the face', () => {
    expect(coinFallPhase({ counted: false, falling: false }, { y: NATURAL_FALL_Y - 0.5, z: front() + 0.2 })).toBeNull();
  });

  it('latches the fall before calling a far-dropped coin lost', () => {
    expect(coinFallPhase({ counted: false, falling: false }, { y: GAME.lostY - 1, z: front() - 0.5 })).toBe('fall');
    expect(coinFallPhase({ counted: false, falling: false }, { y: GAME.lostY - 1, z: 0 })).toBe('lost');
    expect(coinFallPhase({ counted: true, falling: true }, { y: -2, z: -4 })).toBeNull();
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

// Legacy rail calibration remains covered while old saved tuning values are still supported.
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

describe('chestsDue', () => {
  const step = GAME.chestScoreStep;

  it('fires on the payout that crosses a threshold, and only that one', () => {
    expect(chestsDue(step - 3, step)).toBe(1);
    expect(chestsDue(step, step + 4)).toBe(0);
    expect(chestsDue(step - 3, step - 1)).toBe(0);
  });

  // Every threshold earns a chest, an avalanche across two included - dropChest queues them so
  // only one is ever in the air.
  it('asks for one chest per threshold a payout clears', () => {
    expect(chestsDue(step - 1, step * 2 + 1)).toBe(2);
    expect(chestsDue(0, step * 3)).toBe(3);
  });
});

describe('rollSlotResult', () => {
  it('pays a three of a kind across each outcome band', () => {
    let floor = 0;
    for (const { symbol, chance } of GAME.slotOutcomes) {
      expect(rollSlotResult(() => floor)).toEqual([symbol, symbol, symbol]);
      expect(rollSlotResult(() => floor + chance - 0.001)).toEqual([symbol, symbol, symbol]);
      floor += chance;
    }
  });

  // The request this guards: a chest rides the machine for a minute or two, and a miss at the end
  // of that read as the game taking it back. The shipped chances leave no room past the last band.
  it('always pays: the chances cover the whole roll', () => {
    const paid = GAME.slotOutcomes.reduce((sum, outcome) => sum + outcome.chance, 0);
    expect(paid).toBe(1);
    for (const roll of [0, 0.5, 0.999, 1 - Number.EPSILON]) {
      expect(slotWin(rollSlotResult(() => roll))).not.toBeNull();
    }
    for (const { chance } of GAME.slotOutcomes) expect(chance).toBeGreaterThan(0);
  });

  it('rolls real faces, never the idle one', () => {
    const symbols = GAME.slotOutcomes.map((outcome) => outcome.symbol);
    expect(symbols).not.toContain(GAME.slotIdleSymbol);
    for (const roll of [0, 0.3, 0.5, 0.7, 0.999]) {
      for (const face of rollSlotResult(() => roll)) expect(symbols).toContain(face);
    }
  });
});

describe('slotWin', () => {
  it('reports the symbol of a three of a kind', () => {
    expect(slotWin(['7', '7', '7'])).toBe('7');
    expect(slotWin(['bag', 'bag', 'bag'])).toBe('bag');
  });

  // Two alike pays nothing, whichever reel is the odd one out: main.js keys its prize table off
  // this symbol, so a stray non-null here is a prize paid on a losing line.
  it('pays nothing unless all three faces match', () => {
    expect(slotWin(['bag', 'bag', '7'])).toBeNull();
    expect(slotWin(['7', 'bag', 'bag'])).toBeNull();
    expect(slotWin(['bag', '7', 'bag'])).toBeNull();
    expect(slotWin(['7', 'bag', 'quake'])).toBeNull();
  });
});

describe('rollSlotResult with cheats.slot', () => {
  afterEach(() => { CHEATS.slot = null; });

  it('pins the result to a symbol or a miss', () => {
    CHEATS.slot = 'bag';
    expect(rollSlotResult(() => 0)).toEqual(['bag', 'bag', 'bag']);
    CHEATS.slot = 'miss';
    for (const roll of [0, 0.4, 0.999]) expect(slotWin(rollSlotResult(() => roll))).toBeNull();
  });

  // A typo must not quietly turn every chest into a loss, so it clears itself and rolls.
  it('drops an unknown symbol and rolls normally', () => {
    CHEATS.slot = 'diamond';
    expect(rollSlotResult(() => 0)).toEqual(['7', '7', '7']);
    expect(CHEATS.slot).toBeNull();
  });
});

describe('gildTargets', () => {
  const pile = (count, premium = 0) => Array.from({ length: count }, (_, index) => ({
    id: index,
    isPremium: index < premium,
    counted: false,
  }));

  it('takes the ratio of the plain coins, rounded up', () => {
    expect(gildTargets(pile(10), 0.3).length).toBe(3);
    // 8 plain of 10, and 0.3 of 8 is 2.4 - the round up is what stops a thin pile paying nothing.
    expect(gildTargets(pile(10, 2), 0.3).length).toBe(3);
    expect(gildTargets(pile(1), 0.3).length).toBe(1);
    expect(gildTargets(pile(10), 1).length).toBe(10);
    // Over 1 cannot gild a coin twice, and a machine with nothing plain on it pays nothing rather
    // than throwing - awardGild announces that case instead of showing a silent prize.
    expect(gildTargets(pile(10), 4).length).toBe(10);
    expect(gildTargets(pile(4, 4), 0.3)).toEqual([]);
    expect(gildTargets([], 0.3)).toEqual([]);
  });

  it('never picks the same coin twice, at any ratio', () => {
    for (const ratio of [0.1, 0.3, 0.5, 0.9, 1]) {
      const picked = gildTargets(pile(40), ratio);
      expect(new Set(picked.map((coin) => coin.id)).size).toBe(picked.length);
    }
  });

  // The two coins a gild must not touch: one already gold (nothing to pay), and one counted, which
  // is mid-payout - turning that gold shows a premium coin for points already scored as plain.
  it('leaves premium and counted coins alone', () => {
    const coins = pile(6, 3);
    coins[3].counted = true;
    const picked = gildTargets(coins, 1);
    expect(picked.map((coin) => coin.id).sort()).toEqual([4, 5]);
  });

  // The pick follows the random, not the list order: a gild that always took the front of
  // activeCoins would land on the seeded pile at the back of the machine every time and never on
  // what the player launched. Pinned high, the shuffle takes the last coin and then the ones it
  // swapped into that slot - never the prefix a broken selection would return.
  it('picks by the random rather than off the front of the list', () => {
    const picked = gildTargets(pile(10), 0.3, () => 0.999);
    expect(picked.map((coin) => coin.id)).toEqual([9, 0, 1]);
  });
});

describe('quakeKick', () => {
  it('always shakes coins towards the payout lip, never away from it', () => {
    for (const roll of [0, 0.5, 0.999]) {
      const kick = quakeKick(() => roll);
      expect(kick.z).toBeLessThan(0);
      expect(kick.y).toBeGreaterThanOrEqual(0);
      expect(Math.abs(kick.x)).toBeLessThanOrEqual(GAME.quakeJitter / 2);
    }
  });

  // Every axis has to stay under gravity, or the shake throws the pile off the table instead of
  // walking it forward. 24 is the world's gravity in CoinPusher.
  it('stays well under gravity on every axis', () => {
    const kick = quakeKick(() => 1);
    for (const axis of [kick.x, kick.y, kick.z]) expect(Math.abs(axis)).toBeLessThan(24);
  });
});
