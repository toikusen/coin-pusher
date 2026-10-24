import { GAME } from '../src/game/config.js';
import { createCoinBody, lowerBladeZAt, pusherMotionAt, TUNING_DEFAULTS } from '../src/game/physics.js';
import { PhysicsWorld } from '../src/game/world.js';

export const FIXED_STEP = 1 / 60;
export const BED_WIDTH = GAME.playfieldHalfWidth * 2 + 0.15;
export const GLASS_X = GAME.playfieldHalfWidth + 0.125;

export function createWorld({ fixedStep = FIXED_STEP, tilt = GAME.payoutTilt } = {}) {
  return new PhysicsWorld({
    gravity: { x: 0, y: -24, z: -tilt }, fixedStep, iterations: 4,
    tuning: TUNING_DEFAULTS, chestScale: GAME.chestFrictionScale,
  });
}

export function spawnCoin(world, position, quaternion) {
  const body = createCoinBody(world);
  body.setPose(position, quaternion);
  body.setEnabled(true);
  return body;
}

export function spawnChest(world, position) {
  const body = world.addDynamicBox({
    x: GAME.chestWidth / 2, y: GAME.chestWidth * 0.7 / 2, z: GAME.chestWidth * 0.74 / 2,
  }, {
    mass: GAME.chestMass, linearDamping: GAME.chestLinearDamping,
    angularDamping: GAME.chestAngularDamping,
  });
  body.setPose(position);
  body.setEnabled(true);
  return body;
}

/** Mirrors CoinPusher's physical cabinet and analytical beforeStep pusher driver. */
export function createMachine({ fixedStep = FIXED_STEP } = {}) {
  const world = createWorld({ fixedStep });
  const addStatic = (width, height, depth, x, y, z, options) => world.addStaticBox(
    { x: width / 2, y: height / 2, z: depth / 2 }, { x, y, z }, options,
  );
  const depth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
  const center = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
  addStatic(BED_WIDTH, 0.5, depth, 0, -0.25, center);
  addStatic(BED_WIDTH, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05);
  for (const x of [-GLASS_X, GLASS_X]) addStatic(0.25, 2.4, depth + 0.2, x, 0.95, center);
  const rearFront = GAME.pusherOriginZ - GAME.pusherAmplitude
    + GAME.pusherDepth / 2 + GAME.pusherRearExtension - 0.15;
  const rearSpan = GAME.playfieldBackZ - 0.05 - rearFront;
  addStatic(BED_WIDTH - 0.2, GAME.upperTrayHeight, Math.max(rearSpan, 0.02),
    0, GAME.upperTrayY - GAME.deckClearance, rearFront + rearSpan / 2);
  const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;
  const guardHeight = GAME.scraperGuardTopY - trayTop;
  addStatic(BED_WIDTH, guardHeight, 0.16, 0, trayTop + guardHeight / 2, GAME.scraperZ);

  const chuteZ = GAME.playfieldFrontZ - 1.1;
  const chuteFloorY = -1.6;
  const wallTop = -1;
  const wallHeight = wallTop - chuteFloorY + 0.3;
  const wallY = wallTop - wallHeight / 2;
  addStatic(BED_WIDTH + 0.4, 0.3, 2, 0, chuteFloorY - 0.15, chuteZ);
  for (const side of [-1, 1]) {
    addStatic(0.2, wallHeight, 2, side * (GAME.playfieldHalfWidth + 0.175), wallY, chuteZ);
  }
  addStatic(BED_WIDTH + 0.4, wallHeight, 0.2, 0, wallY, chuteZ - 0.9);

  const bladeHeight = 0.64;
  const pusher = world.addKinematicBoxes([
    {
      halfExtents: { x: (BED_WIDTH - 0.3) / 2, y: GAME.upperTrayHeight / 2,
        z: (GAME.pusherDepth + GAME.pusherRearExtension) / 2 },
      offset: { x: 0, y: GAME.upperTrayY, z: GAME.pusherRearExtension / 2 },
    },
  ], { x: 0, y: 0, z: pusherMotionAt(0, fixedStep).positionZ });
  const blade = world.addKinematicBoxes([
    { halfExtents: { x: (BED_WIDTH - 0.3) / 2, y: bladeHeight / 2, z: 0.07 }, offset: { x: 0, y: bladeHeight / 2, z: 0 } },
  ], { x: 0, y: 0, z: lowerBladeZAt(0, fixedStep) });
  const drivePusher = (stepNumber) => {
    const { positionZ } = pusherMotionAt(stepNumber, fixedStep);
    pusher.rb.setNextKinematicTranslation({ x: 0, y: 0, z: positionZ });
    blade.rb.setNextKinematicTranslation({ x: 0, y: 0, z: lowerBladeZAt(stepNumber, fixedStep) });
  };
  world.beforeStep.push(drivePusher);
  return { world, pusher, blade, drivePusher };
}
