import { beforeAll, describe, expect, it } from 'vitest';
import { CoinPusher } from '../src/game/CoinPusher.js';
import { missionText, rewardText, useStarWords } from '../src/game/missions.js';
import { GAME } from '../src/game/config.js';
import { lowerBladeReachZ } from '../src/game/physics.js';
import {
  burstDelay, CHEST_NUDGE_SPEED, chestNudge, dropStats, FUSION_RANGE, fusionPairs, fusionPull,
  gateClosesNow, GATE_MAX_OPEN_SECONDS, GATE_SPEED, gateHeightFor, gateLiftStep, PEARL_LEVELS, pearlOnTray, STORE_CAPACITY, TOP_LEVEL, MAX_PEARLS, PEARL_ANGULAR_DAMPING, PEARL_LINEAR_DAMPING, PEARL_MASS,
  PEARL_MODES, PEARL_RADIUS, PEARL_SEED_COUNT, pearlDropZ, pearlPhase, pearlSchedule,
  PEARL_RETREAT_PAST_BOARD, pearlBladeReachZ, crossSteer, straightRun, pearlSeedPosition, pearlSidePosition, pearlSideVelocity, pearlStrokeZ, pourSide, pourX, seededRandom, SILL_HALF_DEPTH, SILL_HEIGHT, sillZ, stepTowards, trayTargetZ,
} from '../src/game/pearls.js';
import { CHEST_GROUPS, frictionFor, initPhysics, SILL_GROUPS } from '../src/game/world.js';
import { createMachine } from './machine.js';
import { labReadout } from '../src/pearlLab.js';

const total = (mode) => mode.waves.reduce((sum, { count }) => sum + count, 0);

describe('pearl modes', () => {
  it('holds the planned counts, E matching D, and fits the pool', () => {
    expect(['A', 'B', 'C'].map((key) => total(PEARL_MODES[key]))).toEqual([30, 30, 30]);
    expect(total(PEARL_MODES.E)).toBe(total(PEARL_MODES.D));
    for (const mode of Object.values(PEARL_MODES)) expect(total(mode)).toBeLessThanOrEqual(MAX_PEARLS);
  });

  it('schedules every pearl in time order from the start time', () => {
    const schedule = pearlSchedule(PEARL_MODES.C, 100);
    expect(schedule).toHaveLength(30);
    expect(schedule.filter(({ zone }) => zone === 'front')).toHaveLength(10);
    expect(schedule.map(({ at }) => at)).toEqual([...schedule.map(({ at }) => at)].sort((a, b) => a - b));
    expect(schedule[0].at).toBe(100);
    expect(schedule.at(-1).at).toBeLessThan(103);
  });

  it('keeps D\'s front rain back until the build-up is done', () => {
    const front = pearlSchedule(PEARL_MODES.D).filter(({ zone }) => zone === 'front');
    expect(burstDelay(PEARL_MODES.D)).toBe(20);
    expect(Math.min(...front.map(({ at }) => at))).toBe(20);
  });
});

describe('pearl drop zones', () => {
  it('lands front pearls past the blade\'s reach, on the bed', () => {
    for (const roll of [0, 0.5, 0.999]) {
      const z = pearlDropZ('front', 99, () => roll);
      expect(z).toBeLessThan(lowerBladeReachZ());
      expect(z).toBeGreaterThan(GAME.playfieldFrontZ);
    }
  });

  it('lands rear pearls just ahead of the blade, wherever it is', () => {
    for (const bladeZ of [lowerBladeReachZ(), 2]) {
      const z = pearlDropZ('rear', bladeZ, () => 0.5);
      expect(z).toBeLessThan(bladeZ);
      expect(z).toBeGreaterThan(bladeZ - 1.1);
    }
  });
});

describe('pearlPhase', () => {
  it('needs both past the lip and below the deck to count as out', () => {
    const past = GAME.playfieldFrontZ - 0.1;
    expect(pearlPhase({ y: 0.2, z: past })).toBeNull();
    expect(pearlPhase({ y: -1, z: 1 })).toBeNull();
    expect(pearlPhase({ y: -1, z: past })).toBe('fall');
    expect(pearlPhase({ y: GAME.lostY - 1, z: 1 })).toBe('lost');
  });
});

describe('dropStats', () => {
  it('counts from the burst, ignoring pearls out before it', () => {
    expect(dropStats([5, 10.5, 12, 19, 31, 45], 10)).toEqual({ s3: 2, s10: 3, s30: 4 });
  });

  it('reads zero with no rain started', () => {
    expect(dropStats([1, 2], Infinity)).toEqual({ s3: 0, s10: 0, s30: 0 });
  });
});

describe('seededRandom', () => {
  it('repeats for a seed, differs across seeds and stays in [0, 1)', () => {
    const draw = (seed) => { const next = seededRandom(seed); return [next(), next(), next()]; };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    expect(draw(7).every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('labReadout', () => {
  it('shows the state, and no invented numbers before the first sample', () => {
    const round = { meter: 3 };
    expect(labReadout({ onBed: 20, pouring: false, latency: 4.2 }, round, 59.6)).toBe('場上 20 · 星雨 3 · 命中到掉出 4.2s · 60 fps');
    expect(labReadout({ onBed: 20, pouring: true, latency: null }, round)).toBe('落珠中 · 場上 20 · 星雨 3 · 命中到掉出 - · - fps');
  });
});

describe('tray gate', () => {
  it('moves at its own speed and stops on the target, either way', () => {
    expect(gateLiftStep(0.13, 0, 0.05)).toBeCloseTo(0.13 - GATE_SPEED * 0.05, 9);
    expect(gateLiftStep(0, 0.13, 0.05)).toBeCloseTo(GATE_SPEED * 0.05, 9);
    expect(gateLiftStep(0.01, 0, 1)).toBe(0);
    expect(gateLiftStep(0.13, 0.13, 0.05)).toBe(0.13);
  });

  it('counts a pearl on the tray, not one on the bed below it', () => {
    expect(pearlOnTray({ y: GAME.upperTrayY + 0.3 })).toBe(true);
    expect(pearlOnTray({ y: 0.2 })).toBe(false);
  });
});

describe('tray modes', () => {
  const stroke = GAME.pusherOriginZ + 0.4;

  it('strokes all the time in A, and rests at the midpoint in C', () => {
    expect(trayTargetZ('A', false, stroke)).toBe(stroke);
    expect(trayTargetZ('C', true, stroke)).toBe(GAME.pusherOriginZ);
  });

  it('strokes in B only while the gate is open', () => {
    expect(trayTargetZ('B', true, stroke)).toBe(stroke);
    expect(trayTargetZ('B', false, stroke)).toBe(GAME.pusherOriginZ);
  });

  it('eases towards its target without overshooting', () => {
    expect(stepTowards(1, 2, 0.25)).toBe(1.25);
    expect(stepTowards(1, 0, 0.25)).toBe(0.75);
    expect(stepTowards(1, 1.1, 0.25)).toBe(1.1);
  });
});

describe('chestNudge', () => {
  const near = { x: 0, y: 0.4, z: sillZ() + 0.2 };

  it('pushes a stalled chest at the lip and keeps its other motion', () => {
    expect(chestNudge(near, { x: 0.3, y: -1, z: 0 })).toEqual({ x: 0.3, y: -1, z: -CHEST_NUDGE_SPEED });
  });

  it('leaves a chest alone further back, or already moving faster', () => {
    expect(chestNudge({ ...near, z: 1 }, { x: 0, y: 0, z: 0 })).toBeNull();
    expect(chestNudge(near, { x: 0, y: 0, z: -2 })).toBeNull();
  });
});

describe('pearl seed', () => {
  it('keeps the pile out from under a resting tray', () => {
    const random = seededRandom(5);
    for (let index = 0; index < PEARL_SEED_COUNT; index += 1) {
      expect(pearlSeedPosition(index, random, 1.26).z).toBeLessThan(1.26);
    }
  });

  it('lays every pearl on the bed, behind the sill, and fits a rain in the pool', () => {
    const random = seededRandom(3);
    for (let index = 0; index < PEARL_SEED_COUNT; index += 1) {
      const { x, y, z } = pearlSeedPosition(index, random);
      expect(Math.abs(x)).toBeLessThan(GAME.playfieldHalfWidth);
      expect(y).toBeGreaterThan(PEARL_RADIUS);
      expect(z).toBeGreaterThan(sillZ());
    }
    expect(PEARL_SEED_COUNT + Math.max(...Object.values(PEARL_MODES).map(total))).toBeLessThanOrEqual(MAX_PEARLS);
  });
});

describe('pours', () => {
  it('lands on the side asked for, or anywhere for the centre', () => {
    for (const roll of [0, 0.5, 0.999]) {
      expect(pourX(-1, () => roll)).toBeLessThan(0);
      expect(pourX(1, () => roll)).toBeGreaterThan(0);
    }
    expect(pourX(0, () => 0)).toBeLessThan(0);
    expect(pourX(0, () => 0.999)).toBeGreaterThan(0);
  });

  it('enters at an end of the tray under the pin board and crosses it sideways', () => {
    const { x, y, z } = pearlSidePosition(-1);
    expect(x).toBeLessThan(-3);
    expect(y).toBeGreaterThan(GAME.upperTrayY + GAME.upperTrayHeight / 2);
    expect(z).toBeLessThan(GAME.dropZoneZ);
    expect(z).toBeGreaterThan(GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2);
    expect(pearlSideVelocity(-1, () => 0.5).x).toBeGreaterThan(0);
    expect(pearlSideVelocity(-1, () => 0.5).z).toBe(0);
  });

  it('turns a crossing pearl forward at its mark and restarts one that stalled', () => {
    const lipZ = 1.5;
    const cross = { side: -1, turnAt: 0 };
    const onTray = { x: -2, y: 1, z: 2.6 };
    expect(crossSteer(onTray, { x: 2.5, y: 0, z: 0 }, cross, lipZ)).toBeNull();
    expect(crossSteer(onTray, { x: 0, y: 0, z: 0 }, cross, lipZ).x).toBeGreaterThan(0);
    expect(crossSteer({ ...onTray, x: 0.5 }, { x: 2.5, y: 0, z: 0 }, cross, lipZ).z).toBeLessThan(0);
    expect(crossSteer({ ...onTray, x: 0.5 }, { x: 1, y: 0, z: -2.5 }, cross, lipZ)).toBeNull();
    expect(crossSteer({ ...onTray, z: 1 }, { x: 0, y: 0, z: 0 }, cross, lipZ)).toBeNull();
    expect(crossSteer({ ...onTray, y: 0.3 }, { x: 0, y: 0, z: 0 }, cross, lipZ)).toBeNull();
    expect(crossSteer(onTray, { x: 0, y: 0, z: 0 }, {}, lipZ)).toBeNull();
  });

  it('takes turns from both sides', () => {
    expect(pourSide(-1, 3)).toBe(-1);
    expect(new Set([0, 1].map((index) => pourSide(0, index)))).toEqual(new Set([-1, 1]));
  });
});

describe('pearl stroke', () => {
  it('keeps the tray front on the blade, and runs from the pin board to the coins\' retreat', () => {
    for (let step = 0; step < 200; step += 13) {
      const { trayZ, bladeZ } = pearlStrokeZ(step, 1 / 60);
      expect(trayZ - GAME.pusherDepth / 2).toBeCloseTo(bladeZ, 9);
      expect(bladeZ).toBeGreaterThanOrEqual(pearlBladeReachZ() - 1e-9);
    }
    expect(pearlBladeReachZ()).toBeGreaterThan(lowerBladeReachZ() + 0.5);
    expect(pearlStrokeZ(Math.round((Math.PI / 2 / GAME.pusherSpeed) * 60), 1 / 60).bladeZ).toBeCloseTo(GAME.dropZoneZ + PEARL_RETREAT_PAST_BOARD, 2);
  });
});

describe('winter skin', () => {
  // The skin hides whatever skinKeepRoots does not name: pearls left out of it were simulated,
  // counted and invisible.
  it('keeps everything the pearls draw on screen', () => {
    const drawn = [{}, {}, {}];
    expect(CoinPusher.prototype.skinKeepRoots.call({ pearls: { drawn } })).toEqual(expect.arrayContaining(drawn));
  });
});

describe('pearl physics', () => {
  beforeAll(() => initPhysics());

  it('gives a pearl its own friction, whatever the coin tuning', () => {
    const f = (tuning) => frictionFor('pearl', tuning, 8);
    expect(f({ coinFriction: 0.3 })).toBe(f({ coinFriction: 0.9 }));
  });

  it('comes to rest on the bed instead of through it, then leaves over the lip', () => {
    const { world } = createMachine();
    const pearl = world.addPearl({
      radius: PEARL_RADIUS, mass: PEARL_MASS,
      linearDamping: PEARL_LINEAR_DAMPING, angularDamping: PEARL_ANGULAR_DAMPING,
    });
    pearl.setEnabled(true);
    pearl.setPose({ x: 0, y: 1, z: 0 });
    for (let step = 0; step < 30; step += 1) world.stepOnce();
    expect(pearl.position.y).toBeGreaterThan(0);
    let phase = null;
    for (let step = 0; step < 60 * 20 && !phase; step += 1) {
      world.stepOnce();
      phase = pearlPhase(pearl.position);
    }
    expect(phase).toBe('fall');
    world.free();
  });

  const machineWithSill = () => {
    const { world } = createMachine();
    world.addStaticBox({ x: 4.2, y: SILL_HEIGHT / 2, z: SILL_HALF_DEPTH }, { x: 0, y: SILL_HEIGHT / 2, z: sillZ() }, { groups: SILL_GROUPS });
    return world;
  };

  it('keeps a lone pearl behind the sill, where nothing is pushing it', () => {
    const world = machineWithSill();
    const pearl = world.addPearl({
      radius: PEARL_RADIUS, mass: PEARL_MASS,
      linearDamping: PEARL_LINEAR_DAMPING, angularDamping: PEARL_ANGULAR_DAMPING,
    });
    pearl.setEnabled(true);
    pearl.setPose({ x: 0, y: 0.5, z: sillZ() + 0.6 });
    for (let step = 0; step < 60 * 8; step += 1) world.stepOnce();
    expect(pearl.position.z).toBeGreaterThan(sillZ());
    expect(pearlPhase(pearl.position)).toBeNull();
    world.free();
  });

  it('lets a chest through the sill: a box cannot climb it and would never pay', () => {
    const world = machineWithSill();
    const chest = world.addDynamicBox({ x: 0.4, y: 0.25, z: 0.3 }, {
      mass: GAME.chestMass, linearDamping: 0.1, angularDamping: 0.1, groups: CHEST_GROUPS,
    });
    chest.setEnabled(true);
    chest.setPose({ x: 0, y: 0.3, z: sillZ() + 0.1 });
    chest.setVelocity({ x: 0, y: 0, z: -6 });
    for (let step = 0; step < 60; step += 1) world.stepOnce();
    expect(chest.position.z).toBeLessThan(sillZ() - 0.4);
    world.free();
  });
});

describe('alchemy', () => {
  const pearl = (level, x, z = 0) => ({ level, body: { position: { x, y: 0.3, z } } });

  it('pairs like levels that touch, and leaves the rest', () => {
    const near = [pearl(1, 0), pearl(1, 0.3), pearl(2, 0.4)];
    expect(fusionPairs(near)).toEqual([[near[0], near[1]]]);
    expect(fusionPairs([pearl(1, 0), pearl(1, 2)])).toEqual([]);
  });

  it('never fuses plain pearls or the top level', () => {
    expect(fusionPairs([pearl(0, 0), pearl(0, 0.1)])).toEqual([]);
    expect(fusionPairs([pearl(TOP_LEVEL, 0), pearl(TOP_LEVEL, 0.1)])).toEqual([]);
  });

  it('uses each pearl once, three in a heap making one pair', () => {
    expect(fusionPairs([pearl(1, 0), pearl(1, 0.1), pearl(1, 0.2)])).toHaveLength(1);
  });

  it('pulls towards the nearest like pearl, only inside its range', () => {
    const one = pearl(1, 0);
    const pull = fusionPull(one, [one, pearl(1, 1), pearl(1, -2)]);
    expect(pull.x).toBeGreaterThan(0);
    expect(fusionPull(one, [one, pearl(1, FUSION_RANGE + 1)])).toBeNull();
    expect(fusionPull(one, [one, pearl(2, 0.5)])).toBeNull();
  });

  it('grows and pays more at every level', () => {
    for (let level = 2; level <= TOP_LEVEL; level += 1) {
      expect(PEARL_LEVELS[level].radius).toBeGreaterThan(PEARL_LEVELS[level - 1].radius);
      expect(PEARL_LEVELS[level].value).toBeGreaterThan(PEARL_LEVELS[level - 1].value);
    }
  });
});

describe('gate timing', () => {
  it('stays open until the store is empty, past its minimum', () => {
    expect(gateClosesNow(1, 2, 0)).toBe(false);
    expect(gateClosesNow(3, 2, 20)).toBe(false);
    expect(gateClosesNow(3, 2, 1)).toBe(true);
    expect(gateClosesNow(GATE_MAX_OPEN_SECONDS, 2, 20)).toBe(true);
  });
});

describe('store ceiling', () => {
  it('lowers the closed gate once full, so new pearls spill', () => {
    expect(gateHeightFor(0.13, STORE_CAPACITY - 1)).toBe(0.13);
    expect(gateHeightFor(0.13, STORE_CAPACITY)).toBeLessThan(0.13);
    expect(gateHeightFor(0.05, STORE_CAPACITY)).toBe(0.05);
  });
});

describe('star machine words', () => {
  it('names mission text and rewards for the machine in play', () => {
    useStarWords(true);
    expect(missionText({ kind: 'open', target: 2 }, 1)).toBe('推落星核 1 / 2');
    expect(rewardText({ type: 'rain', amount: 8 })).toBe('星珠補給 ×8');
    useStarWords(false);
    expect(missionText({ kind: 'open', target: 2 }, 1)).toBe('開寶箱 1 / 2');
    expect(rewardText({ type: 'rain', amount: 8 })).toBe('硬幣雨 ×8');
  });
});

describe('straightRun', () => {
  it('sends a board ball straight at the lip from wherever it fell', () => {
    const lipZ = 0;
    const y = GAME.upperTrayY + GAME.upperTrayHeight;
    for (const x of [-3, 0, 3]) {
      const steered = crossSteer({ x, y, z: 2 }, { x: 0, y: 0, z: 0 }, straightRun(x), lipZ);
      expect(steered.z).toBeLessThan(0);
      expect(steered.x).toBe(0);
    }
  });
});
