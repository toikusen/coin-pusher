import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { initPhysics } from '../src/game/world.js';
import { BED_WIDTH, GLASS_X, FIXED_STEP, createMachine, createWorld, spawnCoin, spawnChest } from './machine.js';
import { GAME } from '../src/game/config.js';
import { coinFallPhase, landingXFor, launchSpeedFor } from '../src/game/rules.js';
import {
  COIN_COIN_FRICTION,
  COIN_GROUND_FRICTION,
  COIN_COLLIDER_PAD,
  COIN_HEIGHT,
  COIN_MASS,
  COIN_PUSHER_FRICTION,
  COIN_RADIUS,
  LOWER_SEED_COUNT,
  lowerSlotsPerLayer,
  TUNING_DEFAULTS,
  applyCoinTuning,
  chestDropZ,
  createCoinBody,
  nudgeOverLip,
  pusherMotionAt,
  onLowerBed,
  lowerBladeReachZ,
  machineFullFor,
  MACHINE_FULL_AT,
  MACHINE_RESUME_AT,
  seedPosition,
  settleChestOnLowerBed,
} from '../src/game/physics.js';

// What getQualityProfile seeds (seedCount 100): the whole lower pile plus 30 riding the tray.
const SEED_COUNT = LOWER_SEED_COUNT + 30;
const worlds = [];
const track = (world) => { worlds.push(world); return world; };
const testWorld = (options) => track(createWorld(options));
const testMachine = () => {
  const machine = createMachine();
  track(machine.world);
  return machine;
};
beforeAll(async () => { await initPhysics(); });
afterEach(() => { for (const world of worlds.splice(0)) world.free(); });
const advance = (world, seconds) => {
  for (let i = 0; i < Math.round(seconds / world.fixedStep); i += 1) world.stepOnce();
};
const addFloor = (world) => world.addStaticBox({ x: 2.5, y: 0.25, z: 3 }, { x: 0, y: -0.25, z: 0 });
const expectVector = (actual, expected) => {
  for (const axis of ['x', 'y', 'z']) expect(actual[axis]).toBeCloseTo(expected[axis], 6);
};

describe('coin collision bodies', () => {
  it('creates independent Y-up coins that land without tunnelling through the shelf', () => {
    const world = testWorld({ tilt: 0 });
    addFloor(world);
    const first = spawnCoin(world, { x: -1, y: 4, z: 0 });
    const second = spawnCoin(world, { x: 1, y: 4, z: 0 });
    expect(first).not.toBe(second);
    advance(world, 4);
    for (const coin of [first, second]) {
      expect(coin.position.y).toBeGreaterThan(0);
      expect(coin.position.y).toBeLessThan(0.2);
      // Rests on its padded collider, sunk into the shelf about as far as the padding.
      expect(coin.position.y).toBeCloseTo((COIN_HEIGHT + COIN_COLLIDER_PAD) / 2, 2);
    }
  });

  it('keeps table friction consistent across fixed-step rates', () => {
    const travelAt = (fixedStep) => {
      const world = testWorld({ fixedStep, tilt: 0 });
      addFloor(world);
      const coin = spawnCoin(world, { x: 0, y: COIN_HEIGHT / 2 + 0.01, z: 1 });
      coin.setVelocity({ x: 0, y: 0, z: -1 });
      advance(world, 2);
      return 1 - coin.position.z;
    };
    const travel60 = travelAt(FIXED_STEP);
    const travel120 = travelAt(1 / 120);
    // A coin at 1 u/s on a flat table stops after v^2 / (2 mu g): the coefficient means what it says.
    const expected = 1 / (2 * TUNING_DEFAULTS.groundFriction * 24);
    expect(travel60).toBeCloseTo(expected, 1);
    expect(travel120).toBeCloseTo(expected, 1);
    expect(Math.abs(travel60 - travel120)).toBeLessThan(expected * 0.2);
  });

  it('puts a dense multi-layer stack fully to sleep', () => {
    const world = testWorld({ tilt: 0 });
    addFloor(world);
    const coins = [];
    for (let layer = 0; layer < 3; layer += 1) {
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          const angle = ((row + column + layer) % 2 === 0 ? 1 : -1) * 0.035;
          coins.push(spawnCoin(world, {
            x: (column - 1) * 0.74 + (layer % 2) * 0.025,
            y: 0.07 + layer * 0.135,
            z: (row - 1) * 0.74 - (layer % 2) * 0.025,
          }, { x: Math.sin(angle / 2) / Math.SQRT2, y: 0,
            z: Math.sin(angle / 2) / Math.SQRT2, w: Math.cos(angle / 2) }));
        }
      }
    }
    advance(world, 10);
    expect(coins.every((body) => body.sleeping)).toBe(true);
    for (const body of coins) {
      expectVector(body.velocity, { x: 0, y: 0, z: 0 });
      expectVector(body.angularVelocity, { x: 0, y: 0, z: 0 });
    }
  });
});

describe('bonus chest landing', () => {
  it('absorbs forward momentum once when the chest reaches the lower bed', () => {
    const body = spawnChest(testWorld(), { x: 0, y: 1, z: GAME.edgeZ + 0.1 });
    body.setVelocity({ x: 0.4, y: -2, z: -3 });
    body.setAngularVelocity({ x: 2, y: 4, z: 6 });
    const drop = { lowerBedLanded: false };
    expect(settleChestOnLowerBed(body, drop, 0.4, 0.45)).toBe(false);
    expect(drop.lowerBedLanded).toBe(false);
    body.setPose({ x: 0, y: 0.4, z: GAME.edgeZ + 0.45 + COIN_RADIUS + 1 });
    expect(settleChestOnLowerBed(body, drop, 0.4, 0.45)).toBe(true);
    expect(drop.lowerBedLanded).toBe(true);
    expect(body.velocity.z).toBe(0);
    expectVector(body.angularVelocity, { x: 0.5, y: 1, z: 1.5 });
    body.setVelocity({ x: 0, y: 0, z: -1 });
    expect(settleChestOnLowerBed(body, drop, 0.4, 0.45)).toBe(false);
    expect(body.velocity.z).toBe(-1);
  });

  it('leaves a chest that is already over the lip to its payout', () => {
    const startZ = GAME.edgeZ - 0.05;
    const body = spawnChest(testWorld(), { x: 0, y: 0.4, z: startZ });
    body.setVelocity({ x: 0, y: -1.5, z: -3 });
    expect(settleChestOnLowerBed(body, { lowerBedLanded: false }, 0.4, 0.45)).toBe(false);
    expect(body.position.z).toBe(startZ);
    expect(body.velocity.z).toBe(-3);
  });
});

describe('payout lip nudge', () => {
  it('only adds the motion a stalled body is missing', () => {
    const world = testWorld({ tilt: 0 });
    addFloor(world);
    const stalled = spawnCoin(world, { x: 0, y: 0.06, z: 0 });
    advance(world, 4);
    expect(stalled.sleeping).toBe(true);
    nudgeOverLip(stalled);
    expectVector(stalled.velocity, { x: 0, y: -1.5, z: -3 });
    expect(stalled.sleeping).toBe(false);
    const falling = spawnCoin(world, { x: 1, y: 4, z: 0 });
    falling.setVelocity({ x: 0, y: -8, z: -4 });
    falling.setAngularVelocity({ x: 1, y: 2, z: 3 });
    nudgeOverLip(falling);
    expectVector(falling.velocity, { x: 0, y: -8, z: -4 });
    expectVector(falling.angularVelocity, { x: 1, y: 2, z: 3 });
  });
});

describe('live tuning', () => {
  it('defaults to the values the machine ships with', () => {
    expect(TUNING_DEFAULTS.mass).toBe(COIN_MASS);
    expect(TUNING_DEFAULTS.thickness).toBe(COIN_HEIGHT);
    expect(TUNING_DEFAULTS.groundFriction).toBe(COIN_GROUND_FRICTION);
    expect(TUNING_DEFAULTS.coinFriction).toBe(COIN_COIN_FRICTION);
    expect(TUNING_DEFAULTS.pusherFriction).toBe(COIN_PUSHER_FRICTION);
    expect(TUNING_DEFAULTS.tilt).toBe(GAME.payoutTilt);
  });

  it('updates thickness, mass and inertia without leaving a stale collision shape', () => {
    const world = testWorld({ tilt: 0 });
    addFloor(world);
    const body = spawnCoin(world, { x: 0, y: 1, z: 0 });
    world.stepOnce();
    const thinInertiaX = body.rb.principalInertia().x;
    applyCoinTuning(body, { ...TUNING_DEFAULTS, thickness: 0.3, mass: 0.2 }, true);
    advance(world, 4);
    expect(body.position.y).toBeCloseTo((0.3 + COIN_COLLIDER_PAD) / 2, 2);
    expect(body.collider.mass()).toBeCloseTo(0.2, 6);
    expect(body.rb.principalInertia().x).toBeGreaterThan(thinInertiaX);
  });

  it('leaves the shape alone when only feel knobs move', () => {
    const body = createCoinBody(testWorld());
    const shape = body.collider;
    applyCoinTuning(body, { ...TUNING_DEFAULTS, linearDamping: 0.4, angularDamping: 0.9 });
    expect(body.collider).toBe(shape);
    expect(body.rb.linearDamping()).toBeCloseTo(0.4, 6);
    expect(body.rb.angularDamping()).toBeCloseTo(0.9, 6);
  });
});

describe('seedPosition', () => {
  // One layer while the bed is long enough to hold the seed, whole layers stacked once it is not -
  // which the default bed now is: shortened to keep the tray back, it holds one row of 10, and the
  // stacked 14 measured better than seeding 10 or squeezing in a second row (that spilled at load).
  const seedLayers = () => Math.ceil(LOWER_SEED_COUNT / lowerSlotsPerLayer());

  it('lays out the lower bed in as few layers as its slots allow', () => {
    const pile = Array.from({ length: LOWER_SEED_COUNT }, (_, index) => seedPosition(index, 1234));
    const layers = [...new Set(pile.map((coin) => coin.y))].sort((a, b) => a - b);

    expect(layers).toHaveLength(seedLayers());
    expect(pile).toHaveLength(LOWER_SEED_COUNT);
    expect(Math.min(...pile.map((coin) => coin.z)) - COIN_RADIUS)
      .toBeGreaterThan(GAME.playfieldFrontZ);
  });

  // The gaps vary between resets instead of always leaving the same lanes open, but every
  // lower coin must remain in a unique slot, and only the layers the slot count forces exist.
  it('varies the gaps without stacking more than needed or duplicating a lower slot', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const pile = Array.from({ length: LOWER_SEED_COUNT }, (_, i) => seedPosition(i, seed * 7919));
      const layers = [...new Set(pile.map((coin) => coin.y))].sort((a, b) => a - b);
      const positions = new Set(pile.map((coin) => `${coin.x.toFixed(5)}:${coin.y.toFixed(5)}:${coin.z.toFixed(5)}`));

      expect(layers).toHaveLength(seedLayers());
      expect(positions.size).toBe(LOWER_SEED_COUNT);
    }
  });

  // A pile seeded with coins already interpenetrating never settles: cannon-es keeps
  // trading push-apart impulses against the damping instead of coming to rest, so the coins
  // stay above their sleep threshold and shimmer forever. Both pitches must beat the
  // diameter by more than the jitter can close, for every seed.
  it('never spawns two coins of the same layer overlapping', () => {
    const diameter = COIN_RADIUS * 2;
    let worstPenetration = 0;
    let overlappingPairs = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const pile = Array.from({ length: SEED_COUNT }, (_, index) => seedPosition(index, seed * 7919));
      for (let i = 0; i < pile.length; i += 1) {
        for (let j = i + 1; j < pile.length; j += 1) {
          if (pile[i].tier !== pile[j].tier) continue;
          if (Math.abs(pile[i].y - pile[j].y) > COIN_HEIGHT) continue;
          const gap = Math.hypot(pile[i].x - pile[j].x, pile[i].z - pile[j].z);
          if (gap < diameter) {
            overlappingPairs += 1;
            worstPenetration = Math.max(worstPenetration, diameter - gap);
          }
        }
      }
    }
    expect(overlappingPairs).toBe(0);
    expect(worstPenetration).toBe(0);
  });

  // The tuning panel can take thickness to 0.34, and layer spacing follows it. If the pitch
  // ever stopped tracking thickness the pile would seed interpenetrating, which cannon-es
  // cannot resolve - it trades push-apart impulses with the damping and shimmers forever.
  it('never overlaps layers at any thickness the panel allows', () => {
    const diameter = COIN_RADIUS * 2;
    let worstPenetration = 0;
    for (const thickness of [0.06, 0.1, 0.2, 0.34]) {
      for (let seed = 0; seed < 40; seed += 1) {
        const pile = Array.from({ length: SEED_COUNT }, (_, i) => seedPosition(i, seed * 7919, thickness));
        for (let i = 0; i < pile.length; i += 1) {
          for (let j = i + 1; j < pile.length; j += 1) {
            if (pile[i].tier !== pile[j].tier) continue;
            if (Math.abs(pile[i].y - pile[j].y) > thickness) continue;
            const gap = Math.hypot(pile[i].x - pile[j].x, pile[i].z - pile[j].z);
            worstPenetration = Math.max(worstPenetration, diameter - gap);
          }
        }
      }
    }
    expect(worstPenetration).toBe(0);
  });

  it('rests the bottom layer on the surface at any thickness', () => {
    for (const thickness of [0.06, 0.1, 0.34]) {
      const lower = seedPosition(0, 99, thickness);
      const upper = seedPosition(LOWER_SEED_COUNT, 99, thickness);
      expect(lower.y - thickness / 2).toBeGreaterThan(0);
      expect(upper.y - thickness / 2).toBeGreaterThan(GAME.upperTrayY + GAME.upperTrayHeight / 2);
    }
  });

  it('keeps every seeded coin clear of the side walls', () => {
    const innerWall = GAME.playfieldHalfWidth;
    for (let seed = 0; seed < 200; seed += 1) {
      for (let index = 0; index < SEED_COUNT; index += 1) {
        expect(Math.abs(seedPosition(index, seed * 7919).x) + COIN_RADIUS).toBeLessThan(innerWall);
      }
    }
  });

  // A coin on the tray rides with it, so its seed position matters in tray-local Z. Ahead of
  // the tray's front lip it overhangs; behind the point the scraper can reach at full retreat
  // it gets shoved forward once per stroke and the upper pile never comes to rest.
  it('seeds upper coins inside the band the tray carries undisturbed', () => {
    const trayFront = COIN_RADIUS - GAME.pusherDepth / 2;
    const scraperReach = GAME.scraperZ - 0.08 - COIN_RADIUS
      - (GAME.pusherOriginZ + GAME.pusherAmplitude);
    for (let seed = 0; seed < 200; seed += 1) {
      for (let index = LOWER_SEED_COUNT; index < SEED_COUNT; index += 1) {
        const trayLocalZ = seedPosition(index, seed * 7919).z - GAME.pusherOriginZ;
        expect(trayLocalZ).toBeGreaterThanOrEqual(trayFront);
        expect(trayLocalZ).toBeLessThanOrEqual(scraperReach);
      }
    }
  });

  it('varies the pile between resets while remaining deterministic for one seed', () => {
    expect(seedPosition(8, 1234)).toEqual(seedPosition(8, 1234));
    expect(seedPosition(8, 1234)).not.toEqual(seedPosition(8, 5678));
  });

  it('keeps lower coins in front and places upper coins on the moving tray', () => {
    const initialPusherFront = GAME.pusherOriginZ - GAME.pusherDepth / 2;
    const positions = Array.from({ length: SEED_COUNT }, (_, index) => seedPosition(index, 4321));
    const lower = positions.filter((position) => position.tier === 'lower');
    const upper = positions.filter((position) => position.tier === 'upper');
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;

    expect(lower).toHaveLength(LOWER_SEED_COUNT);
    expect(Math.min(...lower.map((position) => position.x - COIN_RADIUS))).toBeGreaterThan(-GAME.playfieldHalfWidth);
    expect(Math.max(...lower.map((position) => position.x + COIN_RADIUS))).toBeLessThan(GAME.playfieldHalfWidth);
    expect(Math.min(...lower.map((position) => position.z - COIN_RADIUS))).toBeGreaterThan(GAME.playfieldFrontZ);
    expect(Math.max(...lower.map((position) => position.z))).toBeLessThan(initialPusherFront);
    expect(upper.length).toBeGreaterThan(0);
    expect(Math.min(...upper.map((position) => position.y))).toBeGreaterThan(trayTop);
  });
});

describe('drop zone', () => {
  // Measured to the coin's edges, not its centre. A centre-only bound passes with the coin's front
  // half hanging over the tray lip at full retreat, and a coin in that state tips onto the lower bed
  // on arrival instead of being swept - which is exactly the failure dropZoneZ exists to avoid.
  it('lands a whole coin on the moving upper tray for its entire stroke', () => {
    const rearMostFrontEdge = GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
    const frontMostBackEdge = GAME.pusherOriginZ - GAME.pusherAmplitude
      + GAME.pusherDepth / 2 + GAME.pusherRearExtension;
    expect(GAME.dropZoneZ - COIN_RADIUS).toBeGreaterThan(rearMostFrontEdge);
    expect(GAME.dropZoneZ + COIN_RADIUS).toBeLessThan(frontMostBackEdge);
  });
});

// The launcher fires at dropZoneZ, so its depth is covered by "drop zone" above and by the
// scraper guard below - only the sideways travel needs a guard of its own.
describe('front launcher landing safety', () => {
  const trayHalfWidth = (BED_WIDTH - 0.3) / 2;

  it('keeps every horizontal aim fully inside the moving tray', () => {
    expect(GAME.launcherTravelHalfWidth + COIN_RADIUS).toBeLessThan(trayHalfWidth);
  });
});

// The arc is pure presentation - the coin's body is not in the world until the arc ends - so any
// gap between the arc's last point and the coin's resting height is a visible mid-air stop
// followed by a free fall, which reads as the coin bouncing off something that is not there.
describe('launcher handoff', () => {
  it('ends the flight at the coin resting height on the tray', () => {
    const restingY = GAME.upperTrayY + GAME.upperTrayHeight / 2 + COIN_HEIGHT / 2;
    expect(GAME.launcherLandingY).toBeCloseTo(restingY, 2);
  });
});

describe('machine proportions', () => {
  // Down from six diameters: the stroke was shortened on request because the tray reached too far
  // into the lower half. The real guard is "tray drainage" - this only stops a slip below what was
  // measured (0.9, with the dead span shortened to 2.0 to keep the force chain; 0.8 failed).
  it('moves the upper pusher at least two and a half coin diameters per cycle', () => {
    expect(GAME.pusherAmplitude * 2).toBeGreaterThanOrEqual(COIN_RADIUS * 5);
  });

  // At least two and a half coins: with the 0.27 coin the same 1.8 strip holds over three.
  it('fits at least a two-and-a-half-coin upper travel strip inside the cabinet', () => {
    const trayLipAtRetreat = GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
    const visibleStrip = GAME.scraperZ - 0.08 - trayLipAtRetreat;
    const scraperBackEdge = GAME.scraperZ + 0.08;
    const backWallFront = GAME.playfieldBackZ - 0.075;

    expect(visibleStrip).toBeGreaterThanOrEqual(COIN_RADIUS * 5);
    expect(scraperBackEdge).toBeLessThan(backWallFront);
  });

  it('keeps the moving tray under the scraper at full extension', () => {
    const frontMostBackEdge = GAME.pusherOriginZ - GAME.pusherAmplitude
      + GAME.pusherDepth / 2 + GAME.pusherRearExtension;
    const scraperBackEdge = GAME.scraperZ + 0.08;

    expect(frontMostBackEdge).toBeGreaterThanOrEqual(scraperBackEdge);
  });

  // Floors only. This used to cap the lower tier at 5 diameters as well, measured from the blade's
  // mid-stroke face - a measure that cannot see the stroke length at all, so every change to the
  // stroke made it fail for the wrong reason and got the ceiling hand-raised (5 -> 5.25 -> ...).
  // The thing that ceiling stood in for is the unswept dead span, and "sweep coverage" below
  // measures it properly, against the blade's actual forward extreme. One guard, not two.
  it('provides meaningful stacking distance on both tiers', () => {
    const coinDiameter = COIN_RADIUS * 2;
    const upperDepthInCoins = GAME.pusherDepth / coinDiameter;
    // What the player actually stacks on: the bed the tray has uncovered at full retreat.
    const trayLipAtRetreat = GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
    const lowerDepthInCoins = (trayLipAtRetreat - GAME.playfieldFrontZ) / coinDiameter;

    expect(upperDepthInCoins).toBeGreaterThan(3.5);
    expect(lowerDepthInCoins).toBeGreaterThan(5);
  });

  it('keeps the payout crossing aligned with the shortened front edge', () => {
    expect(GAME.edgeZ - GAME.playfieldFrontZ).toBeCloseTo(0.05, 8);
  });
});

// Each tier is swept by one surface, and whatever that surface cannot reach can only be
// cleared by coins shoving each other. A settled pile transmits a shove about one coin
// deep — beyond that the chain dies and the tier silently gridlocks. Both spans below were
// once several diameters long, which parked every coin where nothing could ever touch it.
describe('sweep coverage', () => {
  const coinDiameter = COIN_RADIUS * 2;
  // Furthest forward the fixed scraper can shove a coin, in tray-local Z. The scraper only
  // bites at full retreat, so this is a one-shot limit, not something repeated strokes improve.
  const scraperReach = GAME.scraperZ - 0.08 - COIN_RADIUS
    - (GAME.pusherOriginZ + GAME.pusherAmplitude);
  // Furthest forward the blade can leave a coin's centre on the lower bed.
  const bladeReach = lowerBladeReachZ() - 0.07 + COIN_RADIUS;

  // The old 1.5-diameter ceiling was measured with a stale test pusher that omitted the moving
  // rear extension. Once the fixture matched the real tray, the end-to-end payout guard cleared
  // a two-diameter span without gridlocking. Keep this ceiling tied to that behavioral check.
  // In world units now: two 0.36 coins, which is what the end-to-end payout guard cleared. The
  // 0.27 coin fits nearly three into the same span; the drainage run is what says the tray still
  // drains through it, so this only holds the span where that run measured it.
  it('leaves at most the calibrated span of tray the scraper cannot reach', () => {
    const trayFront = -GAME.pusherDepth / 2;
    expect(scraperReach - trayFront).toBeLessThanOrEqual(1.6);
  });

  // The bonus chest lands on that same tray and is swept by the same scraper, so it is bound by
  // the same span: a chest deeper than the unswept strip cannot be cleared and parks there for
  // good, blocking every later chest. The model is 0.74 deep for every 1 wide, so chestWidth is
  // the real knob.
  it('keeps the bonus chest shallow enough for the scraper to clear', () => {
    const chestDepth = GAME.chestWidth * 0.74;
    const trayFront = -GAME.pusherDepth / 2;
    expect(chestDepth).toBeLessThanOrEqual(scraperReach - trayFront);
  });

  // The chest starts at the back of the tray so it has the whole machine to travel. Two things
  // bound that: the scraper's own face, and how far back the moving deck reaches at its forward
  // extreme - past that the chest would drop into the gap behind the tray.
  it('drops the chest against the scraper with deck still under it', () => {
    const halfDepth = GAME.chestWidth * 0.74 / 2;
    const back = chestDropZ(halfDepth) + halfDepth;
    expect(back).toBeLessThan(GAME.scraperZ - 0.08);
    const deckDepth = GAME.pusherDepth + GAME.pusherRearExtension;
    const deckRear = GAME.pusherOriginZ - GAME.pusherAmplitude + GAME.pusherRearExtension / 2 + deckDepth / 2;
    expect(back).toBeLessThan(deckRear);
  });

  it('makes the bonus chest resist a shove at least eighteen times more than a coin', () => {
    const world = testWorld();
    const coin = spawnCoin(world, { x: 0, y: 1, z: 0 });
    const chest = spawnChest(world, { x: 2, y: 1, z: 0 });
    const shove = { x: 0, y: 0, z: -0.9 };
    coin.rb.applyImpulse(shove, true);
    chest.rb.applyImpulse(shove, true);
    expect(Math.abs(coin.velocity.z)).toBeGreaterThan(0);
    expect(Math.abs(chest.velocity.z)).toBeGreaterThan(0);
    expect(Math.abs(chest.velocity.z)).toBeLessThanOrEqual(Math.abs(coin.velocity.z) / 18);
  });

  it('stops the bonus chest within half a coin diameter after landing', () => {
    const world = testWorld();
    addFloor(world);
    const chest = spawnChest(world, { x: 0, y: GAME.chestWidth * 0.7 / 2 + 0.01, z: 1 });
    chest.setVelocity({ x: 0, y: 0, z: -2 });
    chest.setAngularVelocity({ x: 0, y: 1.8, z: 0 });
    const startZ = chest.position.z;
    advance(world, 2);
    expect(startZ - chest.position.z).toBeLessThan(COIN_RADIUS);
  });

  // The blade does not need to touch the lip, but the remaining span must fit a short connected
  // force chain. The earlier five-plus-diameter gap split the lower pile into islands: the blade
  // compressed the rear island while the front row never received a useful impulse.
  // In world units now, not diameters: the 0.27 coin and the three-layer seed fill this span with
  // a packed pile, so it is no longer a row of loose coins that can part into islands. 2.0 is the
  // span the drainage run (below) was calibrated at; widen it and that run has to be re-measured.
  // 2.0 -> 2.7 with the lower blade on its own 0.65 stroke (GAME.lowerBladeAmplitude): the longer
  // span is the point - the pile has to build into a clump before it reaches the lip - and the
  // drainage run was re-measured with it.
  it('keeps the lower dead span within a short force chain', () => {
    const frontRestingCentre = GAME.playfieldFrontZ + COIN_RADIUS;
    expect(bladeReach - frontRestingCentre).toBeLessThanOrEqual(2.7);
  });

  // A coin leaving the tray must land behind the blade, not in front of it where the moving
  // assembly cannot directly catch it on the following stroke.
  // A coin dropped behind the scraper is on the wrong side of it forever: the scraper only
  // pushes forward, so nothing there is ever advanced towards the lip.
  it('drops coins in front of the scraper', () => {
    expect(GAME.dropZoneZ + COIN_RADIUS).toBeLessThan(GAME.scraperZ - 0.08);
  });

  it('stops a rail coin bounced above the visible scraper from reaching the rear deck', () => {
    const { world } = testMachine();
    const coin = spawnCoin(world, { x: 0, y: 1.6, z: GAME.scraperZ - 0.6 });
    coin.setVelocity({ x: 0, y: 0, z: 6 });
    let furthestZ = coin.position.z;
    for (let step = 0; step < 60; step += 1) {
      world.stepOnce();
      furthestZ = Math.max(furthestZ, coin.position.z);
    }

    expect(furthestZ).toBeLessThan(GAME.scraperZ - 0.08);
    expect(coin.position.z).toBeLessThan(GAME.scraperZ - 0.08);
  });

  it('seals the scraper collision guard against both side walls', () => {
    const guardHalfWidth = BED_WIDTH / 2;
    const innerWallX = GLASS_X - 0.125;
    expect(guardHalfWidth).toBeGreaterThan(innerWallX);
  });

  // Coins cross the tray's lip while the scraper holds them, which only happens at full
  // retreat - so they always land at one predictable spot. That spot has to be behind the
  // blade face at that instant, or every arrival drops straight into the lower bed's unswept
  // span and joins a pile nothing can push. The margin here is only 0.07, so it is easy to
  // break by nudging the stroke or the tray depth.
  it('spills coins off the tray behind the blade, not into the unswept span', () => {
    const spillZ = GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
    const bladeFaceAtFullRetreat = spillZ - 0.07;
    expect(spillZ).toBeGreaterThan(bladeFaceAtFullRetreat);
    expect(spillZ).toBeGreaterThan(bladeReach + coinDiameter);
  });
});

describe('fixed rear deck', () => {
  // The deck and the moving tray used to share a Y, so a coin resting in the overlap
  // touched a static and a kinematic surface at once. The conflicting friction
  // constraints ratcheted the upper pile forward every stroke, draining it with zero
  // player input. Guard the clearance that separates them.
  it('sits below the tray top so coins never rest on both surfaces', () => {
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const deckTop = GAME.upperTrayY - GAME.deckClearance + GAME.upperTrayHeight / 2;
    expect(deckTop).toBeLessThan(trayTop);
  });

  it('leaves the upper pile in place when nobody drops a coin', () => {
    const { world, drivePusher } = testMachine();
    world.beforeStep.length = 0;
    const seeded = [];
    for (let index = LOWER_SEED_COUNT; index < SEED_COUNT; index += 1) {
      seeded.push(spawnCoin(world, seedPosition(index, 777)));
    }
    advance(world, 2);
    const motionStartStep = world.stepNumber;
    world.beforeStep.push((stepNumber) => drivePusher(stepNumber - motionStartStep));
    const cycle = Math.PI * 2 / GAME.pusherSpeed;
    // The first strokes are the seed settling: the two-layer seed finds its places on the tray and
    // a few of its top coins topple off the front, which the game does off-screen before frame one.
    // What must not happen is the pile then marching on, stroke after stroke.
    // 3 -> 12 strokes with the 0.05 coin: a thin seed takes longer to find its places (0.19 of
    // creep over the first 6 strokes, 0.04 over the next 18, then none).
    advance(world, 12 * cycle);
    const coins = seeded.filter((body) => body.position.y > 0.4);
    const meanZ = () => coins.reduce((sum, body) => sum + body.position.z, 0) / coins.length;
    const startZ = meanZ();
    advance(world, 12 * cycle);

    console.info('REAR_DECK', JSON.stringify({ onTray: coins.length, meanDisplacementZ: meanZ() - startZ,
      minY: Math.min(...coins.map((body) => body.position.y)) }));
    expect.soft(coins.length).toBeGreaterThan(seeded.length / 2);
    expect.soft(meanZ() - startZ).toBeGreaterThan(-0.1);
    expect.soft(coins.every((body) => body.position.y > 0.4)).toBe(true);
  }, 60_000);
});

// End-to-end pacing: the pusher is always moving, but the seeded clearances must prevent free
// payouts. A first player coin begins filling the receiving row; repeated drops eventually close
// the force chain and must still drain the tray and pay out normally.
describe('tray drainage', () => {
  it.each([777, 31, 4242, 99, 2024])('stays idle through the first drop, then pays out under sustained play (seed %i)', (pileSeed) => {
    const { world } = testMachine();
    const fixedStep = FIXED_STEP;
    const coins = [];
    const spawn = (x, y, z) => {
      const body = spawnCoin(world, { x, y, z });
      coins.push(body);
      return body;
    };
    for (let index = 0; index < SEED_COUNT; index += 1) {
      const seed = seedPosition(index, pileSeed);
      spawn(seed.x, seed.y, seed.z).seedIndex = index;
    }
    const markPaidOut = () => {
      for (const body of coins) {
        // The game's own rules: lower-bed grip (CoinPusher.gripOnLowerBed) and coinFallPhase - a
        // coin teetering on the lip is still in play.
        if (body.material === 'coin' && onLowerBed(body.position)) world.setMaterial(body, 'lowerCoin');
        // Same lifecycle as CoinPusher: latch the fall, pay only once it reaches the tray line.
        const phase = coinFallPhase(body, body.position);
        if (phase === 'fall') body.falling = true;
        if (phase === 'score') {
          body.counted = true;
          body.paidOut = true;
          body.setEnabled(false);
        }
        if (phase === 'lost') body.setEnabled(false);
      }
    };
    const advance = (seconds) => {
      for (let i = 0; i < Math.round(seconds / fixedStep); i += 1) {
        world.stepOnce();
        markPaidOut();
      }
    };

    // CoinPusher settles off-screen for PILE_SETTLE_SECONDS, then discards anything that crossed
    // during it - a deep seed sheds a coin or two there, unseen. Only crossings after that
    // boundary are player-visible payouts.
    advance(12);
    const discardedAtLoad = coins.filter((body) => body.paidOut).length;
    advance(10);
    const idlePaidOut = coins.filter((body) => body.paidOut).length - discardedAtLoad;

    // One paid player coin starts feeding the machine, but is not enough to complete the lower
    // force chain and cash out the stock that was already sitting at the front.
    spawn(0, 4, GAME.dropZoneZ).setVelocity({ x: 0, y: -1, z: 0 });
    let dropCount = 1;
    advance(8);
    const firstDropPaidOut = coins.filter((body) => body.paidOut).length - discardedAtLoad;

    // Deterministic stand-in for the player: one coin per autoInterval across the aim range.
    const aimAt = (i) => {
      const noise = Math.sin((i + 1) * 91.7 + 3.1) * 43758.5453;
      return ((noise - Math.floor(noise)) - 0.5) * GAME.playfieldHalfWidth * 1.6;
    };
    const dropEvery = Math.round(GAME.autoInterval / fixedStep);
    // 60 -> 180 s with the lower blade's shorter stroke: the bed stores 100-250 more coins before it
    // levels off, so the first minute is mostly the fill phase.
    for (let i = 0; i < Math.round(180 / fixedStep); i += 1) {
      if (i % dropEvery === 0 && coins.filter((body) => !body.paidOut).length < SEED_COUNT + 300) {
        spawn(aimAt(i), 4, GAME.dropZoneZ).setVelocity({ x: 0, y: -1, z: 0 });
        dropCount += 1;
      }
      world.stepOnce();
      markPaidOut();
    }

    // The tray top is at 0.71 and the lower pile never reaches 0.5, so height alone separates
    // coins riding the tray from coins resting on the bed.
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const stranded = coins.filter((body) => !body.paidOut && body.position.y > trayTop - 0.15);
    const paidOut = coins.filter((body) => body.paidOut).length - discardedAtLoad;

    console.info('PAYOUT', JSON.stringify({ seed: pileSeed, discardedAtLoad, idlePaidOut,
      firstDropPaidOut, dropCount, paidOut, stranded: stranded.length }));
    // Keep every calibration bound visible even when an earlier stage fails.
    expect.soft(discardedAtLoad).toBeLessThanOrEqual(3);
    expect.soft(idlePaidOut).toBe(0);
    // The seed is three layers deep with its front row hanging at the lip on purpose, so the first
    // coin may tip a couple of those off. What must not happen is it cashing out the pile.
    expect.soft(firstDropPaidOut).toBeLessThanOrEqual(3);
    expect.soft(dropCount).toBeGreaterThan(25);
    // Measured over these five seeds with Rapier, the 0.27 coin and the deep pile: 22-38 paid from
    // 68 drops, a fill phase included, while the lip still threw coins off; 17-31 now that a
    // coin is only paid once it really falls and may teeter at the lip; 12-20 with payoutTilt
    // 1.9 -> 0.9; 19-29 with the 0.05 coin, the 110-coin seed and the lower bed's own grip, the
    // pile now hanging in a clump at the lip and coming down in falls. 83-108 paid from 201 drops
    // over 180 s with the lower blade on its own 0.65 stroke; 171-186 at 0.9. The floor is half the
    // worst of the 0.65 runs -
    // a machine that cannot complete the force chain pays one or two at most.
    expect.soft(paidOut).toBeGreaterThan(41);
    // The tray strip in front of the scraper holds about one layer of coins; a working tray carries
    // a layer and a bit (53-59 measured; 64-69 with the 0.05 coin, which packs thinner layers), a
    // jammed one keeps stacking. Jammed was past 1.75 layers; 2 with the 0.05 coin, whose working
    // tray settles at 67-79 over 180 s and never climbs past 83 in six-minute runs, while a jam
    // (a shared 0.6 stroke) runs past 150. With the lower blade at 0.9: 67-84 over 180 s.
    const strip = GAME.scraperZ - 0.08 - (GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2);
    const stripLayer = Math.floor((BED_WIDTH - 0.3) / (2 * COIN_RADIUS)) * Math.floor(strip / (2 * COIN_RADIUS));
    expect.soft(stranded.length).toBeLessThanOrEqual(stripLayer * 2);
  }, 420_000);
});

describe('pusher stroke smoothness', () => {
  const createDrivenPusher = () => ({ ...testMachine(), fixedStep: FIXED_STEP });

  const measure = (hz, seconds = 8) => {
    const { pusher, world } = createDrivenPusher();

    const frameDt = 1 / hz;
    const renderedPosition = new Vector3();
    let previous = pusher.position.z;
    const travel = [];
    const positions = [];
    for (let frame = 0; frame < seconds * hz; frame += 1) {
      const alpha = world.step(frameDt);
      pusher.lerpPose(alpha, renderedPosition);
      const rendered = renderedPosition.z;
      if (frame > hz) travel.push(Math.abs(rendered - previous));
      positions.push(rendered);
      previous = rendered;
    }
    return {
      max: Math.max(...positions),
      maxTravel: Math.max(...travel),
      min: Math.min(...positions),
    };
  };

  // Peak travel of a perfect sine per frame is amplitude * angularSpeed / hz.
  const idealTravel = (hz) => (GAME.pusherAmplitude * GAME.pusherSpeed) / hz;

  it.each([60, 120, 144])('never jumps further than the ideal sine at %iHz', (hz) => {
    const result = measure(hz);
    expect(result.maxTravel).toBeLessThan(idealTravel(hz) * 1.2);
    expect(result.min).toBeGreaterThanOrEqual(GAME.pusherOriginZ - GAME.pusherAmplitude - 1e-9);
    expect(result.max).toBeLessThanOrEqual(GAME.pusherOriginZ + GAME.pusherAmplitude + 1e-9);
  });

  it('remains centred after ten minutes of physics steps', () => {
    const { fixedStep, pusher, world } = createDrivenPusher();
    for (let frame = 0; frame < 10 * 60 / fixedStep; frame += 1) world.stepOnce();

    const expected = pusherMotionAt(world.stepNumber, fixedStep);
    expect(pusher.position.z).toBeCloseTo(expected.positionZ, 6);
    expect(Math.abs(pusher.position.z - GAME.pusherOriginZ)).toBeLessThanOrEqual(GAME.pusherAmplitude);
  });
});

// The rail hands physics one pose and one velocity, and everything the player sees after that
// follows from them. What has to hold is that the spread straddles the centre: push railExitX out
// far enough and every landing lands on the launch side, which is the bug that makes the two
// rails feel like two different games.
describe('launch rails', () => {
  const DROP_HEIGHT = GAME.railY - (GAME.upperTrayY + GAME.upperTrayHeight / 2);

  // railExitX is derived from railSpeedMin and the fall time, and nothing enforces that at
  // runtime. If the three drift apart the weakest launch stops dropping on the centre line, and
  // the mechanic's whole resting state moves with it.
  it('drops the weakest launch on the centre line, and carries a hard one past it', () => {
    expect(Math.abs(landingXFor(1, 0, DROP_HEIGHT))).toBeLessThan(COIN_RADIUS / 2);
    expect(landingXFor(1, 1, DROP_HEIGHT)).toBeLessThan(-COIN_RADIUS);
  });

  it('mirrors the two rails exactly', () => {
    for (const power of [0, 0.5, 1]) {
      expect(landingXFor(-1, power, DROP_HEIGHT)).toBeCloseTo(-landingXFor(1, power, DROP_HEIGHT), 8);
    }
  });

  it('keeps every landing inside the glass', () => {
    for (let step = 0; step <= 40; step += 1) {
      for (const side of [-1, 1]) {
        expect(Math.abs(landingXFor(side, step / 40, DROP_HEIGHT)) + COIN_RADIUS)
          .toBeLessThan(GAME.playfieldHalfWidth);
      }
    }
  });

  it('spans exactly the configured speed range', () => {
    expect(launchSpeedFor(0)).toBeCloseTo(GAME.railSpeedMin, 8);
    expect(launchSpeedFor(1)).toBeCloseTo(GAME.railSpeedMax, 8);
  });

});

describe('machineFullFor', () => {
  // The request this guards: coins vanished from the pile to keep it under a ceiling, and the
  // bed lost the force to push anything off. A full machine now holds the slot instead.
  it('holds at the full mark and opens again only once drained to the resume mark', () => {
    expect(machineFullFor(false, MACHINE_FULL_AT - 1)).toBe(false);
    expect(machineFullFor(false, MACHINE_FULL_AT)).toBe(true);
    expect(machineFullFor(true, MACHINE_RESUME_AT + 1)).toBe(true);
    expect(machineFullFor(true, MACHINE_RESUME_AT)).toBe(false);
    expect(MACHINE_RESUME_AT).toBeLessThan(MACHINE_FULL_AT);
  });
});
