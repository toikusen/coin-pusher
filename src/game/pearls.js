// Pearl rain prototype: the rules, free of the renderer and the physics engine. Drop zones and the
// A-E modes come from headless runs (2026-10-31, 6 seeds, 30 pearls unless stated, median pearls
// out in 3 / 10 s): all front 4 / 9, all rear 0 / 1, 10 front + 20 rear 1 / 3. A front rain did
// not free pearls already queued at the rear (10 out with no rain, 8 with one), so D's build-up
// is pacing to judge by hand, not a physical chain.
import { GAME } from './config.js';
import { lowerBladeReachZ } from './physics.js';
import { NATURAL_FALL_Y } from './rules.js';

export const PEARL_RADIUS = 0.25;
export const PEARL_MASS = 0.1;
export const PEARL_LINEAR_DAMPING = 0.12;
export const PEARL_ANGULAR_DAMPING = 0.58;
// Pool size: the seeded pile, a full rain and what is riding the tray. Bodies are all made at load,
// so this costs memory, not frame time; a drop past it is refused like a jammed coin slot.
export const MAX_PEARLS = 260;
// This branch's machine: pearls replace coins, and the lever back is in the test panel.
export const PURE_PEARLS_DEFAULT = true;
// Headless, 4 seeds, pearls only: with no sill 82 of 96 pearls ran off idle in 20 s and the bed
// ended empty. A sill this low left 9 running off, about 90 held, and paid 89 in 90 s of feeding.
// Lower than a pearl's radius, so a pearl rests on it until the pile behind shoves it over.
export const SILL_HEIGHT = 0.1;
export const SILL_HALF_DEPTH = 0.04;
export const PEARL_SEED_COUNT = 130;
// Slot pearls come in at the ends of the upper tray, right under the pin board, roll across it and
// turn off towards the player somewhere along the way, dropping off the tray's lip onto the bed.
const CROSS_Z = GAME.dropZoneZ - 0.2;
const CROSS_SPEED = 2.5;
const TURN_FORWARD_SPEED = 2.5;
const ENTRY_X = 3.72;
const TURN_FROM = -3.2;
const TURN_TO = 1.5;
// A pearl is half a pearl from its neighbour at CROSS_SPEED, so a stream never stacks up at the end.
export const POUR_SPACING = 0.2;
// The tray's gate. Headless (3 seeds), at this height nothing leaked while 90 pearls were stored,
// and open until empty it released 20-90 in under 4 s and paid them plus about 12 inside 10 s. At
// lower heights pearls spill during play, and a pearl falling then blurs what the gate does.
export const GATE_HEIGHT = GAME.upperTrayHeight;
export const GATE_MAX_HEIGHT = GAME.upperTrayHeight;
export const GATE_OPEN_SECONDS = 2;
export const GATE_MAX_OPEN_SECONDS = 10;
const GATE_EMPTY_PEARLS = 2;
export const GATE_SPEED = 0.8;
export const GATE_HALF_DEPTH = 0.04;
// What the tray does with the gate. Headless, feeding one pearl per 0.6 s, a 3 s release every 20 s
// (3 seeds), resting at the stroke's midpoint: B stored 32, released 25 and paid 29 in 5 s, level
// with a tray that never stops (35, 26, 26), with 2 pearls lost under the tray against 22 for C.
// Resting further back lost more; resting at full reach released only 9. A chest rides down with
// B's strokes (71-114 s), so a machine whose gate never opens keeps its chest on the tray.
export const TRAY_MODES = Object.freeze({
  A: '持續動',
  B: '開閘才動',
  C: '不動',
});
export const TRAY_MAX_SPEED = GAME.pusherAmplitude * GAME.pusherSpeed * 1.5;
export const CHEST_NUDGE_ZONE = 0.75;
export const CHEST_NUDGE_SPEED = 1.2;
export const PEARL_SPAWN_Y = 1;
export const PEARL_SPAWN_HALF_WIDTH = 3.2;
export const BUMPER_PEARLS = 3;
export const BUMPER_COOLDOWN = 1.5;
// Which bumper runs the selected mode; the others drip pearls in at the rear.
export const RAIN_BUMPER = 2;

export const PEARL_MODES = Object.freeze({
  A: { label: '全前段', waves: [{ zone: 'front', count: 30, at: 0, over: 3 }] },
  B: { label: '全後段', waves: [{ zone: 'rear', count: 30, at: 0, over: 3 }] },
  C: {
    label: '混合',
    waves: [{ zone: 'front', count: 10, at: 0, over: 3 }, { zone: 'rear', count: 20, at: 0, over: 3 }],
  },
  D: {
    label: '累積爆發',
    waves: [{ zone: 'rear', count: 20, at: 0, over: 20 }, { zone: 'front', count: 30, at: 20, over: 3 }],
  },
  // D's total in one rain, so D's build-up can be judged against the same number of pearls.
  E: { label: 'D 對照', waves: [{ zone: 'front', count: 50, at: 0, over: 5 }] },
});

/** When the mode's last wave starts, in seconds: the moment its results are measured from. */
export function burstDelay(mode) {
  return Math.max(...mode.waves.map(({ at }) => at));
}

/** Every pearl of a mode as { at, zone }, earliest first, `start` being the rain's game time. */
export function pearlSchedule(mode, start = 0) {
  return mode.waves
    .flatMap(({ zone, count, at, over }) => Array.from({ length: count }, (_, index) => ({
      at: start + at + (index * over) / count,
      zone,
    })))
    .sort((first, second) => first.at - second.at);
}

/**
 * Where a pearl enters over the bed. Rear lands just ahead of the moving blade, wherever it is
 * this frame, so it is pushed for the whole bed. Front lands clear of the blade's furthest reach.
 */
export function pearlDropZ(zone, bladeZ, random = Math.random) {
  return zone === 'front'
    ? lowerBladeReachZ() - 0.2 - random() * 1.3
    : bladeZ - 0.25 - random() * 0.8;
}

/** Where the sill stands: on the bed, just behind the lip. */
export function sillZ() {
  return GAME.playfieldFrontZ + 0.05;
}

/**
 * What a star pearl can become. Level 0 is the plain pile; the others are the alchemy: two of a
 * level meet on the bed and fuse into the next. Radius is capped by the sill: see LEVEL_NUDGE.
 */
export const PEARL_LEVELS = Object.freeze([
  { radius: PEARL_RADIUS, value: null, color: 0xf2f4ff },
  { radius: 0.29, value: 10, color: 0x4fa8ff },
  { radius: 0.35, value: 30, color: 0xb06bff },
  { radius: 0.42, value: 100, color: 0xffc23c },
]);
export const TOP_LEVEL = PEARL_LEVELS.length - 1;
// Fusion is left to the pile alone and two of a few dozen specials rarely touch, so like levels on
// the bed drift together inside this range. Weak enough that the pile still decides where they go.
export const FUSION_RANGE = 2.2;
export const FUSION_PULL = 2.5;
export const FUSION_GAP = 0.06;
// The store's ceiling: past it the gate sits this low and new pearls spill over it, so saving up
// for ever stops paying and the physics never has an unbounded heap on the tray.
export const STORE_CAPACITY = 60;
export const GATE_OVERFLOW_HEIGHT = 0.08;

/** Where along the tray a stored pearl lands: one side of it, or anywhere for `side` 0. */
export function pourX(side, random = Math.random) {
  return side === 0 ? (random() * 2 - 1) * PEARL_SPAWN_HALF_WIDTH : side * (0.6 + random() * (PEARL_SPAWN_HALF_WIDTH - 0.6));
}

/** Pairs of like special pearls close enough to fuse, each pearl in one pair at most. */
export function fusionPairs(pearls) {
  const used = new Set();
  const pairs = [];
  pearls.forEach((first, index) => {
    if (used.has(first) || !first.level || first.level >= TOP_LEVEL) return;
    const partner = pearls.slice(index + 1).find((second) => !used.has(second)
      && second.level === first.level
      && Math.hypot(first.body.position.x - second.body.position.x, first.body.position.z - second.body.position.z)
        < 2 * PEARL_LEVELS[first.level].radius + FUSION_GAP);
    if (!partner) return;
    used.add(first);
    used.add(partner);
    pairs.push([first, partner]);
  });
  return pairs;
}

// How far past the pin board's plane the blade tucks in. The scraper, at 3.68, is the hard stop.
export const PEARL_RETREAT_PAST_BOARD = 0.8;

/**
 * The pearl machine's stroke, as the tray and blade positions at a physics step. The blade retreats
 * behind the pin board and reaches only as far as the coins' stroke retreats to, so the tray
 * barely shows in front of the board and the bed is fed by pearls falling off its lip, not by shoving.
 */
export function pearlStrokeZ(stepNumber, fixedStep) {
  const reach = pearlBladeReachZ();
  const half = (GAME.dropZoneZ + PEARL_RETREAT_PAST_BOARD - reach) / 2;
  const bladeZ = reach + half + half * Math.sin(stepNumber * fixedStep * GAME.pusherSpeed);
  return { trayZ: bladeZ + GAME.pusherDepth / 2, bladeZ };
}

/** How far forward the blade gets on that stroke. */
export function pearlBladeReachZ() {
  return GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
}

/** Where a slot's pearl enters: at an end of the upper tray, under the pin board. */
export function pearlSidePosition(side) {
  return { x: side * ENTRY_X, y: GAME.upperTrayY + GAME.upperTrayHeight / 2 + PEARL_RADIUS + 0.02, z: CROSS_Z };
}

/** How it leaves: across the tray, towards the far side. */
export function pearlSideVelocity(side, random = Math.random) {
  return { x: -side * CROSS_SPEED * (1 + random() * 0.15), y: 0, z: 0 };
}

/** How far across a pearl runs before turning, measured from the centre towards the far side. */
export function pearlTurnAt(random = Math.random) {
  return TURN_FROM + random() * (TURN_TO - TURN_FROM);
}

/**
 * A crossing pearl's new velocity, or null if it needs none: forward past its turn, on across if it
 * stalled before it. `lipZ` is the tray's front edge now: past it, or below the deck, it is done.
 */
export function crossSteer({ x, y, z }, velocity, { side, turnAt }, lipZ) {
  if (!side || y < GAME.upperTrayY + GAME.upperTrayHeight / 2 || z < lipZ) return null;
  if (-side * x > turnAt) return velocity.z < -TURN_FORWARD_SPEED / 2 ? null : { ...velocity, x: velocity.x * 0.5, z: -TURN_FORWARD_SPEED };
  return -side * velocity.x < CROSS_SPEED / 2 ? { ...velocity, x: -side * CROSS_SPEED } : null;
}

/** A board ball's run: past its turn from the start, so it heads straight over the lip it fell above. */
export function straightRun(x) {
  return { side: x < 0 ? 1 : -1, turnAt: -Infinity };
}

/** The side a pour's pearl leaves by: its own, or turn about for a pour from both. */
export function pourSide(side, index) {
  return side || (index % 2 ? 1 : -1);
}

/** The sideways pull on `pearl` towards its nearest like pearl, or null with none in range. */
export function fusionPull(pearl, pearls) {
  let nearest = null;
  let best = FUSION_RANGE;
  for (const other of pearls) {
    if (other === pearl || other.level !== pearl.level) continue;
    const distance = Math.hypot(other.body.position.x - pearl.body.position.x, other.body.position.z - pearl.body.position.z);
    if (distance < best && distance > 1e-3) {
      best = distance;
      nearest = other;
    }
  }
  if (!nearest) return null;
  return {
    x: ((nearest.body.position.x - pearl.body.position.x) / best) * FUSION_PULL,
    z: ((nearest.body.position.z - pearl.body.position.z) / best) * FUSION_PULL,
  };
}

/** Whether an open gate shuts: at least its minimum, then once the store is empty. */
export function gateClosesNow(openFor, minimum, stored) {
  if (openFor >= GATE_MAX_OPEN_SECONDS) return true;
  return openFor >= minimum && stored <= GATE_EMPTY_PEARLS;
}

/** `value` moved towards `target` by at most `reach`. */
export function stepTowards(value, target, reach) {
  return value + Math.min(reach, Math.max(-reach, target - value));
}

/** The gate's height after one physics step towards `target`, at GATE_SPEED. */
export function gateLiftStep(lift, target, seconds) {
  return stepTowards(lift, target, GATE_SPEED * seconds);
}

/**
/** How high the closed gate stands: lower once the store is full, so it spills. */
export function gateHeightFor(height, stored) {
  return stored >= STORE_CAPACITY ? Math.min(height, GATE_OVERFLOW_HEIGHT) : height;
}

/**
 * Where the tray is heading: its usual stroke, or its midpoint at rest. It rests there rather than
 * at an end because it must stay in step with the blade while it strokes: a pearl leaving a tray
 * out of step lands behind the blade, which shoves it under the tray for good.
 */
export function trayTargetZ(mode, gateOpen, strokeZ) {
  const moving = mode === 'A' || (mode === 'B' && gateOpen);
  return moving ? strokeZ : GAME.pusherOriginZ;
}

/** Whether a pearl is up on the tray, or over it, rather than on the bed below. */
export function pearlOnTray({ y }) {
  return y > GAME.upperTrayY + GAME.upperTrayHeight / 2;
}

/** The seeded pile: two loose layers, from behind the sill back to the tray's front edge. */
export function pearlSeedPosition(index, random = Math.random, trayFrontZ = Infinity) {
  const front = GAME.playfieldFrontZ + 0.5;
  const back = Math.min(pearlBladeReachZ() - 0.25, trayFrontZ - 0.1);
  return {
    x: (random() * 2 - 1) * 3.5,
    y: 0.4 + (index % 2) * 0.55,
    z: front + random() * (back - front),
  };
}

/**
 * The chest's last shove on the pearl machine, or null where it needs none. The blade stops short
 * of the lip and round pearls barely pass its push on, so a chest stalled for good at the lip (4 of
 * 4 headless runs, 240 s). Less chest friction was worse: it stopped riding at all. With this it
 * paid in 53-147 s and ploughs the pearls at the sill off with it.
 */
export function chestNudge(position, velocity) {
  if (position.z >= sillZ() + CHEST_NUDGE_ZONE || velocity.z <= -CHEST_NUDGE_SPEED) return null;
  return { ...velocity, z: -CHEST_NUDGE_SPEED };
}

/** 'fall' once a pearl has really gone over the lip, 'lost' if it left the machine, else null. */
export function pearlPhase(position) {
  if (position.z < GAME.playfieldFrontZ && position.y < NATURAL_FALL_Y) return 'fall';
  return position.y < GAME.lostY ? 'lost' : null;
}

/** Pearls out within 3, 10 and 30 s of `start`, from their exit times. */
export function dropStats(exits, start) {
  const within = (seconds) => exits.filter((time) => time >= start && time <= start + seconds).length;
  return { s3: within(3), s10: within(10), s30: within(30) };
}

/** A small seeded generator (mulberry32), so a lab rerun gets the same pile and the same rain. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
