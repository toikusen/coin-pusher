import * as THREE from 'three';
import { GAME } from './config.js';
import { pearlPhase, sillZ } from './pearls.js';
import {
  BALL_RADIUS, createFlippers, flipperLayout, launchBall, stepBoard,
} from './pinball.js';

export const START_LIVES = 3;
export const MAX_BALL_LEVEL = 5;
export const RESCUE_SECONDS = 10;
export const RESCUE_RADIUS = 0.3;
const RESCUE_MASS = 0.3;
// Hopped mostly sideways: the two flipper buttons steer the fallen ball along the sill to the lit
// recovery mouth. Headless, 10 runs each: a bot steering for it saved 7, one mashing at random 4,
// in 2-5 s. With no mouth, any press saved it in 2 s every time, which is no skill at all.
const RESCUE_KICK = { x: 2, y: 2.2, z: 0.6 };
export const RESCUE_MOUTH_WIDTH = 2.4;
const RESCUE_MOUTH_RANGE = 2.5;
const RESCUE_MOUTH_MIN_DISTANCE = 1.5;
const RESCUE_KICK_COOLDOWN = 0.3;
const RESCUE_START_BEHIND_SILL = 1.5;
const RETURN_SECONDS = 1.5;
const NEXT_BALL_SECONDS = 1.2;
// Parked, not dropped: the first thing to prove is that the plain loop holds up on its own.
const RESCUE_ENABLED = false;
export const BALLS_PER_GAME = START_LIVES;
const BALL_SAVE_SECONDS = 5;
// Launched down the side, past the targets. From the middle a ball can fall onto the +5 and bounce
// between it and the ceiling, earning pearls untouched. 240 bot balls from here: no input earned 0,
// mashing 9, timed flips 21.
const LAUNCH_X = 3;
const SETTLE_QUIET_SECONDS = 2.5;
const SETTLE_MAX_SECONDS = 20;
// The star board. Two easy targets and one hard one, a few posts to break up the flight, and a
// post over the drain. Hitting a target is the only way to earn a pearl, so the cause reads.
export const STAR_BOARD = Object.freeze({
  targets: Object.freeze([
    { x: -2, y: 6.4, radius: 0.35, pearls: 2 },
    { x: 2, y: 6.4, radius: 0.35, pearls: 2 },
    { x: 0, y: 7.3, radius: 0.4, pearls: 5 },
  ]),
  posts: Object.freeze([
    { x: -1.15, y: 4.8, radius: 0.2 },
    { x: 1.15, y: 4.8, radius: 0.2 },
    { x: 0, y: 5.7, radius: 0.2 },
    { x: 0, y: 2.15, radius: 0.14 },
  ]),
});
const FLIPPER_HALF_THICKNESS = 0.09;
const FLIPPER_LENGTH = 1.2;
/** The hop one rescue press gives, from which button was pressed. */
export function rescueKick(side) {
  return { x: side * RESCUE_KICK.x, y: RESCUE_KICK.y, z: -RESCUE_KICK.z };
}

/** Where the recovery mouth lights up: well away from the ball, so it has to be steered there. */
export function rescueMouthX(ballX, random = Math.random) {
  let x = (random() * 2 - 1) * RESCUE_MOUTH_RANGE;
  for (let tries = 0; tries < 16 && Math.abs(x - ballX) < RESCUE_MOUTH_MIN_DISTANCE; tries += 1) {
    x = (random() * 2 - 1) * RESCUE_MOUTH_RANGE;
  }
  return x;
}

/** Whether a ball leaving over the lip at `x` went through the mouth. */
export function inRescueMouth(x, mouthX) {
  return Math.abs(x - mouthX) <= RESCUE_MOUTH_WIDTH / 2;
}

/** Whether a drain is forgiven: straight off the launch, and only once a ball. */
export function ballSaved(aliveFor, saveUsed) {
  return aliveFor < BALL_SAVE_SECONDS && !saveUsed;
}

/** Pearls a board hit earns: targets only, a post is just a bounce. */
export function hitPearls(hit) {
  return hit.kind === 'bumper' ? STAR_BOARD.targets[hit.index].pearls : 0;
}

/** Whether the settling pile has finished: quiet for a moment, or out of patience. */
export function settleDone(sinceExit, sinceStart) {
  return sinceExit >= SETTLE_QUIET_SECONDS || sinceStart >= SETTLE_MAX_SECONDS;
}

/** Lives and ball level after a ball is lost. */
export function afterLoss(lives) {
  const left = Math.max(0, lives - 1);
  return { lives: left, ballLevel: 1, over: left === 0 };
}

/**
 * One game of three balls, one layer at a time: play the ball on the board, and when it drains,
 * release what it earned and watch that fall. Only one half of the machine ever needs the player.
 * States: off, board, release (waiting for the gate), pouring, settle, over.
 * The rescue states (rescue, return, wait) are parked behind RESCUE_ENABLED.
 */
export class AstralMode {
  constructor(game) {
    this.game = game;
    this.state = 'off';
    this.input = { left: false, right: false };
    this.lives = START_LIVES;
    this.ballLevel = 1;
    this.rescueLeft = 0;
    this.kickReady = 0;
    this.ballsLeft = BALLS_PER_GAME;
    this.launchedAt = 0;
    this.launchSide = 1;
    this.saveUsed = false;
    this.settleStart = 0;
    this.targetGlow = [0, 0, 0];
    this.waitLeft = 0;
    this.cooldowns = new Map();
    const { pinBoard } = game;
    this.layout = flipperLayout(pinBoard);
    this.board = {
      halfWidth: pinBoard.halfWidth,
      bottom: pinBoard.bottom,
      ceiling: pinBoard.top + 0.3,
      pins: STAR_BOARD.posts,
      bumpers: STAR_BOARD.targets,
      guides: this.layout.guides,
    };
    this.flippers = createFlippers(this.layout);
    this.buildMeshes();
    this.body = game.world.addPearl({
      radius: RESCUE_RADIUS, mass: RESCUE_MASS, linearDamping: 0.12, angularDamping: 0.58,
    });
  }

  buildMeshes() {
    const { game } = this;
    const brass = new THREE.MeshStandardMaterial({
      color: 0xf2c94c, metalness: 0.8, roughness: 0.3, emissive: 0xa67b31, emissiveIntensity: 0.9,
      envMap: game.environmentTexture,
    });
    this.parts = new THREE.Group();
    this.flipperMeshes = this.flippers.map(({ x, y, side }) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, GAME.dropZoneZ);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(FLIPPER_LENGTH, FLIPPER_HALF_THICKNESS * 2, 0.3), brass);
      blade.position.x = (-side * FLIPPER_LENGTH) / 2;
      pivot.add(blade);
      this.parts.add(pivot);
      return pivot;
    });
    for (const { a, b } of this.layout.guides) {
      const length = Math.hypot(a.x - b.x, a.y - b.y);
      const guide = new THREE.Mesh(new THREE.BoxGeometry(length, 0.06, 0.3), brass);
      guide.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, GAME.dropZoneZ);
      guide.rotation.z = Math.atan2(a.y - b.y, a.x - b.x);
      this.parts.add(guide);
    }
    this.targetMaterials = STAR_BOARD.targets.map(({ radius, pearls }) => this.addTarget(radius, pearls, brass));
    STAR_BOARD.targets.forEach(({ x, y }, index) => this.parts.children.at(-STAR_BOARD.targets.length + index).position.set(x, y, GAME.dropZoneZ));
    for (const { x, y, radius } of STAR_BOARD.posts) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.3, 24), brass);
      post.rotation.x = Math.PI / 2;
      post.position.set(x, y, GAME.dropZoneZ);
      this.parts.add(post);
    }
    game.boardInner.add(this.parts);
    this.hero = new THREE.Mesh(
      new THREE.SphereGeometry(1, 28, 20),
      new THREE.MeshStandardMaterial({
        color: 0x9fe8ff, emissive: 0x1e7bff, emissiveIntensity: 1.4, metalness: 0.2, roughness: 0.12,
        envMap: game.environmentTexture, envMapIntensity: 1.2,
      }),
    );
    this.hero.visible = false;
    game.scene.add(this.hero);
    this.rail = this.buildRail();
    game.scene.add(this.rail);
    this.mouth = new THREE.Mesh(
      new THREE.BoxGeometry(RESCUE_MOUTH_WIDTH, 0.12, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x1e7bff, emissiveIntensity: 2.6 }),
    );
    this.mouth.position.set(0, 0.16, sillZ());
    this.mouth.visible = false;
    game.scene.add(this.mouth);
    this.setPartsVisible(false);
  }

  // A target: a lit disc with what it pays printed on it, so the board explains itself.
  addTarget(radius, pearls, brass) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = pearls > 2 ? '#c9861a' : '#1c6fb8';
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#ffffff';
    context.font = 'bold 64px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`+${pearls}`, 64, 68);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.7 });
    const disc = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.26, 40), brass);
    rim.rotation.x = Math.PI / 2;
    const top = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.86, 40), face);
    top.position.z = -0.14;
    top.rotation.y = Math.PI;
    disc.add(rim, top);
    this.parts.add(disc);
    return face;
  }

  // The rail the rescued ball climbs: from the lip's corner up the cabinet's side to the board.
  buildRail() {
    const side = GAME.playfieldHalfWidth + 0.05;
    this.railCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side - 0.4, -0.3, GAME.playfieldFrontZ - 0.1),
      new THREE.Vector3(side, 0.5, GAME.playfieldFrontZ + 0.6),
      new THREE.Vector3(side, 2, 0.6),
      new THREE.Vector3(side - 0.3, 3.6, GAME.dropZoneZ - 0.4),
    ]);
    return new THREE.Mesh(
      new THREE.TubeGeometry(this.railCurve, 48, 0.05, 8, false),
      new THREE.MeshStandardMaterial({ color: 0xf2c94c, emissive: 0xa67b31, emissiveIntensity: 1 }),
    );
  }

  setPartsVisible(on) {
    this.parts.visible = on;
    this.rail.visible = on && RESCUE_ENABLED;
    if (!on) {
      this.hero.visible = false;
      this.mouth.visible = false;
    }
  }

  /** Everything of ours a skin must keep drawn. */
  get drawn() {
    return [this.parts, this.hero, this.rail, this.mouth];
  }

  setActive(on) {
    this.setPartsVisible(on);
    this.body.setEnabled(false);
    if (on) this.newGame();
    else this.state = 'off';
  }

  newGame() {
    this.ballsLeft = BALLS_PER_GAME;
    this.saveUsed = false;
    this.ballLevel = 1;
    this.lives = START_LIVES;
    this.notify({ type: 'lives' });
    this.launch();
  }

  launch() {
    const { game } = this;
    this.body.setEnabled(false);
    this.launchSide = -this.launchSide;
    this.ball = launchBall(this.launchSide * LAUNCH_X, this.board.ceiling - 0.5);
    this.cooldowns.clear();
    this.launchedAt = game.elapsed;
    this.state = 'board';
    this.hero.visible = true;
    this.hero.scale.setScalar(BALL_RADIUS);
  }

  notify(event) {
    this.game.callbacks.onAstral?.(event);
  }

  /** A flipper button changed. Up top it holds the flipper; a press on the bed is a rescue hop. */
  press(side, down) {
    if (side < 0) this.input.left = down;
    else this.input.right = down;
    if (!down || this.state !== 'rescue' || this.game.elapsed < this.kickReady) return;
    this.kickReady = this.game.elapsed + RESCUE_KICK_COOLDOWN;
    const kick = rescueKick(side);
    const velocity = this.body.velocity;
    this.body.setVelocity({ x: velocity.x + kick.x, y: Math.max(velocity.y, 0) + kick.y, z: velocity.z + kick.z });
    this.notify({ type: 'kick' });
  }

  // The ball is gone. A ball lost straight off the launch is handed back; otherwise the game turns
  // to the store, and the board waits.
  endBall() {
    const { game } = this;
    if (ballSaved(game.elapsed - this.launchedAt, this.saveUsed)) {
      this.saveUsed = true;
      this.notify({ type: 'saved' });
      this.launch();
      return;
    }
    this.saveUsed = false;
    this.hero.visible = false;
    this.ballsLeft -= 1;
    this.lives = this.ballsLeft;
    if (game.pearls.storedNow > 0) {
      this.state = 'release';
      this.notify({ type: 'ballEnd', stored: game.pearls.storedNow, ball: BALLS_PER_GAME - this.ballsLeft });
    } else {
      this.nextBall();
    }
  }

  /** The player's gate press. Only a finished ball has anything to release. */
  release() {
    if (this.state !== 'release' || !this.game.pearls.openGate()) return false;
    this.state = 'pouring';
    this.notify({ type: 'release' });
    return true;
  }

  nextBall() {
    if (this.ballsLeft > 0) {
      this.launch();
      return;
    }
    this.state = 'over';
    this.notify({ type: 'over' });
  }

  drain() {
    if (!RESCUE_ENABLED) {
      this.endBall();
      return;
    }
    this.state = 'rescue';
    this.rescueLeft = RESCUE_SECONDS;
    this.kickReady = 0;
    const x = THREE.MathUtils.clamp(this.ball.x, -2.5, 2.5);
    this.body.setEnabled(true);
    this.body.setPose({ x, y: 1.1, z: sillZ() + RESCUE_START_BEHIND_SILL });
    this.body.setVelocity({ x: 0, y: -1, z: 0 });
    this.hero.scale.setScalar(RESCUE_RADIUS);
    this.mouthX = rescueMouthX(x);
    this.mouth.position.x = this.mouthX;
    this.mouth.visible = true;
    this.notify({ type: 'rescueStart' });
  }

  rescued() {
    this.body.setEnabled(false);
    this.mouth.visible = false;
    this.ballLevel = Math.min(MAX_BALL_LEVEL, this.ballLevel + 1);
    this.state = 'return';
    this.returnAt = 0;
    this.notify({ type: 'rescued', level: this.ballLevel });
  }

  lost() {
    this.body.setEnabled(false);
    this.mouth.visible = false;
    this.hero.visible = false;
    const { lives, ballLevel, over } = afterLoss(this.lives);
    this.lives = lives;
    this.ballLevel = ballLevel;
    this.notify({ type: over ? 'over' : 'lost' });
    this.state = over ? 'over' : 'wait';
    this.waitLeft = NEXT_BALL_SECONDS;
  }

  takeHits(hits) {
    const { game } = this;
    for (const hit of hits) {
      if (hit.kind === 'pin') {
        game.callbacks.onBoardHit?.('pin', Math.min(hit.speed / 6, 1));
        continue;
      }
      game.playHit(hit, false);
      this.targetGlow[hit.index] = 1;
      const pearls = hitPearls(hit);
      for (let index = 0; index < pearls; index += 1) game.pearls.mint(0);
      this.notify({ type: 'hit', pearls });
    }
  }

  update(delta) {
    if (this.state === 'off') return;
    const { game } = this;
    const { pearls } = game;
    if (this.state === 'board') {
      const { hits, drained } = stepBoard(this.ball, this.flippers, this.board, this.input, delta, this.cooldowns);
      this.takeHits(hits);
      if (drained) this.drain();
      if (this.state === 'board') this.hero.position.copy(game.boardToWorld(this.ball.x, this.ball.y));
    } else if (this.state === 'pouring') {
      if (!pearls.gateOpen) {
        this.state = 'settle';
        this.settleStart = game.elapsed;
      }
    } else if (this.state === 'settle') {
      const lastExit = pearls.exits.at(-1) ?? this.settleStart;
      if (settleDone(game.elapsed - Math.max(lastExit, this.settleStart), game.elapsed - this.settleStart)) {
        this.notify({ type: 'settled', ...pearls.releaseStats() });
        this.nextBall();
      }
    } else if (this.state === 'rescue') {
      this.rescueLeft -= delta;
      this.hero.position.copy(this.body.position);
      this.notify({ type: 'rescueTick', left: this.rescueLeft });
      const phase = pearlPhase(this.body.position);
      if (phase === 'fall' && inRescueMouth(this.body.position.x, this.mouthX)) this.rescued();
      else if (phase || this.rescueLeft <= 0) this.lost();
    } else if (this.state === 'return') {
      this.returnAt += delta / RETURN_SECONDS;
      this.hero.scale.setScalar(BALL_RADIUS);
      if (this.returnAt >= 1) this.launch();
      else this.hero.position.copy(this.railCurve.getPoint(this.returnAt));
    } else if (this.state === 'wait') {
      this.waitLeft -= delta;
      if (this.waitLeft <= 0) this.launch();
    }
    this.targetGlow.forEach((glow, index) => {
      this.targetGlow[index] = Math.max(0, glow - delta * 4);
      this.targetMaterials[index].emissiveIntensity = 0.7 + this.targetGlow[index] * 2.5;
    });
    this.poseFlippers(delta);
  }

  poseFlippers(delta) {
    if (this.state !== 'board') stepFlippersOnly(this.flippers, this.input, delta, this.board);
    this.flippers.forEach(({ angle, side }, index) => {
      this.flipperMeshes[index].rotation.z = -side * angle;
    });
  }
}

// Off the board the flippers still answer the buttons, with no ball to hit.
const IDLE_BALL = { x: 0, y: 99, vx: 0, vy: 0, stuckFor: 0 };
function stepFlippersOnly(flippers, input, delta, board) {
  stepBoard({ ...IDLE_BALL }, flippers, { ...board, bottom: -999, ceiling: 999, pins: [], bumpers: [], guides: [] }, input, delta);
}
