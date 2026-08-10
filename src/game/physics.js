import * as CANNON from 'cannon-es';
import { GAME } from './config.js';

export const COIN_RADIUS = 0.36;
export const COIN_HEIGHT = 0.1;
export const COIN_MASS = 0.05;
export const LOWER_SEED_COUNT = 52;
export const COIN_GROUND_FRICTION = 0.14;
export const COIN_COIN_FRICTION = 0.3;
export const COIN_PUSHER_FRICTION = 1;
export const COIN_LINEAR_DAMPING = 0.12;
export const COIN_ANGULAR_DAMPING = 0.58;
// More rim faces keep coin-to-coin normals from jumping as crowded coins rotate.
const COIN_SEGMENTS = 20;

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
const LOWER_ROW_PITCH = 0.75; // fit four rows on the shorter lower playfield
const COLUMN_ORIGIN = -1.95; // centres 6 columns; the outermost coin still clears the side walls
const LAYER_OFFSET = 0.03; // whole-layer nudge, cannot close a gap within a layer
// Whole-row nudge. Free in X: two coins of different rows are already a row pitch apart in Z,
// which beats the diameter on its own, so only the side walls bound this.
const ROW_JITTER = 0.14;
const COIN_JITTER_X = 0.04; // per coin, so neighbours differ by at most 0.04 < 0.06 of slack
const COIN_JITTER_Z = 0.06; // per coin, at most 0.06 < 0.08 of slack
const LOWER_COIN_JITTER_Z = 0.02; // preserve clearance at the tighter lower row pitch

// A real pile is ragged - gaps down in the body of it, a thinning crown on top. Filling every
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
    const columns = 6;
    // Seed rows in tray-local Z: a coin resting on the tray rides with it, so what matters is
    // its offset from the tray centre, not its world position. Two limits bound the band that
    // stays undisturbed - past the front the coin overhangs the tray, past the back the
    // scraper catches it once per stroke and shoves it forward forever. Moving the scraper
    // forward so the tray actually drains left only one row's worth of that band, so the rest
    // of the seed budget goes to the lower pile instead (LOWER_SEED_COUNT).
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
        -2.04,
        2.04,
      ),
      y: trayTop + thickness / 2 + 0.02 + layer * layerPitch,
      z: clamp(
        rowOrigin + row * ROW_PITCH + centeredNoise(index, 7, seed) * COIN_JITTER_Z,
        trayZ + trayFront,
        trayZ + scraperReach,
      ),
    };
  }

  const columns = 6;
  const rows = 4;
  const perLayer = columns * rows;
  const slotIndex = occupiedSlot(index, seed, 19, perLayer);
  const layer = Math.floor(slotIndex / perLayer);
  const slot = slotIndex % perLayer;
  const row = Math.floor(slot / columns);
  const safeFront = GAME.playfieldFrontZ + COIN_RADIUS + 0.04;
  const initialPusherFront = GAME.pusherOriginZ - GAME.pusherDepth / 2;
  const safeBack = initialPusherFront - COIN_RADIUS - 0.04;

  return {
    tier: 'lower',
    x: clamp(
      COLUMN_ORIGIN + columnOf(slot, columns) * COLUMN_PITCH + layerNudge(layer)
        + centeredNoise(row + layer * rows, 11, seed) * ROW_JITTER
        + centeredNoise(index, 13, seed) * COIN_JITTER_X,
      -2.04,
      2.04,
    ),
    y: thickness / 2 + 0.02 + layer * layerPitch,
    z: clamp(
      safeFront + row * LOWER_ROW_PITCH
        + centeredNoise(index, 17, seed) * LOWER_COIN_JITTER_Z,
      safeFront,
      safeBack,
    ),
  };
}
