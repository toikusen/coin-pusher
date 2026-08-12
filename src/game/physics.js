import * as CANNON from 'cannon-es';
import { GAME } from './config.js';

export const COIN_RADIUS = 0.36;
export const COIN_HEIGHT = 0.1;
export const COIN_MASS = 0.05;
// Fill most of the lower tier's safe slots while preserving a full receiving row in front of the
// blade. The initial pile deliberately does not complete the blade-to-lip force chain: player
// drops fill that last link, so an idle machine and the very first drop cannot pay out for free.
export const LOWER_SEED_COUNT = 14;
export const COIN_GROUND_FRICTION = 0.14;
export const COIN_COIN_FRICTION = 0.3;
export const COIN_PUSHER_FRICTION = 1;
export const COIN_LINEAR_DAMPING = 0.12;
export const COIN_ANGULAR_DAMPING = 0.58;
// More rim faces keep coin-to-coin normals from jumping as crowded coins rotate.
const COIN_SEGMENTS = 20;

// cannon-es creates one friction pair for every contact in a convex manifold and gives each pair
// the full material friction budget. A flat 20-sided coin therefore receives roughly 20 copies of
// the intended table friction. Its solver also clamps impulses per step, so the same material feels
// twice as sticky at 120 Hz as at 60 Hz. frictionGravity is the supported force-scale override;
// calibrating it by both the fixed step and the face contact count makes the public coefficients
// behave like coefficients again and keeps low/high-power profiles consistent.
export function syncFrictionGravity(world, fixedStep) {
  world.frictionGravity ??= new CANNON.Vec3();
  world.gravity.scale(fixedStep / COIN_SEGMENTS, world.frictionGravity);
}

// The knobs the tuning panel drives. All of them take effect on a running world: cannon-es
// reads friction off the ContactMaterial during narrowphase and gravity off the world every
// step. Only `thickness` is different - it resizes the collision shape, which cannot grow
// under a settled stack without shoving it apart, so changing it rebuilds the pile.
export const TUNING_DEFAULTS = Object.freeze({
  mass: COIN_MASS,
  thickness: COIN_HEIGHT,
  groundFriction: COIN_GROUND_FRICTION,
  coinFriction: COIN_COIN_FRICTION,
  pusherFriction: COIN_PUSHER_FRICTION,
  linearDamping: COIN_LINEAR_DAMPING,
  angularDamping: COIN_ANGULAR_DAMPING,
  tilt: GAME.payoutTilt,
});

export const CONTACT_SOLVER_OPTIONS = Object.freeze({
  restitution: 0,
  contactEquationStiffness: 1e7,
  contactEquationRelaxation: 5,
  frictionEquationStiffness: 1e7,
  frictionEquationRelaxation: 5,
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

export function createCoinBody(material, tuning = TUNING_DEFAULTS) {
  const body = new CANNON.Body({
    mass: tuning.mass,
    material,
    allowSleep: true,
    // Treat tiny solver residuals as rest sooner so a settled pile does not shimmer.
    sleepSpeedLimit: 0.18,
    sleepTimeLimit: 0.45,
  });

  // cannon-es cylinders already use Y as their height axis, matching Three.js.
  // Shapes cannot be shared: Body.addShape assigns shape.body to its owner.
  body.addShape(new CANNON.Cylinder(COIN_RADIUS, COIN_RADIUS, tuning.thickness, COIN_SEGMENTS));
  body.linearDamping = tuning.linearDamping;
  body.angularDamping = tuning.angularDamping;
  return body;
}

// cannon-es approximates a body's inertia from its AABB (Body.updateMassProperties), so
// thickness is the knob that actually decides whether a coin tips or slides: it is the only one
// that changes the ratio between the tipping arm and the resisting arm. Mass on its own is
// close to neutral - weight and inertia scale together, and the friction ceiling is derived
// from mass too, so a heavier coin is pushed by a proportionally larger force.
export function applyCoinTuning(body, tuning, resizeShape = false) {
  if (resizeShape) {
    body.shapes.length = 0;
    body.shapeOffsets.length = 0;
    body.shapeOrientations.length = 0;
    body.addShape(new CANNON.Cylinder(COIN_RADIUS, COIN_RADIUS, tuning.thickness, COIN_SEGMENTS));
  }
  body.mass = tuning.mass;
  body.linearDamping = tuning.linearDamping;
  body.angularDamping = tuning.angularDamping;
  body.updateMassProperties();
  body.aabbNeedsUpdate = true;
  body.wakeUp();
}

// A seeded pile must never spawn coins interpenetrating. cannon-es resolves deep
// penetration with push-apart impulses, and in a jammed multi-layer pile it never fully
// resolves: the push-apart reaches equilibrium with the damping instead of stopping, so
// the coins never drop below their sleep threshold and shimmer forever. Both pitches
// therefore exceed the coin diameter by more than the jitter below can close.
const COLUMN_PITCH = 0.78; // vs a 0.72 diameter, so 0.06 of slack per gap
const ROW_PITCH = 0.80; // 0.08 of slack per gap
const LOWER_ROW_PITCH = 0.75; // keeps force chains close while fitting the full lower band
// A seeded front coin keeps roughly half a diameter of table ahead of its rim. The old 0.04 gap
// put the front row at the tipping point, so the first normal stroke paid it out before the player
// had added enough coins to complete a force chain.
const LOWER_FRONT_GAP = 0.38;
// Ends of the band on the lower bed that is clear of both the front lip and the retreated blade.
const LOWER_SAFE_FRONT = GAME.playfieldFrontZ + COIN_RADIUS + LOWER_FRONT_GAP;
const LOWER_SAFE_BACK = GAME.pusherOriginZ - GAME.pusherDepth / 2 - COIN_RADIUS - 0.04;
const LOWER_ROWS = Math.round((LOWER_SAFE_BACK - LOWER_SAFE_FRONT) / LOWER_ROW_PITCH) + 1;
// Leave a two-row receiving band in front of the blade. One empty row was still within direct
// blade reach, so every idle stroke compressed the seeded rows and eventually paid them out.
// Player drops now have to build the missing rear links before the blade can reach the front pile.
const LOWER_SEED_ROWS = Math.max(1, LOWER_ROWS - 2);
const LAYER_OFFSET = 0.03; // whole-layer nudge, cannot close a gap within a layer
// Whole-row nudge. Free in X: two coins of different rows are already a row pitch apart in Z,
// which beats the diameter on its own, so only the side walls bound this.
const ROW_JITTER = 0.14;
const COIN_JITTER_X = 0.04; // per coin, so neighbours differ by at most 0.04 < 0.06 of slack
const COIN_JITTER_Z = 0.06; // per coin, at most 0.06 < 0.08 of slack
const LOWER_COIN_JITTER_Z = 0.02; // preserve clearance at the tighter lower row pitch

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
// How many coins one layer of the lower pile holds - the width knob's visible consequence.
export const LOWER_SLOTS_PER_LAYER = SEED_COLUMNS * LOWER_SEED_ROWS;

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
// never spill the lower bed into a second layer.
function singleLayerSlot(index, seed, channel, perLayer) {
  const slots = Array.from({ length: perLayer }, (_, slot) => slot);
  slots.sort((a, b) => seededNoise(a, channel, seed) - seededNoise(b, channel, seed) || a - b);
  return slots[index];
}

// Layer spacing has to follow the tunable thickness, or a thicker coin seeds the pile already
// interpenetrating and cannon-es never resolves it. At the default 0.1 both expressions below
// reduce to the constants they replaced (0.13 pitch, 0.07 resting centre).
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
  const rows = LOWER_SEED_ROWS;
  const perLayer = columns * rows;
  const slot = singleLayerSlot(index, seed, 19, perLayer);
  const layer = 0;
  const row = Math.floor(slot / columns);

  return {
    tier: 'lower',
    x: clamp(
      COLUMN_ORIGIN + columnOf(slot, columns) * COLUMN_PITCH + layerNudge(layer)
        + centeredNoise(row + layer * rows, 11, seed) * ROW_JITTER
        + centeredNoise(index, 13, seed) * COIN_JITTER_X,
      -SEED_MAX_X,
      SEED_MAX_X,
    ),
    y: thickness / 2 + 0.02 + layer * layerPitch,
    z: clamp(
      LOWER_SAFE_FRONT + row * LOWER_ROW_PITCH
        + centeredNoise(index, 17, seed) * LOWER_COIN_JITTER_Z,
      LOWER_SAFE_FRONT,
      LOWER_SAFE_BACK,
    ),
  };
}
