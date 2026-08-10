import * as CANNON from 'cannon-es';
import { GAME } from '/Users/seitumbp2025/coin-pusher/src/game/config.js';
import {
  COIN_HEIGHT, COIN_RADIUS, COIN_MASS, CONTACT_SOLVER_OPTIONS, LOWER_SEED_COUNT, seedPosition,
} from '/Users/seitumbp2025/coin-pusher/src/game/physics.js';

function run({ groundFriction, coinFriction, linearDamping, tilt, seconds = 40, seed = 777 }) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, -tilt), allowSleep: true });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 32;

  const ground = new CANNON.Material('ground');
  const coinMat = new CANNON.Material('coin');
  world.addContactMaterial(new CANNON.ContactMaterial(coinMat, ground, { ...CONTACT_SOLVER_OPTIONS, friction: groundFriction }));
  world.addContactMaterial(new CANNON.ContactMaterial(coinMat, coinMat, { ...CONTACT_SOLVER_OPTIONS, friction: coinFriction }));

  const addStatic = (w, h, d, x, y, z) => {
    const b = new CANNON.Body({ mass: 0, material: ground });
    b.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    b.position.set(x, y, z);
    world.addBody(b);
  };
  const depth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
  const center = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
  addStatic(5, 0.5, depth, 0, -0.25, center);                                   // lower bed
  addStatic(4.8, GAME.upperTrayHeight, 2.1, 0, GAME.upperTrayY - GAME.deckClearance, 2.9); // rear deck
  addStatic(4.8, 0.68, 0.16, 0, 1.05, GAME.scraperZ);                           // scraper
  addStatic(0.25, 2.4, depth + 0.2, -2.55, 0.95, center);
  addStatic(0.25, 2.4, depth + 0.2, 2.55, 0.95, center);

  const bladeHeight = 0.64;
  const pusher = new CANNON.Body({ mass: 0, material: ground, type: CANNON.Body.KINEMATIC });
  pusher.addShape(new CANNON.Box(new CANNON.Vec3(2.35, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)), new CANNON.Vec3(0, GAME.upperTrayY, 0));
  pusher.addShape(new CANNON.Box(new CANNON.Vec3(2.35, bladeHeight / 2, 0.07)), new CANNON.Vec3(0, bladeHeight / 2, -GAME.pusherDepth / 2));
  pusher.position.set(0, 0, GAME.pusherOriginZ);
  world.addBody(pusher);

  const makeCoin = () => {
    const b = new CANNON.Body({ mass: COIN_MASS, material: coinMat, allowSleep: true, sleepSpeedLimit: 0.28, sleepTimeLimit: 0.35 });
    b.addShape(new CANNON.Cylinder(COIN_RADIUS, COIN_RADIUS, COIN_HEIGHT, 20));
    b.linearDamping = linearDamping;
    b.angularDamping = 0.72;
    return b;
  };

  const coins = [];
  for (let i = 0; i < 64; i += 1) {
    const s = seedPosition(i, seed);
    const b = makeCoin();
    b.position.set(s.x, s.y, s.z);
    b.previousPosition.copy(b.position);
    world.addBody(b);
    coins.push(b);
  }

  const step = 1 / 120;
  for (let i = 0; i < 240; i += 1) world.step(step, step, 4);

  let dropped = 0;
  let idleDropped = 0;
  const total = Math.round(seconds / step);
  const dropEvery = Math.round(GAME.autoInterval / step);
  const idleSteps = Math.round(10 / step); // first 10 s: nobody drops anything
  const lowerStart = coins.slice(0, LOWER_SEED_COUNT).reduce((s, b) => s + b.position.z, 0) / LOWER_SEED_COUNT;
  const upperStart = coins.slice(LOWER_SEED_COUNT).reduce((s, b) => s + b.position.z, 0) / (64 - LOWER_SEED_COUNT);

  for (let i = 0; i < total; i += 1) {
    const t = i * step;
    pusher.position.z = GAME.pusherOriginZ + GAME.pusherAmplitude * Math.sin(t * GAME.pusherSpeed);
    pusher.velocity.set(0, 0, GAME.pusherAmplitude * GAME.pusherSpeed * Math.cos(t * GAME.pusherSpeed));
    pusher.aabbNeedsUpdate = true;
    world.step(step, step, 4);

    if (i > idleSteps && i % dropEvery === 0) {
      const b = makeCoin();
      b.position.set((seededX(i) - 0.5) * 3, 2.2, GAME.dropZoneZ);
      b.previousPosition.copy(b.position);
      world.addBody(b);
      coins.push(b);
    }
    for (const b of coins) {
      if (!b.__gone && b.position.z < GAME.edgeZ) {
        b.__gone = true;
        dropped += 1;
        if (i <= idleSteps) idleDropped += 1;
        b.position.set(0, -20, 0); b.velocity.setZero(); b.sleep();
      }
    }
  }
  const live = coins.slice(0, LOWER_SEED_COUNT).filter((b) => !b.__gone);
  const upperLive = coins.slice(LOWER_SEED_COUNT, 64).filter((b) => !b.__gone);
  return {
    dropped,
    idleDropped,
    lowerDrift: live.length ? live.reduce((s, b) => s + b.position.z, 0) / live.length - lowerStart : NaN,
    upperDrift: upperLive.length ? upperLive.reduce((s, b) => s + b.position.z, 0) / upperLive.length - upperStart : NaN,
  };
}

function seededX(i) {
  const v = Math.sin(i * 91.7 + 3.1) * 43758.5453;
  return v - Math.floor(v);
}

const sets = [
  ['current', { groundFriction: 0.52, coinFriction: 0.48, linearDamping: 0.35, tilt: 1.2 }],
  ['A friction only', { groundFriction: 0.34, coinFriction: 0.32, linearDamping: 0.35, tilt: 1.2 }],
  ['B +damping', { groundFriction: 0.34, coinFriction: 0.32, linearDamping: 0.15, tilt: 1.2 }],
  ['C +tilt', { groundFriction: 0.34, coinFriction: 0.32, linearDamping: 0.15, tilt: 1.8 }],
  ['D tilt only', { groundFriction: 0.52, coinFriction: 0.48, linearDamping: 0.35, tilt: 1.8 }],
  ['E aggressive', { groundFriction: 0.26, coinFriction: 0.24, linearDamping: 0.1, tilt: 2.2 }],
];

for (const [name, params] of sets) {
  const seedResults = [111, 777, 4242].map((seed) => run({ ...params, seed }));
  const avg = (k) => (seedResults.reduce((s, r) => s + r[k], 0) / seedResults.length).toFixed(2);
  console.log(
    name.padEnd(16),
    'payout/40s:', avg('dropped').padStart(6),
    ' idle-leak:', avg('idleDropped').padStart(5),
    ' lowerDrift:', avg('lowerDrift').padStart(6),
    ' upperDrift:', avg('upperDrift').padStart(6),
  );
}
