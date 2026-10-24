import { COIN_RADIUS, GAME } from './config.js';

export { COIN_RADIUS };
// Thin, like a real token (about a tenth of its radius): a thick coin stacks like a draughts piece,
// a thin one shingles over its neighbours, and that overlap is what lets a clump hang out over the
// lip held up by the pile behind it.
export const COIN_HEIGHT = 0.05;
export const COIN_MASS = 0.05;
// About what the bed holds in play (95-105 coins, headless): a deeper seed has nowhere to go but
// over the lip in one avalanche the moment play starts. Laid in brick-bonded, lip-leaning layers
// (seedPosition) and held by LOWER_COIN_FRICTION - the drainage run pays nothing idle or on the
// first drop.
export const LOWER_SEED_COUNT = 110;
// Coin-on-coin grip once a coin is on the lower bed (CoinPusher switches it to the 'lowerCoin'
// material). The tray keeps COIN_COIN_FRICTION: at 0.45 there it already jams, while on the bed
// this much grip is what lets overlapping coins cantilever past the face instead of sliding off.
export const LOWER_COIN_FRICTION = 2;

/**
 * Index of a lower-bed coin that can be taken out with the least to see: the one with the most
 * coins stacked over it (a bottom-layer coin under two or more is invisible), lowest first on a
 * tie, and only well back from the lip so the clump hanging there is never undermined. With
 * nothing buried at all it falls back to the lowest coin in that back zone. -1 when the zone is
 * empty. O(n^2), so only call it when over the coin ceiling (quality.maxLiveCoins).
 */
export function buriedCoinIndex(positions, thickness = COIN_HEIGHT) {
  const reach = COIN_RADIUS * 0.8;
  let best = -1;
  let bestAbove = -1;
  for (let i = 0; i < positions.length; i += 1) {
    const low = positions[i];
    if (low.y < 0 || low.y > 0.5 || low.z < GAME.playfieldFrontZ + 1) continue;
    let above = 0;
    for (let j = 0; j < positions.length && above < 2; j += 1) {
      const p = positions[j];
      if (j === i || p.y <= low.y + thickness * 0.5 || p.y > 0.6) continue;
      if (Math.hypot(p.x - low.x, p.z - low.z) < reach) above += 1;
    }
    if (above > bestAbove || (above === bestAbove && low.y < positions[best].y)) {
      best = i;
      bestAbove = above;
    }
  }
  return best;
}

// Bounds for the live coin ceiling. A hot phone throttles its CPU (measured: an iPhone that held
// 60 fps at ~300 coins cool dropped to 20 fps at 140 once warm), so the ceiling follows the
// measured physics step instead of trusting the device's cool-headed best.
export const MIN_COIN_CEILING = 150;
const SLOW_STEP_MS = 10;
const FAST_STEP_MS = 6;

/**
 * Next live coin ceiling from the mean physics step over the last half second: down 10 when a
 * step eats most of a frame, back up 5 when there is room again, within MIN_COIN_CEILING..max.
 * The gap between the two thresholds is the hysteresis that keeps it from hunting.
 */
export function nextCoinCeiling(current, stepMs, max) {
  if (stepMs > SLOW_STEP_MS) return Math.max(MIN_COIN_CEILING, current - 10);
  if (stepMs < FAST_STEP_MS) return Math.min(max, current + 5);
  return current;
}

/** Whether a coin has come down off the tray onto the lower bed, where it takes LOWER_COIN_FRICTION. */
export function onLowerBed(position) {
  return position.y < GAME.upperTrayY - 0.12 && position.z < lowerBladeReachZ() + 0.3;
}

// The tray's front edge at full retreat, which is where the lower blade's stroke starts from too.
const trayFrontAtRetreat = () => GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;

/** Centre Z of the lower blade at a step: GAME.lowerBladeAmplitude in phase with the tray. */
export function lowerBladeZAt(stepNumber, fixedStep) {
  const amplitude = GAME.lowerBladeAmplitude;
  return trayFrontAtRetreat() - amplitude + amplitude * Math.sin(stepNumber * fixedStep * GAME.pusherSpeed);
}

/** Furthest forward the lower blade's centre ever gets. */
export function lowerBladeReachZ() {
  return trayFrontAtRetreat() - 2 * GAME.lowerBladeAmplitude;
}
// 0.14 -> 0.3 and the pusher's 1 -> 0.8 with the move to Rapier, whose friction is the coefficient
// as written (cannon-es scaled its own per contact): a deep pile at 0.14 crept off the lip idle,
// and the tray's pile at 0.6 kept marching forward over 36 idle strokes - at 0.8 it holds still.
export const COIN_GROUND_FRICTION = 0.3;
export const COIN_COIN_FRICTION = 0.3;
export const COIN_PUSHER_FRICTION = 0.8;
export const COIN_LINEAR_DAMPING = 0.12;
export const COIN_ANGULAR_DAMPING = 0.58;

// Where a chest is dropped in: hard against the scraper's front face, the deepest start that still
// clears it, so the chest rides the full length of the machine before it can pay. 0.08 is the
// scraper's half-thickness. The tray deck reaches under the scraper at every point of the stroke -
// pusherRearExtension guards it - so there is always deck beneath this.
export function chestDropZ(halfDepth) {
  return GAME.scraperZ - 0.08 - halfDepth - 0.06;
}

// Catch the chest's first lower-bed landing and absorb that impact, so it thuds instead of
// running the bed out; every later movement still comes from the coin pile, so the chest remains
// a physical obstacle the player has to push.
// The landing is only recognised behind the payout end, and that is the whole point of the z test:
// the latch below needs the chest's centre to dip to within 0.12 of its resting height, which a
// chest riding two or more coin layers never does on the way across - so the first time it dips is
// when it tips over the lip. Treating that as a landing cancelled the payout: it used to teleport
// the chest 0.84 back onto the bed and zero its forward velocity, so the slot machine never span
// and the chest had to cross the whole dead span again. The teleport was stale geometry from a
// shorter machine - the tray's front lip now travels z -2.20..2.16 and a released chest lands no
// further forward than -2.6, well behind safeZ, so it could only ever fire on a chest at the lip.
export function settleChestOnLowerBed(body, drop, halfHeight, halfDepth) {
  if (drop.lowerBedLanded || body.position.y > halfHeight + 0.12) return false;
  drop.lowerBedLanded = true;
  if (body.position.z < GAME.edgeZ + halfDepth + COIN_RADIUS) return false;
  const { x, y, z } = body.velocity;
  const spin = body.angularVelocity;
  body.setVelocity({ x, y, z: Math.max(0, z) });
  body.setAngularVelocity({ x: spin.x * 0.25, y: spin.y * 0.25, z: spin.z * 0.25 });
  return true;
}

// A body whose centre has just passed the payout lip is not falling yet: edgeZ sits 0.05 behind
// the bed's front face, so a coin still has 0.31 of deck under it and the chest 0.38, and either
// one can balance on the lip corner - measured hangs of up to 51s, with the pile behind it dammed.
// So the nudge is re-applied every frame until the body is genuinely under the bed rather than
// once when it crosses. Clamping, not setting: it only ever adds the motion that is missing, so a
// body already in free fall keeps its own arc and the repeat costs it nothing.
export function nudgeOverLip(body) {
  const { y, z } = body.velocity;
  body.setVelocity({ x: 0, y: Math.min(y, -1.5), z: Math.min(z, -3) });
}

// The knobs the tuning panel drives. All of them take effect on a running world - friction is
// re-derived per collider (world.js frictionFor) and gravity is read every step. Only
// `thickness` is different - it resizes the collision shape, which cannot grow under a settled
// stack without shoving it apart, so changing it rebuilds the pile.
export const TUNING_DEFAULTS = Object.freeze({
  mass: COIN_MASS,
  thickness: COIN_HEIGHT,
  groundFriction: COIN_GROUND_FRICTION,
  coinFriction: COIN_COIN_FRICTION,
  pusherFriction: COIN_PUSHER_FRICTION,
  lowerCoinFriction: LOWER_COIN_FRICTION,
  linearDamping: COIN_LINEAR_DAMPING,
  angularDamping: COIN_ANGULAR_DAMPING,
  tilt: GAME.payoutTilt,
});

// Return an exact bounded pose plus the secant velocity for the following physics step.
// Re-anchoring a kinematic body to this pose prevents velocity integration from slowly
// shifting the centre of its stroke.
export function pusherMotionAt(stepNumber, fixedStep) {
  const time = stepNumber * fixedStep;
  const positionZ = GAME.pusherOriginZ
    + GAME.pusherAmplitude * Math.sin(time * GAME.pusherSpeed);
  const nextPositionZ = GAME.pusherOriginZ
    + GAME.pusherAmplitude * Math.sin((time + fixedStep) * GAME.pusherSpeed);
  return {
    positionZ,
    velocityZ: (nextPositionZ - positionZ) / fixedStep,
  };
}

function seededNoise(index, channel, seed) {
  const value = Math.sin((index + 1) * 12.9898 + channel * 78.233 + seed * 0.0001) * 43758.5453;
  return value - Math.floor(value);
}

function centeredNoise(index, channel, seed) {
  return seededNoise(index, channel, seed) - 0.5;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// The collider is this much thicker than the coin drawn: world.js runs soft contacts, and a coin
// under load sinks about this far into what it rests on. Padding the collider puts the drawn coins
// back face to face instead of visibly cutting into each other.
export const COIN_COLLIDER_PAD = 0.015;

/** A pooled coin body in `world` (see world.js), disabled until released. */
export function createCoinBody(world, tuning = TUNING_DEFAULTS) {
  return world.addCoin({
    radius: COIN_RADIUS,
    thickness: tuning.thickness + COIN_COLLIDER_PAD,
    mass: tuning.mass,
    linearDamping: tuning.linearDamping,
    angularDamping: tuning.angularDamping,
  });
}

// Thickness decides whether a coin tips or slides - it is the ratio between the tipping arm and
// the resisting arm - so it is the one knob that reshapes the collider.
export function applyCoinTuning(body, tuning, resizeShape = false) {
  if (resizeShape) body.world.resizeCoin(body, COIN_RADIUS, tuning.thickness + COIN_COLLIDER_PAD);
  body.setMass(tuning.mass);
  body.setDamping(tuning.linearDamping, tuning.angularDamping);
  if (body.enabled) body.wakeUp();
}

// A seeded pile must never spawn coins interpenetrating. the solver resolves deep
// penetration with push-apart impulses, and in a jammed multi-layer pile it never fully
// resolves: the push-apart reaches equilibrium with the damping instead of stopping, so
// the coins never drop below their sleep threshold and shimmer forever. Both pitches
// therefore exceed the coin diameter by more than the jitter below can close.
// Derived from the coin, so a resized coin keeps the same slack: at the 0.36 radius these are the
// 0.78 / 0.80 / 0.75 the pile was tuned with.
const COLUMN_PITCH = COIN_RADIUS * 2 + 0.06; // 0.06 of slack per gap
const ROW_PITCH = COIN_RADIUS * 2 + 0.08; // 0.08 of slack per gap
const LOWER_ROW_PITCH = COIN_RADIUS * 2 + 0.03; // keeps force chains close while fitting the band
// A seeded front coin keeps roughly three quarters of a diameter of table ahead of its rim. The old
// 0.04 gap put the front row at the tipping point, so the first normal stroke paid it out before the
// player had added enough coins to complete a force chain.
// 0.38 -> 0.53 moves with playfieldFrontZ, which went the same 0.15 the other way: the pile keeps
// its position relative to the blade and the tray, and only the payout lip gets further from it.
// That distance is what the load settle spends - the upper seed's top layer topples onto the pile
// and shoves the front row about 0.7 forward before anything sleeps, and the longer stroke made
// that shove harder. Sizing this against the creep rather than against taste is the point: the
// front row is meant to settle near the lip, just not over it.
// 0.53 -> 0.85 with the three-layer seed: its front row sat close enough to the lip to slide off.
const LOWER_FRONT_GAP = 0.85;
// Ends of the band on the lower bed the blade never touches. The back end is the blade's forward
// extreme, not its mid-stroke face: a coin is only genuinely out of reach when its back edge sits
// forward of the furthest the blade ever travels. This used to measure from the mid-stroke face and
// subtract two rows to compensate, which worked only for the stroke it was tuned against - the
// deeper tray moved the extreme 0.2 forward and the rearmost seeded row landed inside blade reach,
// so every idle stroke compressed the pile and the settle spilled a coin over the lip on its own.
// Read at seed time, not at import time: the geometry panel moves both ends of this band.
// The back end can be shoved in front of the front end by an extreme pair of settings, so it is
// held open to a single row rather than inverted.
function lowerSeedBand() {
  const front = GAME.playfieldFrontZ + COIN_RADIUS + LOWER_FRONT_GAP;
  const back = Math.max(
    front,
    lowerBladeReachZ() - COIN_RADIUS - 0.04,
  );
  return { front, back, rows: Math.floor((back - front) / LOWER_ROW_PITCH) + 1 };
}
const LAYER_OFFSET = 0.03; // whole-layer nudge, cannot close a gap within a layer
// Whole-row nudge. Free in X: two coins of different rows are already a row pitch apart in Z,
// which beats the diameter on its own, so only the side walls bound this.
const ROW_JITTER = 0.14;
const COIN_JITTER_X = 0.04; // per coin, so neighbours differ by at most 0.04 < 0.06 of slack
const COIN_JITTER_Z = 0.06; // per coin, at most 0.06 < 0.08 of slack
const LOWER_COIN_JITTER_Z = 0.02; // preserve clearance at the tighter lower row pitch
const LOWER_LAYER_LEAN = 0.1; // each lower layer sits this much further towards the lip

// Widest a seeded coin centre may sit: inside the glass by a radius, less a margin. The lattice
// is then cut to fit, so widening GAME.playfieldHalfWidth fills the extra room with real columns
// instead of stretching the same few across it.
const SEED_MAX_X = GAME.playfieldHalfWidth - COIN_RADIUS - 0.06;
// The outermost column has to fit with its jitter already spent, not be clamped onto SEED_MAX_X.
// Clamping looks harmless and is not: it stacks that column's coins onto one X while its
// neighbour keeps its own, closing the gap below a diameter and seeding the pile overlapping.
const SEED_JITTER_X = LAYER_OFFSET + ROW_JITTER / 2 + COIN_JITTER_X / 2;
const SEED_COLUMNS = Math.floor(((SEED_MAX_X - SEED_JITTER_X) * 2) / COLUMN_PITCH) + 1;
const COLUMN_ORIGIN = -((SEED_COLUMNS - 1) / 2) * COLUMN_PITCH;
// How many coins one layer of the lower pile holds - the width knob's visible consequence, and
// the geometry panel's: a shortened bed holds fewer rows, and the seeder stacks the remainder.
export function lowerSlotsPerLayer() {
  return SEED_COLUMNS * lowerSeedBand().rows;
}

// The upper pile is ragged - gaps down in the body of it, a thinning crown on top. Filling every
// lattice slot in order instead reads as brickwork. Slots are skipped by a seeded coin flip
// that gets likelier with height, so the same coin budget spreads over more, sparser layers
// and a coin seeded above a gap drops into it while the pile settles.
const BASE_VACANCY = 0.1;
const LAYER_VACANCY = 0.13;
const MAX_VACANCY = 0.5; // keeps the scan below terminating however tall the pile gets
const MAX_SEED_LAYERS = 12;

// Coin index -> the n-th slot the vacancy flip left occupied.
// ponytail: linear scan, worth an index only if the seed count grows an order of magnitude.
function occupiedSlot(index, seed, channel, perLayer) {
  let remaining = index;
  for (let slot = 0; slot < perLayer * MAX_SEED_LAYERS; slot += 1) {
    const layer = Math.floor(slot / perLayer);
    const vacancy = Math.min(BASE_VACANCY + layer * LAYER_VACANCY, MAX_VACANCY);
    if (seededNoise(slot, channel, seed) < vacancy) continue;
    if (remaining === 0) return slot;
    remaining -= 1;
  }
  return index; // out of slots: fall back to the dense lattice rather than stack forever
}

// Pick unique slots from one layer in a seed-dependent order. Ranking all 40 candidates is
// cheap at reset time and, unlike vacancy-scanning, guarantees that an unlucky random seed can
// never spill the lower bed into a second layer for no reason. A bed shortened past the seed
// count is the one reason: then the overflow stacks in whole layers, never on a taken slot.
function singleLayerSlot(index, seed, channel, perLayer) {
  const slots = Array.from({ length: perLayer }, (_, slot) => slot);
  slots.sort((a, b) => seededNoise(a, channel, seed) - seededNoise(b, channel, seed) || a - b);
  return slots[index % perLayer];
}

// Layer spacing has to follow the tunable thickness, or a thicker coin seeds the pile already
// interpenetrating and the solver never resolves it. At the old 0.1 coin both expressions below
// reduced to the constants they replaced (0.13 pitch, 0.07 resting centre); 0.05 gives 0.14 / 0.045.
// trayZ is where the tray actually is when the pile is seeded, which is not the origin: the
// pile is seeded at full retreat so the settle can spend its whole budget on the forward
// stroke. Seeding the upper tier against the origin instead drops those coins a full
// amplitude behind the tray, i.e. behind the scraper, which sweeps every one of them off.
export function seedPosition(index, seed = 0, thickness = COIN_HEIGHT, trayZ = GAME.pusherOriginZ) {
  const columnOf = (slot, columns) => slot % columns;
  // Seeded rather than alternating: a strict -/+ alternation stripes the pile when seen from
  // the front. Shared by a whole layer either way, so it cannot close a gap inside one.
  const layerNudge = (layer) => centeredNoise(layer, 29, seed) * 2 * LAYER_OFFSET;
  // Layers are seeded with real air under them: the drop is what tumbles a coin off the slot
  // it started on, which is half of what turns the lattice into a heap in CoinPusher's
  // settlePile(). 0.03 was just enough clearance not to interpenetrate, and left the pile
  // standing in the neat columns it was seeded in.
  const layerPitch = thickness + 0.09;

  if (index >= LOWER_SEED_COUNT) {
    const upperIndex = index - LOWER_SEED_COUNT;
    const columns = SEED_COLUMNS;
    // Seed rows in tray-local Z: a coin resting on the tray rides with it, so what matters is
    // its offset from the tray centre, not its world position. Two limits bound the band that
    // stays undisturbed - past the front the coin overhangs the tray, past the back the
    // scraper catches it once per stroke and shoves it forward forever. Moving the scraper
    // forward so the tray actually drains left only one row's worth of that band, so the upper
    // seed is a small multi-layer buffer that feeds the deliberately sparse lower bed.
    const rows = 1;
    const perLayer = columns * rows;
    const slotIndex = occupiedSlot(upperIndex, seed, 23, perLayer);
    const layer = Math.floor(slotIndex / perLayer);
    const slot = slotIndex % perLayer;
    const row = Math.floor(slot / columns);
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const trayFront = COIN_RADIUS - GAME.pusherDepth / 2;
    const scraperReach = GAME.scraperZ - 0.08 - COIN_RADIUS
      - (GAME.pusherOriginZ + GAME.pusherAmplitude);
    const rowOrigin = trayZ + (trayFront + scraperReach - (rows - 1) * ROW_PITCH) / 2;

    return {
      tier: 'upper',
      x: clamp(
        COLUMN_ORIGIN + columnOf(slot, columns) * COLUMN_PITCH + layerNudge(layer)
          + centeredNoise(row + layer * rows, 3, seed) * ROW_JITTER
          + centeredNoise(index, 5, seed) * COIN_JITTER_X,
        -SEED_MAX_X,
        SEED_MAX_X,
      ),
      y: trayTop + thickness / 2 + 0.02 + layer * layerPitch,
      z: clamp(
        rowOrigin + row * ROW_PITCH + centeredNoise(index, 7, seed) * COIN_JITTER_Z,
        trayZ + trayFront,
        trayZ + scraperReach,
      ),
    };
  }

  const columns = SEED_COLUMNS;
  const { front, back, rows } = lowerSeedBand();
  const perLayer = columns * rows;
  const slot = singleLayerSlot(index, seed, 19, perLayer);
  const layer = Math.floor(index / perLayer);
  const row = Math.floor(slot / columns);
  // Brick-bond the layers and lean each one a little further towards the lip: a lattice seeded
  // straight up stands in towers that topple and slide off whole, while coins laid half over the
  // gap below shingle into a heap whose front edge overhangs the bed.
  const brickX = (layer % 2) * COLUMN_PITCH / 2;
  const lean = layer * LOWER_LAYER_LEAN;

  return {
    tier: 'lower',
    x: clamp(
      COLUMN_ORIGIN + columnOf(slot, columns) * COLUMN_PITCH + brickX + layerNudge(layer)
        + centeredNoise(row + layer * rows, 11, seed) * ROW_JITTER
        + centeredNoise(index, 13, seed) * COIN_JITTER_X,
      -SEED_MAX_X,
      SEED_MAX_X,
    ),
    y: thickness / 2 + 0.02 + layer * layerPitch,
    z: clamp(
      front + row * LOWER_ROW_PITCH + centeredNoise(index, 17, seed) * LOWER_COIN_JITTER_Z - lean,
      Math.max(front - lean, GAME.playfieldFrontZ + COIN_RADIUS + 0.02),
      back,
    ),
  };
}
