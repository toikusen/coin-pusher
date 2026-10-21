// Headless replica of CoinPusher's world: same bodies, same stroke, same drops.
// Reports where coins end up in Z after N seconds of play.
import * as CANNON from 'cannon-es';
import { GAME } from '/Users/seitumbp2025/coin-pusher/src/game/config.js';
import {
  COIN_HEIGHT, COIN_RADIUS, COIN_MASS, COIN_SEGMENTS, CONTACT_SOLVER_OPTIONS,
  COIN_GROUND_FRICTION, COIN_COIN_FRICTION, COIN_PUSHER_FRICTION,
  COIN_LINEAR_DAMPING, COIN_ANGULAR_DAMPING,
  seedPosition, pusherMotionAt,
} from '/Users/seitumbp2025/coin-pusher/src/game/physics.js';

const BED_WIDTH = GAME.playfieldHalfWidth * 2;
const INNER_X = GAME.playfieldHalfWidth;
const STEP = 1 / 120;
const RAIL_LENGTH = INNER_X - GAME.railExitX;
const RAIL_RISE = GAME.railRise;
const RAIL_SLOPE = RAIL_RISE / RAIL_LENGTH;

export function build() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, -GAME.payoutTilt), allowSleep: true });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 32;

  const ground = new CANNON.Material('ground');
  const coinMat = new CANNON.Material('coin');
  const pusherMat = new CANNON.Material('pusher');
  world.addContactMaterial(new CANNON.ContactMaterial(coinMat, ground, { ...CONTACT_SOLVER_OPTIONS, friction: COIN_GROUND_FRICTION }));
  world.addContactMaterial(new CANNON.ContactMaterial(coinMat, coinMat, { ...CONTACT_SOLVER_OPTIONS, friction: COIN_COIN_FRICTION }));
  world.addContactMaterial(new CANNON.ContactMaterial(coinMat, pusherMat, { ...CONTACT_SOLVER_OPTIONS, friction: COIN_PUSHER_FRICTION }));

  const addStatic = (w, h, d, x, y, z) => {
    const b = new CANNON.Body({ mass: 0, material: ground });
    b.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    b.position.set(x, y, z);
    world.addBody(b);
    return b;
  };
  const depth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
  const center = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
  addStatic(BED_WIDTH, 0.5, depth, 0, -0.25, center);                                    // lower bed
  addStatic(BED_WIDTH, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05);                  // back panel
  addStatic(0.25, 2.4, depth + 0.2, -(INNER_X + 0.125), 0.95, center);                   // glass L
  addStatic(0.25, 2.4, depth + 0.2, INNER_X + 0.125, 0.95, center);                      // glass R
  addStatic(BED_WIDTH - 0.2, GAME.upperTrayHeight, 2.1, 0, GAME.upperTrayY - GAME.deckClearance, 2.9); // rear deck
  addStatic(BED_WIDTH - 0.2, 0.68, 0.16, 0, 1.05, GAME.scraperZ);                        // scraper

  const bladeHeight = 0.64;
  const pusher = new CANNON.Body({ mass: 0, material: pusherMat, type: CANNON.Body.KINEMATIC });
  pusher.addShape(new CANNON.Box(new CANNON.Vec3((BED_WIDTH - 0.3) / 2, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)), new CANNON.Vec3(0, GAME.upperTrayY, 0));
  pusher.addShape(new CANNON.Box(new CANNON.Vec3((BED_WIDTH - 0.3) / 2, bladeHeight / 2, 0.07)), new CANNON.Vec3(0, bladeHeight / 2, -GAME.pusherDepth / 2));
  pusher.position.set(0, 0, GAME.pusherOriginZ);
  pusher.previousPosition.copy(pusher.position);
  world.addBody(pusher);
  const updatePusher = () => {
    const m = pusherMotionAt(world.stepnumber, STEP);
    pusher.position.z = m.positionZ;
    pusher.velocity.set(0, 0, m.velocityZ);
    pusher.aabbNeedsUpdate = true;
  };
  updatePusher();
  world.addEventListener('postStep', updatePusher);

  const makeCoin = () => {
    const b = new CANNON.Body({
      mass: COIN_MASS, material: coinMat, allowSleep: true,
      sleepSpeedLimit: 0.18, sleepTimeLimit: 0.45,
    });
    b.addShape(new CANNON.Cylinder(COIN_RADIUS, COIN_RADIUS, COIN_HEIGHT, Number(process.env.SEGMENTS) || COIN_SEGMENTS));
    b.linearDamping = COIN_LINEAR_DAMPING;
    b.angularDamping = COIN_ANGULAR_DAMPING;
    return b;
  };
  return { world, pusher, makeCoin, updatePusher };
}

// Same launch the game uses: coin leaves the rail inner end at railY-ish, on edge, moving in X.
export function dropCoin(world, makeCoin, side, power) {
  const speed = GAME.railSpeedMin + (GAME.railSpeedMax - GAME.railSpeedMin) * power;
  const b = makeCoin();
  const y = GAME.railY + COIN_RADIUS;
  b.position.set(side * GAME.railExitX, y, GAME.dropZoneZ);
  b.previousPosition.copy(b.position);
  b.velocity.set(-side * speed, -speed * RAIL_SLOPE, 0);
  b.angularVelocity.set(0, 0, (side * speed) / COIN_RADIUS);
  const q = new CANNON.Quaternion();
  q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
  b.quaternion.copy(q);
  world.addBody(b);
  return b;
}

export function run({ seconds = 90, seed = 777, seedCount = 108, drops = true, log = () => {} } = {}) {
  const { world, pusher, makeCoin } = build();
  // seed at full retreat, like the game
  const perStroke = Math.round((2 * Math.PI / GAME.pusherSpeed) / STEP);
  const atRetreat = Math.round((Math.PI / 2 / GAME.pusherSpeed) / STEP);
  const wait = ((atRetreat - world.stepnumber) % perStroke + perStroke) % perStroke;
  for (let i = 0; i < wait; i += 1) world.step(STEP);

  const coins = [];
  for (let i = 0; i < seedCount; i += 1) {
    const p = seedPosition(i, seed, COIN_HEIGHT, pusher.position.z);
    const b = makeCoin();
    b.position.set(p.x, p.y, p.z);
    b.previousPosition.copy(b.position);
    world.addBody(b);
    coins.push(b);
  }
  const settleIters = world.solver.iterations;
  world.solver.iterations = 14;
  for (let i = 0; i < Math.round(2.6 / STEP); i += 1) world.step(STEP);
  world.solver.iterations = settleIters;

  let rng = seed;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    return rng / 2147483648;
  };

  const totalSteps = Math.round(seconds / STEP);
  const dropEvery = Math.round(GAME.autoInterval / STEP);
  let payouts = 0;
  for (let i = 0; i < totalSteps; i += 1) {
    world.step(STEP);
    if (drops && i % dropEvery === 0) {
      const b = dropCoin(world, makeCoin, rand() < 0.5 ? -1 : 1, rand());
      coins.push(b);
    }
    // recycle coins that fell off the front
    for (let c = coins.length - 1; c >= 0; c -= 1) {
      const b = coins[c];
      if (b.position.y < GAME.lostY || b.position.y < GAME.trayY) {
        payouts += 1;
        world.removeBody(b);
        coins.splice(c, 1);
      }
    }
  }

  // Z census
  const buckets = { front: 0, underTray: 0, onTray: 0, behindScraper: 0, other: 0 };
  const behind = [];
  for (const b of coins) {
    const z = b.position.z;
    const y = b.position.y;
    if (z > GAME.scraperZ) { buckets.behindScraper += 1; behind.push(b); }
    else if (y > 0.66) buckets.onTray += 1;
    else if (z > GAME.pusherOriginZ - GAME.pusherDepth / 2) buckets.underTray += 1;
    else buckets.front += 1;
  }
  return { coins, buckets, payouts, behind };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const seed of [111, 777, 4242]) {
    const r = run({ seed, seconds: Number(process.argv[2] ?? 90) });
    console.log(
      `seed ${seed}`,
      'live:', String(r.coins.length).padStart(4),
      'payout:', String(r.payouts).padStart(4),
      JSON.stringify(r.buckets),
      'behindZ:', r.behind.map((b) => b.position.z.toFixed(2)).join(','),
    );
  }
}
