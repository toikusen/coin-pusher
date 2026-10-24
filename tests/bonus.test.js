import { describe, expect, it } from 'vitest';
import { CoinPusher } from '../src/game/CoinPusher.js';
import { GAME } from '../src/game/config.js';

// The bonus stage's spin queue, driven through the prototype rather than a real CoinPusher: the
// constructor wants a canvas, a GPU and the model files, and none of that decides who spins when.
// Everything updateBonus touches on the way to the reels is stubbed flat.
const stage = () => ({
  chests: [],
  coinRain: null,
  quake: null,
  slotSpin: null,
  slotQueue: [],
  slotHold: 0,
  reelDrums: [],
  reelSymbols: [GAME.slotIdleSymbol, GAME.slotIdleSymbol, GAME.slotIdleSymbol],
  reelPanel: { position: { y: 0, z: 0 }, getWorldPosition: (target) => target.set(0, 0, 0) },
  drawReels() {},
  emitParticles() {},
  spinSlot: CoinPusher.prototype.spinSlot,
  startSpin: CoinPusher.prototype.startSpin,
  updateBonus: CoinPusher.prototype.updateBonus,
  updateCoinRain: CoinPusher.prototype.updateCoinRain,
  updateQuake: CoinPusher.prototype.updateQuake,
});

// Long enough to finish whatever is running, short enough to stay on the frame it lands.
const run = (self, seconds) => {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) self.updateBonus(1 / 60);
};

describe('slot spin queue', () => {
  it('spins once per chest instead of sharing one result', () => {
    const self = stage();
    const results = [];
    self.spinSlot((win) => results.push(win));
    self.spinSlot((win) => results.push(win));

    // The second chest paid mid-spin: it is waiting, not riding along.
    expect(self.slotQueue).toHaveLength(1);
    expect(self.slotSpin.notify).toBeTypeOf('function');

    run(self, GAME.slotSpinSeconds);
    expect(results).toHaveLength(1);
    // Reels held on the first result while the queue waits its turn.
    expect(self.slotSpin).toBeNull();

    run(self, GAME.slotHoldSeconds);
    expect(self.slotSpin).not.toBeNull();
    expect(self.slotQueue).toHaveLength(0);

    run(self, GAME.slotSpinSeconds);
    expect(results).toHaveLength(2);
    expect(self.slotSpin).toBeNull();
  });

  it('rolls each queued chest its own faces', () => {
    const self = stage();
    const seen = [];
    // Enough chests that identical faces every time would be a coincidence, not a shared spin.
    for (let index = 0; index < 12; index += 1) self.spinSlot(() => seen.push(self.reelSymbols.join('')));
    run(self, 12 * (GAME.slotSpinSeconds + GAME.slotHoldSeconds));
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('idles without a queue rather than holding the reels', () => {
    const self = stage();
    self.spinSlot(() => {});
    run(self, GAME.slotSpinSeconds);
    expect(self.slotSpin).toBeNull();
    // No queue, so the next chest to pay spins on the spot - the hold is only ever paid between
    // two chests that landed together.
    self.spinSlot(() => {});
    expect(self.slotSpin).not.toBeNull();
  });
});
