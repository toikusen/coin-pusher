import * as THREE from 'three';
import { GAME } from './config.js';
import { lowerBladeReachZ, pusherMotionAt } from './physics.js';
import { SILL_GROUPS } from './world.js';
import {
  BUMPER_COOLDOWN,
  BUMPER_PEARLS,
  burstDelay,
  fusionPairs,
  fusionPull,
  gateHeightFor,
  PEARL_LEVELS,
  STORE_CAPACITY,
  TOP_LEVEL,
  chestNudge,
  dropStats,
  GATE_HALF_DEPTH,
  GATE_HEIGHT,
  GATE_OPEN_SECONDS,
  gateClosesNow,
  gateLiftStep,
  MAX_PEARLS,
  PEARL_SEED_COUNT,
  PEARL_ANGULAR_DAMPING,
  PEARL_LINEAR_DAMPING,
  PEARL_MASS,
  PEARL_MODES,
  PEARL_RADIUS,
  PEARL_SPAWN_HALF_WIDTH,
  PEARL_SPAWN_Y,
  pearlDropZ,
  pearlOnTray,
  pearlPhase,
  pearlSchedule,
  pearlSidePosition,
  pearlSideVelocity,
  pearlStrokeZ,
  pourSide,
  crossSteer,
  POUR_SPACING,
  pearlTurnAt,
  pearlSeedPosition,
  pourX,
  RAIN_BUMPER,
  seededRandom,
  SILL_HALF_DEPTH,
  SILL_HEIGHT,
  sillZ,
} from './pearls.js';

const RECYCLE_DELAY = 0.38;
const TRAY_TOP = GAME.upperTrayY + GAME.upperTrayHeight / 2;
const GATE_WIDTH = GAME.playfieldHalfWidth * 2 - 0.15;
const PEARL_GOLD = new THREE.Color(0xff9a10);
const MAX_ORBITS = 60;

// A pearl's surface: a few bright motes on a pale ground, so a pile reads as star matter.
let starMap = null;
function starTexture() {
  if (starMap) return starMap;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = '#d9e2ff';
  context.fillRect(0, 0, 256, 128);
  for (let index = 0; index < 46; index += 1) {
    const size = 1 + Math.random() * 2.4;
    context.fillStyle = index % 5 === 0 ? '#ffe9a3' : '#ffffff';
    context.beginPath();
    context.arc(Math.random() * 256, Math.random() * 128, size, 0, Math.PI * 2);
    context.fill();
  }
  starMap = new THREE.CanvasTexture(canvas);
  starMap.colorSpace = THREE.SRGBColorSpace;
  return starMap;
}

/**
 * The machine's pearls: a fixed pool of physics balls drawn as one instanced mesh, plus the rain
 * queue feeding them. On the pearl machine they stand in for coins, and a pearl carries the same
 * fields a coin does so the pin board and the chest prizes take either. On the coin machine they
 * only appear when the lab starts a rain or turns bumper pearls on.
 */
export class PearlRain {
  constructor(game) {
    this.game = game;
    this.mode = 'A';
    this.bumperRain = false;
    this.random = Math.random;
    this.queue = [];
    this.exits = [];
    this.active = [];
    // On the pin board, posed by CoinPusher's playback until adopt() hands them to physics.
    this.flying = new Set();
    this.rainAt = null;
    this.announced = true;
    this.coinsPaid = 0;
    this.smallAt = -Infinity;
    this.storedAtOpen = 0;
    this.released = 0;
    this.feedEvery = 0;
    this.feedAt = 0;
    this.releaseCount = 0;
    this.releaseExits = 0;
    this.gateOpenedAt = 0;
    this.latencies = [];
    this.pool = Array.from({ length: MAX_PEARLS }, () => ({
      isPearl: true,
      isPremium: false,
      level: 0,
      value: undefined,
      body: game.world.addPearl({
        radius: PEARL_RADIUS,
        mass: PEARL_MASS,
        linearDamping: PEARL_LINEAR_DAMPING,
        angularDamping: PEARL_ANGULAR_DAMPING,
      }),
      mesh: new THREE.Object3D(),
      counted: false,
      falling: false,
      recycleAt: Infinity,
      strandedFor: 0,
    }));
    this.levelColors = PEARL_LEVELS.map(({ color }) => new THREE.Color(color));
    this.storedNow = 0;
    this.mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(PEARL_RADIUS, 20, 14),
      // The environment map and a little self-glow, not just lights: the winter skin turns the
      // scene's lights off, and a lit-only pearl goes black there.
      new THREE.MeshStandardMaterial({
        map: starTexture(),
        color: 0xffffff,
        metalness: 0.15,
        roughness: 0.18,
        envMap: game.environmentTexture,
        envMapIntensity: 1.4,
        emissive: 0xdfe6ff,
        emissiveIntensity: 0.16,
        emissiveMap: starTexture(),
      }),
      MAX_PEARLS,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = game.quality.shadows;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    game.scene.add(this.mesh);
    this.buildOrbits();
    this.sillBody = game.world.addStaticBox(
      { x: GAME.playfieldHalfWidth + 0.2, y: SILL_HEIGHT / 2, z: SILL_HALF_DEPTH },
      { x: 0, y: SILL_HEIGHT / 2, z: sillZ() },
      { groups: SILL_GROUPS },
    );
    this.sillMesh = new THREE.Mesh(
      new THREE.BoxGeometry(GAME.playfieldHalfWidth * 2, SILL_HEIGHT, SILL_HALF_DEPTH * 2),
      new THREE.MeshStandardMaterial({ color: 0xffe9a3, emissive: 0xa67b31, emissiveIntensity: 0.6 }),
    );
    this.sillMesh.position.set(0, SILL_HEIGHT / 2, sillZ());
    game.scene.add(this.sillMesh);
    this.buildGate();
    this.setSill(game.pure);
  }

  // A plate standing in the tray's front edge. It rides the tray, and rises out of it to hold pearls
  // back: opening is sinking it flush, so the pearls behind it pour off the front.
  buildGate() {
    const { game } = this;
    this.gateHeight = GATE_HEIGHT;
    this.gateOpenSeconds = GATE_OPEN_SECONDS;
    this.gateLift = GATE_HEIGHT;
    this.gateOpenUntil = null;
    this.gateFront = -GAME.pusherDepth / 2 + GATE_HALF_DEPTH;
    const step = game.quality.physicsStep;
    this.trayZ = pusherMotionAt(game.world.stepNumber, step).positionZ;
    this.gateBody = game.world.addKinematicBoxes([{
      halfExtents: { x: GATE_WIDTH / 2, y: GAME.upperTrayHeight / 2, z: GATE_HALF_DEPTH },
      offset: { x: 0, y: TRAY_TOP - GAME.upperTrayHeight / 2, z: this.gateFront },
    }], { x: 0, y: GATE_HEIGHT, z: this.trayZ }, { groups: SILL_GROUPS });
    game.world.beforeStep.push((stepNumber) => {
      const target = this.gateOpenUntil === null ? gateHeightFor(this.gateHeight, this.storedNow) : 0;
      this.gateLift = gateLiftStep(this.gateLift, target, step);
      this.gateBody.rb.setNextKinematicTranslation({
        x: 0, y: this.gateLift, z: this.trayZ,
      });
    });
    this.gateMesh = new THREE.Mesh(
      new THREE.BoxGeometry(GATE_WIDTH, GAME.upperTrayHeight, GATE_HALF_DEPTH * 2),
      new THREE.MeshStandardMaterial({ color: 0xffe9a3, emissive: 0xf2c94c, emissiveIntensity: 0.5 }),
    );
    game.scene.add(this.gateMesh);
    this.gatePose = new THREE.Vector3();
  }

  /**
   * The tray's position for this physics step, called by its driver in CoinPusher, which runs
   * before the gate's hook. On the coin machine it is simply the stroke.
   */
  stepTray(stepNumber) {
    const { game } = this;
    const stepSeconds = game.quality.physicsStep;
    this.trayZ = game.pure
      ? pearlStrokeZ(stepNumber, stepSeconds).trayZ
      : pusherMotionAt(stepNumber, stepSeconds).positionZ;
    return this.trayZ;
  }

  setSill(on) {
    this.sillBody.setEnabled(on);
    this.sillMesh.visible = on;
    // ponytail: the gate is parked with the pinball build, off in every mode. Delete both together
    // if that design never comes back.
    this.gateBody.setEnabled(false);
    this.gateMesh.visible = false;
  }

  get gateOpen() {
    return this.gateOpenUntil !== null;
  }

  /** Pearls waiting on the tray: the player's store. */
  get stored() {
    return this.active.filter(({ counted, body }) => !counted && pearlOnTray(body.position)).length;
  }

  /** The player's release: the gate drops for a while, and the readout restarts from here. */
  openGate() {
    if (!this.game.pure || this.gateOpen || !this.gateBody.enabled) return false;
    this.gateOpenedAt = this.game.elapsed;
    this.gateOpenUntil = Infinity;
    this.releaseCount += 1;
    for (const pearl of this.active) if (pearlOnTray(pearl.body.position)) pearl.releaseId = this.releaseCount;
    this.releaseExits = 0;
    this.exits = [];
    this.coinsPaid = 0;
    this.rainAt = this.game.elapsed;
    this.storedAtOpen = this.stored;
    this.released = 0;
    const { game } = this;
    game.callbacks.onPearlRain?.();
    // The release as a machine event: the fence lamps race and sparks run along the gate.
    game.lampRaceAt = game.elapsed;
    for (let x = -3; x <= 3; x += 1.5) game.emitParticles(x, TRAY_TOP + 0.3, this.trayZ + this.gateFront, 10, true);
    return true;
  }

  buildOrbits() {
    const { game } = this;
    // Star cores tell apart by shape too: one orbit ring per level, not colour alone.
    this.orbits = new THREE.InstancedMesh(
      new THREE.TorusGeometry(1.45, 0.07, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      MAX_ORBITS,
    );
    this.orbits.count = 0;
    this.orbits.frustumCulled = false;
    game.scene.add(this.orbits);
    this.orbitPose = new THREE.Object3D();
  }

  /** Everything of ours in the scene: a skin that hides the rest has to keep these. */
  get drawn() {
    return [this.mesh, this.orbits, this.sillMesh, this.gateMesh];
  }

  /** Starts the selected mode; a rain still pouring refuses a new one. */
  start(key = this.mode) {
    if (this.queue.length > 0) return false;
    const mode = PEARL_MODES[key];
    const { elapsed } = this.game;
    this.exits = [];
    this.coinsPaid = 0;
    this.rainAt = elapsed + burstDelay(mode);
    this.announced = false;
    this.queue = pearlSchedule(mode, elapsed);
    return true;
  }

  /** A bumper was struck, while bumper pearls are on: the centre rains, the others drip. */
  bumperHit(index) {
    if (!this.bumperRain) return;
    if (index === RAIN_BUMPER) {
      this.start();
      return;
    }
    const { elapsed } = this.game;
    if (elapsed - this.smallAt < BUMPER_COOLDOWN) return;
    this.smallAt = elapsed;
    const drip = Array.from({ length: BUMPER_PEARLS }, (_, index) => ({ at: elapsed + index * 0.15, zone: 'rear' }));
    this.queue = [...this.queue, ...drip].sort((first, second) => first.at - second.at);
  }

  noteCoins(count) {
    if (this.rainAt !== null && this.game.elapsed >= this.rainAt) this.coinsPaid += count;
  }

  /** A ball off the pin board that goes no further: its slot took it. */
  finishFlying(pearl) {
    this.flying.delete(pearl);
    this.release(pearl);
  }

  /** A pearl for the pin board, or undefined with the pool empty. CoinPusher releases it. */
  acquire() {
    const pearl = this.pool.pop();
    if (!pearl) return undefined;
    pearl.counted = false;
    pearl.falling = false;
    pearl.recycleAt = Infinity;
    pearl.strandedFor = 0;
    pearl.cross = {};
    pearl.releaseId = 0;
    pearl.hitAt = null;
    pearl.isPremium = false;
    this.setLevel(pearl, 0);
    this.flying.add(pearl);
    return pearl;
  }

  setLevel(pearl, level) {
    const { radius, value } = PEARL_LEVELS[level];
    pearl.level = level;
    pearl.value = value ?? undefined;
    pearl.mesh.scale.setScalar(radius / PEARL_RADIUS);
    this.game.world.resizePearl(pearl.body, radius);
  }

  /** A slot's pearls, in at the tray's ends under the board at once, in a stream across it. */
  pour(count, side, level = 0) {
    const { elapsed } = this.game;
    const batch = Array.from({ length: count }, (_, index) => ({
      at: elapsed + index * (side ? POUR_SPACING : POUR_SPACING / 2), zone: 'side', side: pourSide(side, index), hitAt: elapsed, level,
    }));
    this.queue = [...this.queue, ...batch].sort((first, second) => first.at - second.at);
  }

  /** A prize's worth of pearls into the store, a few a second rather than in one heap. */
  mintMany(count) {
    const { elapsed } = this.game;
    const batch = Array.from({ length: count }, (_, index) => ({ at: elapsed + index * 0.08, zone: 'store' }));
    this.queue = [...this.queue, ...batch].sort((first, second) => first.at - second.at);
  }

  /** A pearl into the store from the board above: what a board hit earns. Refused at a full pool. */
  mint(level, side = 0) {
    const pearl = this.place({
      x: pourX(side, this.random),
      y: GAME.upperTrayY + 1,
      z: GAME.dropZoneZ - 0.2,
    });
    if (!pearl) return null;
    if (level > 0) {
      this.setLevel(pearl, level);
      pearl.isPremium = false;
    }
    this.game.callbacks.onPearlMint?.();
    return pearl;
  }

  /** The pin board's exit: from here on physics moves it. */
  adopt(pearl) {
    this.flying.delete(pearl);
    this.active.push(pearl);
  }

  place(position) {
    const pearl = this.acquire();
    if (!pearl) return null;
    pearl.body.setEnabled(true);
    pearl.body.setPose(position);
    pearl.body.setVelocity({ x: 0, y: -1, z: 0 });
    pearl.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
    pearl.mesh.position.copy(pearl.body.position);
    this.adopt(pearl);
    return pearl;
  }

  spawn({ zone, side = 0, hitAt = null, level = 0 }) {
    const pearl = this.spawnAt(zone, side);
    if (!pearl) return;
    pearl.hitAt = hitAt;
    if (level > 0) this.setLevel(pearl, level);
  }

  spawnAt(zone, side) {
    const bladeZ = this.game.bladeBody.position.z;
    if (zone === 'store') return this.mint(0, side);
    if (zone === 'side') {
      const pearl = this.place(pearlSidePosition(side));
      if (!pearl) return null;
      pearl.body.setVelocity(pearlSideVelocity(side, this.random));
      pearl.cross = { side, turnAt: pearlTurnAt(this.random) };
      return pearl;
    }
    return this.place({
      x: (this.random() * 2 - 1) * PEARL_SPAWN_HALF_WIDTH,
      y: PEARL_SPAWN_Y,
      z: pearlDropZ(zone, bladeZ, this.random),
    });
  }

  /** The pearl machine's starting pile. settlePile() does the rest, as for coins. */
  seed() {
    for (let index = 0; index < PEARL_SEED_COUNT; index += 1) {
      this.place(pearlSeedPosition(index, this.random, this.trayZ - GAME.pusherDepth / 2));
    }
  }

  /** A pearl the settling pile shoved over the lip never happened: back to the pool, unpaid. */
  settled() {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const pearl = this.active[index];
      if (pearlPhase(pearl.body.position) || pearl.body.position.z < GAME.playfieldFrontZ) this.recycle(index);
    }
  }

  recycle(index) {
    const [pearl] = this.active.splice(index, 1);
    this.release(pearl);
  }

  release(pearl) {
    pearl.body.setEnabled(false);
    this.pool.push(pearl);
  }

  update(delta) {
    const { game } = this;
    const { elapsed } = game;
    // Open until the store has run out, not for a set time: a fixed 3 s let out about half of it.
    if (this.gateOpen && gateClosesNow(elapsed - this.gateOpenedAt, this.gateOpenSeconds, this.storedNow)) {
      this.gateOpenUntil = null;
    }
    if (this.feedEvery > 0 && elapsed >= this.feedAt) {
      this.feedAt = elapsed + this.feedEvery;
      game.drop();
    }
    while (this.queue.length > 0 && this.queue[0].at <= elapsed) this.spawn(this.queue.shift());
    if (!this.announced && elapsed >= this.rainAt) {
      this.announced = true;
      game.callbacks.onPearlRain?.();
    }
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const pearl = this.active[index];
      pearl.body.lerpPose(game.world.alpha, pearl.mesh.position);
      if (pearl.recycleAt <= elapsed) {
        this.recycle(index);
        continue;
      }
      if (pearl.counted) continue;
      if (game.pure) {
        const steered = crossSteer(pearl.body.position, pearl.body.velocity, pearl.cross, this.trayZ - GAME.pusherDepth / 2);
        if (steered) pearl.body.setVelocity(steered);
      }
      const phase = pearlPhase(pearl.body.position);
      if (phase === 'fall') {
        pearl.counted = true;
        pearl.recycleAt = elapsed + RECYCLE_DELAY;
        this.exits.push(elapsed);
        if (pearl.hitAt !== null) this.latencies.push(elapsed - pearl.hitAt);
        if (pearl.releaseId === this.releaseCount && pearl.releaseId > 0) this.releaseExits += 1;
        game.pearlOut(pearl);
      } else if (phase === 'lost') {
        this.recycle(index);
      } else if (game.strandedUnderTray(pearl, delta)) {
        // Behind the blade nothing can reach it. Back out in front, out of sight under the tray,
        // rather than lost: a B-mode tray leaves a pearl there now and then, and pearls are score.
        pearl.strandedFor = 0;
        pearl.body.setPose({
          x: pearl.body.position.x,
          y: 0.5,
          z: pearlDropZ('rear', game.bladeBody.position.z, this.random),
        });
      }
    }
    this.storedNow = this.stored;
    if (game.pure) {
      this.fuse(delta);
      for (const { body } of game.chests) {
        const velocity = chestNudge(body.position, body.velocity);
        if (velocity) body.setVelocity(velocity);
      }
    }
    this.draw();
  }

  // Like special pearls on the bed drift together and fuse. The tray is left out: what is in the
  // store is the player's to release.
  fuse(delta) {
    const { game } = this;
    const specials = this.active.filter(({ level, counted, body }) => level > 0 && level < TOP_LEVEL
      && !counted && !pearlOnTray(body.position));
    for (const pearl of specials) {
      const pull = fusionPull(pearl, specials);
      if (!pull) continue;
      const velocity = pearl.body.velocity;
      pearl.body.setVelocity({ x: velocity.x + pull.x * delta, y: velocity.y, z: velocity.z + pull.z * delta });
    }
    for (const [keep, gone] of fusionPairs(specials)) {
      const { x, y, z } = keep.body.position;
      game.emitParticles(x, y + 0.2, z, 18, true);
      this.setLevel(keep, keep.level + 1);
      this.recycle(this.active.indexOf(gone));
      game.callbacks.onPearlFusion?.(keep.level);
    }
  }

  draw() {
    let count = 0;
    let orbits = 0;
    const put = ({ mesh, isPremium, level }) => {
      for (let ring = 0; ring < level && orbits < MAX_ORBITS; ring += 1) {
        const pose = this.orbitPose;
        pose.position.copy(mesh.position);
        pose.rotation.set(1.2 + ring, this.game.elapsed * 1.5 + (ring * Math.PI) / 3, 0);
        pose.scale.setScalar(PEARL_LEVELS[level].radius);
        pose.updateMatrix();
        this.orbits.setMatrixAt(orbits, pose.matrix);
        this.orbits.setColorAt(orbits, this.levelColors[level]);
        orbits += 1;
      }
      mesh.quaternion.identity();
      mesh.updateMatrix();
      this.mesh.setMatrixAt(count, mesh.matrix);
      this.mesh.setColorAt(count, isPremium ? PEARL_GOLD : this.levelColors[level]);
      count += 1;
    };
    this.active.forEach(put);
    this.flying.forEach(put);
    this.mesh.count = count;
    this.orbits.count = orbits;
    this.orbits.instanceMatrix.needsUpdate = true;
    if (this.orbits.instanceColor) this.orbits.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.gateBody.lerpPose(this.game.world.alpha, this.gatePose);
    this.gateMesh.position.set(0, TRAY_TOP - GAME.upperTrayHeight / 2 + this.gatePose.y, this.gatePose.z + this.gateFront);
    this.gateMesh.material.emissiveIntensity = this.gateOpen ? 2.4 : 0.5;
  }

  /** Empties the machine; with a seed, the next rain falls exactly as the last one seeded did. */
  clear(seed = null) {
    for (let index = this.active.length - 1; index >= 0; index -= 1) this.recycle(index);
    this.flying.forEach((pearl) => this.release(pearl));
    this.flying.clear();
    this.queue = [];
    this.latencies = [];
    this.exits = [];
    this.coinsPaid = 0;
    this.rainAt = null;
    this.announced = true;
    this.gateOpenUntil = null;
    this.gateLift = this.gateHeight;
    this.released = 0;
    this.storedAtOpen = 0;
    this.random = seed === null ? Math.random : seededRandom(seed);
    this.draw();
  }

  /** What the last release did: its own pearls off the lip, and everything they knocked off. */
  releaseStats() {
    return { released: this.storedAtOpen, fromStore: this.releaseExits, out: this.exits.length };
  }

  /** The lab's readout, measured from the current rain's last wave. */
  stats() {
    const stored = this.stored;
    this.released = Math.max(this.released, this.storedAtOpen - stored);
    const recent = [...this.latencies.slice(-40)].sort((first, second) => first - second);
    return {
      ...dropStats(this.exits, this.rainAt ?? Infinity),
      latency: recent.length > 0 ? recent[recent.length >> 1] : null,
      stored,
      released: this.released,
      onBed: this.active.filter(({ counted }) => !counted).length,
      coins: this.coinsPaid,
      pouring: this.queue.length > 0,
    };
  }

  dispose() {
    this.mesh.dispose();
  }
}
