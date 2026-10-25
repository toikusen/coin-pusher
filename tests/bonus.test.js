import { describe, expect, it } from 'vitest';
import { CoinPusher } from '../src/game/CoinPusher.js';
import { GAME } from '../src/game/config.js';

const SPIN = GAME.slotReelLocks.at(-1);

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
  callbacks: {},
  drawReels() {},
  reelAngle: CoinPusher.prototype.reelAngle,
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

    run(self, SPIN);
    expect(results).toHaveLength(1);
    // Reels held on the first result while the queue waits its turn.
    expect(self.slotSpin).toBeNull();

    run(self, GAME.slotHoldSeconds);
    expect(self.slotSpin).not.toBeNull();
    expect(self.slotQueue).toHaveLength(0);

    run(self, SPIN);
    expect(results).toHaveLength(2);
    expect(self.slotSpin).toBeNull();
  });

  it('rolls each queued chest its own faces', () => {
    const self = stage();
    const seen = [];
    // Enough chests that identical faces every time would be a coincidence, not a shared spin.
    for (let index = 0; index < 12; index += 1) self.spinSlot(() => seen.push(self.reelSymbols.join('')));
    run(self, 12 * (SPIN + GAME.slotHoldSeconds));
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('idles without a queue rather than holding the reels', () => {
    const self = stage();
    self.spinSlot(() => {});
    run(self, SPIN);
    expect(self.slotSpin).toBeNull();
    // No queue, so the next chest to pay spins on the spot - the hold is only ever paid between
    // two chests that landed together.
    self.spinSlot(() => {});
    expect(self.slotSpin).not.toBeNull();
  });
});

describe('slot spin feedback', () => {
  it('locks each reel once, flags the last, ticks only while it crawls in, and pays after', () => {
    const self = stage();
    const events = [];
    self.callbacks = {
      onReelStop: (index, last) => events.push(`stop${index}${last ? '!' : ''}`),
      onReelTick: () => events.push('tick'),
    };
    self.spinSlot((win) => events.push(`pay:${win}`));
    run(self, SPIN + 0.1);
    const stops = events.filter((event) => event.startsWith('stop'));
    expect(stops).toEqual(['stop0', 'stop1', 'stop2!']);
    const ticks = events.map((event, index) => [event, index]).filter(([event]) => event === 'tick');
    expect(ticks.length).toBeGreaterThan(2);
    // Every tick between the second reel's lock and the last's.
    for (const [, index] of ticks) {
      expect(index).toBeGreaterThan(events.indexOf('stop1'));
      expect(index).toBeLessThan(events.indexOf('stop2!'));
    }
    expect(events.at(-1)).toMatch(/^pay:/);
    expect(events.at(-1)).not.toBe('pay:null');
  });
});

// dropChest and retireChest through the prototype, with a body that only records what it is told.
const chestStage = () => {
  const fakeChest = () => ({
    body: { setEnabled() {}, setPose() {}, setAngularVelocity() {} },
    mesh: { visible: false },
  });
  return {
    chestPrototype: {},
    settling: false,
    chests: [],
    chestPool: [],
    pendingChests: [],
    waitingChests: [],
    chestHalfDepth: 0.4,
    callbacks: {},
    slotQueue: [],
    camera: { position: { copy() {} } },
    cameraBase: {},
    acquireChest: fakeChest,
    chestDropX: () => 0,
    dropChest: CoinPusher.prototype.dropChest,
    retireChest: CoinPusher.prototype.retireChest,
    cancelChest: CoinPusher.prototype.cancelChest,
  };
};

describe('chests on the machine', () => {
  it('holds extra chests back and drops one each time a chest leaves, losing none', () => {
    const self = chestStage();
    const dropped = [];
    self.callbacks.onChestDrop = () => dropped.push(self.chests.length);
    for (let index = 0; index < 5; index += 1) self.dropChest(() => {});
    expect(self.chests).toHaveLength(GAME.chestsOnMachine);
    expect(self.waitingChests).toHaveLength(5 - GAME.chestsOnMachine);
    while (self.chests.length > 0) self.retireChest(0);
    expect(dropped).toHaveLength(5);
    expect(self.waitingChests).toHaveLength(0);
  });

  it('clears the queue on a cancel instead of dropping it', () => {
    const self = chestStage();
    for (let index = 0; index < 4; index += 1) self.dropChest(() => {});
    self.cancelChest();
    expect(self.chests).toHaveLength(0);
    expect(self.waitingChests).toHaveLength(0);
  });
});

describe('coin rain on a full machine', () => {
  it('pauses while the machine is full and finishes the bag once it drains', () => {
    let sent = 0;
    const self = {
      coinRain: null,
      full: false,
      sendDownBoard: () => { sent += 1; },
      rainCoins: CoinPusher.prototype.rainCoins,
      updateCoinRain: CoinPusher.prototype.updateCoinRain,
    };
    self.rainCoins(10);
    self.full = true;
    for (let step = 0; step < 600; step += 1) self.updateCoinRain(1 / 60);
    expect(sent).toBe(0);
    self.full = false;
    for (let step = 0; step < 600; step += 1) self.updateCoinRain(1 / 60);
    expect(sent).toBe(10);
  });
});
