// The physics engine, behind the handful of calls the machine actually makes. Rapier (WASM) does
// the work: a 3-4 layer pile of 150-480 coins costs it 17-99 ms per game second where cannon-es
// needed 900-2900 - piles that never sleep were cannon's wall. Nothing outside this file imports
// the engine, so the game and its tests speak in boxes, coins, poses and velocities.
// The SIMD build steps the pile about twice as fast (0.69 vs 1.35 ms at ~250 coins) - on a phone
// that is the difference between 200 coins and 300. Safari has WASM SIMD from 16.4; anything
// older falls back to the plain build.
let RAPIER = null;
let ready = null;
/** Which Rapier build loaded - 'simd' or 'plain' - for the dev overlay. */
export let physicsBuild = null;

/** Loads the engine's WASM once. Everything else here needs it resolved first. */
export function initPhysics() {
  ready ??= (async () => {
    try {
      RAPIER = (await import('@dimforge/rapier3d-simd-compat')).default;
      await RAPIER.init();
      physicsBuild = 'simd';
    } catch {
      RAPIER = (await import('@dimforge/rapier3d-compat')).default;
      await RAPIER.init();
      physicsBuild = 'plain';
    }
  })();
  return ready;
}

/**
 * Per-collider friction for each material, so that Rapier's `Multiply` combine reproduces the
 * machine's six friction pairs exactly: coin x ground = ground, coin x coin = coin, coin x pusher
 * = pusher, and the chest's three pairs are the coin's times chestScale.
 */
export function frictionFor(material, { groundFriction, coinFriction, pusherFriction, lowerCoinFriction }, chestScale) {
  const root = Math.sqrt(Math.max(coinFriction, 1e-6));
  if (material === 'coin') return root;
  // A coin that has reached the lower bed: lowerCoin x lowerCoin = lowerCoinFriction, and against
  // the ground it grips by the same extra factor.
  if (material === 'lowerCoin') return Math.sqrt(Math.max(lowerCoinFriction ?? coinFriction, 1e-6));
  if (material === 'ground') return groundFriction / root;
  if (material === 'pusher') return pusherFriction / root;
  if (material === 'chest') return chestScale * root;
  throw new Error(`unknown material ${material}`);
}

const copy3 = (to, { x, y, z }) => { to.x = x; to.y = y; to.z = z; return to; };
const copy4 = (to, { x, y, z, w }) => { to.x = x; to.y = y; to.z = z; to.w = w; return to; };

/**
 * One rigid body. Reads come from the pose as of the last fixed step (`position`, `quaternion`)
 * or blended between the last two (`lerpPose`); writes go through the setters, which also reset
 * the blend so a teleport never smears across a frame.
 */
// Rapier collision groups, membership in the high 16 bits and filter in the low 16. Everything
// defaults to all bits; CHEST_ONLY colliders filter on a bit coins are not members of, so only the
// chest - a default body - ever touches them.
const CHEST_ONLY_BIT = 0x0002;
const COIN_GROUPS = (((0xffff & ~CHEST_ONLY_BIT) << 16) | 0xffff) >>> 0;
export const CHEST_ONLY_GROUPS = ((CHEST_ONLY_BIT << 16) | CHEST_ONLY_BIT) >>> 0;

export class PhysicsBody {
  constructor(world, rigidBody, collider, { material, role = null }) {
    this.world = world;
    this.rb = rigidBody;
    this.collider = collider;
    this.material = material;
    this.role = role;
    this.position = copy3({}, rigidBody.translation());
    this.quaternion = copy4({}, rigidBody.rotation());
    this.previousPosition = { ...this.position };
    this.previousQuaternion = { ...this.quaternion };
  }

  get enabled() { return this.rb.isEnabled(); }
  get sleeping() { return this.rb.isSleeping(); }
  get velocity() { return this.rb.linvel(); }
  get angularVelocity() { return this.rb.angvel(); }

  setPose(position, quaternion = this.quaternion) {
    this.rb.setTranslation(position, true);
    this.rb.setRotation(quaternion, true);
    copy3(this.position, position);
    copy4(this.quaternion, quaternion);
    copy3(this.previousPosition, position);
    copy4(this.previousQuaternion, quaternion);
  }

  setVelocity(velocity) { this.rb.setLinvel(velocity, true); }
  setAngularVelocity(velocity) { this.rb.setAngvel(velocity, true); }
  wakeUp() { this.rb.wakeUp(); }

  /** Takes the body out of the simulation (pooled) or puts it back, at rest. */
  setEnabled(enabled) {
    this.rb.setLinvel({ x: 0, y: 0, z: 0 }, false);
    this.rb.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.rb.setEnabled(enabled);
    if (enabled) this.rb.wakeUp();
  }

  setDamping(linear, angular) {
    this.rb.setLinearDamping(linear);
    this.rb.setAngularDamping(angular);
  }

  setMass(mass) { this.collider.setMass(mass); }

  /** Writes the pose blended `alpha` of the way from the previous step to the latest. */
  lerpPose(alpha, outPosition, outQuaternion) {
    const p = this.previousPosition;
    const q = this.position;
    outPosition.set(p.x + (q.x - p.x) * alpha, p.y + (q.y - p.y) * alpha, p.z + (q.z - p.z) * alpha);
    if (!outQuaternion) return;
    const a = this.previousQuaternion;
    let b = this.quaternion;
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    // Shortest way round: q and -q are the same rotation.
    if (dot < 0) { b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; dot = -dot; }
    let wa = 1 - alpha;
    let wb = alpha;
    if (dot < 0.9995) {
      const theta = Math.acos(dot);
      const sin = Math.sin(theta);
      wa = Math.sin((1 - alpha) * theta) / sin;
      wb = Math.sin(alpha * theta) / sin;
    }
    outQuaternion.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb, a.w * wa + b.w * wb).normalize();
  }

  // Called by the world after each fixed step.
  capture() {
    copy3(this.previousPosition, this.position);
    copy4(this.previousQuaternion, this.quaternion);
    if (!this.rb.isEnabled()) return;
    copy3(this.position, this.rb.translation());
    copy4(this.quaternion, this.rb.rotation());
  }
}

/**
 * A fixed-step world. `step(frameSeconds)` runs as many fixed steps as the frame owes (capped)
 * and returns how far the remainder is into the next one, for rendering between poses.
 */
export class PhysicsWorld {
  constructor({ gravity, fixedStep, maxSubSteps = 3, iterations = 4, tuning, chestScale = 1, contactFrequency = 10 }) {
    this.world = new RAPIER.World(gravity);
    this.world.timestep = fixedStep;
    this.world.integrationParameters.numSolverIterations = iterations;
    // Softer contacts than Rapier's default 30: coins riding the accelerating tray never settle
    // against each other at 30 and visibly shook - ~21 degrees a second each, 1.8 a frame on the
    // tray's front row. 10 takes that to 0.6 a second. The cost is that a contact under load sinks
    // ~0.013, which COIN_COLLIDER_PAD (physics.js) hides by making the collider that much thicker.
    this.world.integrationParameters.contact_natural_frequency = contactFrequency;
    this.fixedStep = fixedStep;
    this.maxSubSteps = maxSubSteps;
    this.accumulator = 0;
    this.stepNumber = 0;
    this.alpha = 0;
    this.tuning = { ...tuning };
    this.chestScale = chestScale;
    this.bodies = new Set();
    this.byCollider = new Map();
    this.events = new RAPIER.EventQueue(true);
    // Run before every fixed step (the pusher's target) and after it (wall stops, landings).
    this.beforeStep = [];
    this.afterStep = [];
    // Called with (body, otherBody) when a body made with events starts touching another; a
    // body's own `onContact(other)` hears the same.
    this.onContact = null;
  }

  free() {
    this.events.free();
    this.world.free();
  }

  #add(desc, colliderDesc, options) {
    const rb = this.world.createRigidBody(desc);
    colliderDesc
      .setFriction(frictionFor(options.material, this.tuning, this.chestScale))
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      .setRestitution(0)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
    if (options.role || options.events) colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (options.groups !== undefined) colliderDesc.setCollisionGroups(options.groups);
    const collider = this.world.createCollider(colliderDesc, rb);
    const body = new PhysicsBody(this, rb, collider, options);
    this.bodies.add(body);
    this.byCollider.set(collider.handle, body);
    return body;
  }

  /** A fixed box, `role` tagging it for contact callbacks. */
  addStaticBox(halfExtents, position, { material = 'ground', role = null, groups } = {}) {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    return this.#add(desc, RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z), { material, role, groups });
  }

  /** A kinematic body of several boxes, each `{ halfExtents, offset }` in body space. */
  addKinematicBoxes(boxes, position, { material = 'pusher' } = {}) {
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z);
    const [first, ...rest] = boxes;
    const shape = ({ halfExtents: h, offset: o }) => RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(o.x, o.y, o.z);
    const body = this.#add(desc, shape(first), { material });
    body.colliders = [body.collider];
    for (const box of rest) {
      const collider = this.world.createCollider(
        shape(box)
          .setFriction(frictionFor(material, this.tuning, this.chestScale))
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setRestitution(0),
        body.rb,
      );
      body.colliders.push(collider);
      this.byCollider.set(collider.handle, body);
    }
    return body;
  }

  /** A coin: a flat cylinder, Y up, starting disabled until something releases it. */
  addCoin({ radius, thickness, mass, linearDamping, angularDamping, events = false }) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      .setEnabled(false);
    const body = this.#add(desc, RAPIER.ColliderDesc.cylinder(thickness / 2, radius).setMass(mass), { material: 'coin', events, groups: COIN_GROUPS });
    body.radius = radius;
    return body;
  }

  /** Swaps a coin's cylinder for one of a new thickness, keeping everything else. */
  resizeCoin(body, radius, thickness) {
    body.collider.setHalfHeight(thickness / 2);
    body.collider.setRadius(radius);
  }

  addDynamicBox(halfExtents, { mass, linearDamping, angularDamping, material = 'chest' }) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      .setEnabled(false);
    return this.#add(desc, RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setMass(mass), { material, events: true });
  }

  setGravity(gravity) { this.world.gravity = gravity; }
  setIterations(iterations) { this.world.integrationParameters.numSolverIterations = iterations; }

  /** Swaps one body's material - and so its friction - without touching the rest of the world. */
  setMaterial(body, material) {
    if (body.material === material) return;
    body.material = material;
    const friction = frictionFor(material, this.tuning, this.chestScale);
    for (const collider of body.colliders ?? [body.collider]) collider.setFriction(friction);
  }

  /** Re-derives every collider's friction from new tuning. */
  setFriction(tuning) {
    Object.assign(this.tuning, tuning);
    for (const body of this.bodies) {
      const friction = frictionFor(body.material, this.tuning, this.chestScale);
      for (const collider of body.colliders ?? [body.collider]) collider.setFriction(friction);
    }
  }

  /** Runs one fixed step, hooks and contact callbacks included. */
  stepOnce() {
    for (const hook of this.beforeStep) hook(this.stepNumber + 1);
    this.world.step(this.events);
    this.stepNumber += 1;
    for (const body of this.bodies) body.capture();
    this.events.drainCollisionEvents((a, b, started) => {
      if (!started) return;
      const first = this.byCollider.get(a);
      const second = this.byCollider.get(b);
      if (!first || !second) return;
      first.onContact?.(second);
      second.onContact?.(first);
      this.onContact?.(first, second);
    });
    for (const hook of this.afterStep) hook(this.stepNumber);
  }

  /**
   * Advances by a frame's worth of time. Owed steps past maxSubSteps are dropped rather than
   * chased - a stall must not snowball into a spiral of ever longer frames.
   */
  step(frameSeconds) {
    this.accumulator += frameSeconds;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this.stepOnce();
      this.accumulator -= this.fixedStep;
      steps += 1;
    }
    // Backlog past the cap is dropped, not chased; how much, so the caller's clock can drop it too.
    const kept = steps === this.maxSubSteps ? Math.min(this.accumulator, this.fixedStep) : this.accumulator;
    this.droppedSeconds = this.accumulator - kept;
    this.accumulator = kept;
    this.lastSteps = steps;
    this.alpha = this.accumulator / this.fixedStep;
    return this.alpha;
  }
}
