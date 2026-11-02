import * as THREE from 'three';
import { GAME } from './config.js';

// Laid out after Pearl Fishery's structure: a timed drop down a pin board into bonus chutes, chutes
// that add pearls, fill a party meter or release a big pearl, and everything pushed over the edge
// paying. Those are the machine's public rules; the art and the world here are this game's own.
export const BALLS_PER_ROUND = 40;
export const FIRE_INTERVAL = 0.8;
export const SLOT_COUNT = 5;
export const METER_SIZE = 5;
export const RAIN_PEARLS = 30;
export const GOLD_RAIN_PEARLS = 40;
const VIOLET_METER = 2;
const SETTLE_QUIET_SECONDS = 2.5;
const SETTLE_MAX_SECONDS = 15;

// The bottom of the board, left to right. Timing the shuttle over an edge lands in the outer slot
// 76-78% of the time, over the centre in the centre slot 28%: the sure thing builds toward a rain,
// the long shot starts the alchemy. So the choice is what to go for, not which number is bigger.
export const SLOTS = Object.freeze([
  { label: 'RAIN', meter: 1, side: -1 },
  { label: '+8', pearls: 8, side: -1 },
  { label: 'CORE', core: 1, side: 0 },
  { label: '+8', pearls: 8, side: 1 },
  { label: 'RAIN', meter: 1, side: 1 },
]);

/** Which slot a ball leaving the board at `x` falls in. */
export function slotAt(x, halfWidth) {
  const width = (halfWidth * 2) / SLOT_COUNT;
  return Math.max(0, Math.min(SLOT_COUNT - 1, Math.floor((x + halfWidth) / width)));
}

/** The meter after adding `amount`: what is left over, and how many rains that set off. */
export function fillMeter(meter, amount) {
  const total = meter + amount;
  return { meter: total % METER_SIZE, rains: Math.floor(total / METER_SIZE) };
}

/** What a star core pays as it leaves: a violet one feeds the meter, a gold one is a rain of its own. */
export function coreReward(level) {
  if (level === 2) return { meter: VIOLET_METER, pearls: 0 };
  if (level === 3) return { meter: 0, pearls: GOLD_RAIN_PEARLS };
  return { meter: 0, pearls: 0 };
}

/** Whether a finished round can end: nothing left to fall, and the pile quiet or out of time. */
export function roundOver({ balls, inFlight, pouring, sinceExit, sinceLast }) {
  if (balls > 0 || inFlight > 0 || pouring) return false;
  return sinceExit >= SETTLE_QUIET_SECONDS || sinceLast >= SETTLE_MAX_SECONDS;
}

/**
 * One round: time the shuttle, a ball falls the pin board into a slot, and the slot acts on the
 * machine at once, with the pusher running throughout. Nothing to wait for between shots. The ball
 * itself carries on to the bed as a pearl, so every shot adds something.
 * States: off, play, over.
 */
export class StarDrop {
  constructor(game) {
    this.game = game;
    this.state = 'off';
    this.balls = BALLS_PER_ROUND;
    this.meter = 0;
    this.inFlight = 0;
    this.fireAt = 0;
    this.fireInterval = FIRE_INTERVAL;
    this.lastSlotAt = 0;
    this.slotGlow = SLOTS.map(() => 0);
    this.buildSlots();
  }

  // Lit plates along the board's floor, with what each one pays printed on it.
  buildSlots() {
    const { game } = this;
    const { halfWidth, bottom } = game.pinBoard;
    const width = (halfWidth * 2) / SLOT_COUNT;
    this.parts = new THREE.Group();
    const brass = new THREE.MeshStandardMaterial({
      color: 0xf2c94c, metalness: 0.8, roughness: 0.3, emissive: 0xa67b31, emissiveIntensity: 0.9,
      envMap: game.environmentTexture,
    });
    this.slotMaterials = SLOTS.map(({ label, meter, core }, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const context = canvas.getContext('2d');
      context.fillStyle = meter ? '#1c6fb8' : core ? '#c9861a' : '#6a3cb0';
      context.fillRect(0, 0, 256, 128);
      context.fillStyle = '#ffffff';
      context.font = 'bold 70px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, 128, 70);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.7 });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.1, 0.62), material);
      plate.rotation.y = Math.PI;
      plate.position.set(-halfWidth + width * (index + 0.5), bottom + 0.34, GAME.dropZoneZ + 0.1);
      this.parts.add(plate);
      return material;
    });
    for (let index = 0; index <= SLOT_COUNT; index += 1) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.74, 0.3), brass);
      wall.position.set(-halfWidth + width * index, bottom + 0.34, GAME.dropZoneZ);
      this.parts.add(wall);
    }
    this.parts.visible = false;
    game.boardInner.add(this.parts);
  }

  /** Everything of ours a skin must keep drawn. */
  get drawn() {
    return [this.parts];
  }

  setActive(on) {
    this.parts.visible = on;
    if (on) this.newRound();
    else this.state = 'off';
  }

  newRound() {
    this.balls = BALLS_PER_ROUND;
    this.meter = 0;
    this.inFlight = 0;
    this.fireAt = 0;
    this.state = 'play';
    this.lastSlotAt = this.game.elapsed;
    this.notify({ type: 'balls' });
  }

  notify(event) {
    this.game.callbacks.onStar?.(event);
  }

  /** The player's press: a ball from wherever the shuttle is, if one is ready. */
  fire() {
    const { game } = this;
    if (this.state !== 'play' || this.balls <= 0 || game.elapsed < this.fireAt) return false;
    if (!game.dropStarBall((x) => this.landed(x))) return false;
    this.fireAt = game.elapsed + this.fireInterval;
    this.balls -= 1;
    this.inFlight += 1;
    this.notify({ type: 'fired' });
    return true;
  }

  landed(x) {
    const { game } = this;
    const index = slotAt(x, game.pinBoard.halfWidth);
    const slot = SLOTS[index];
    this.inFlight -= 1;
    this.lastSlotAt = game.elapsed;
    this.slotGlow[index] = 1;
    if (slot.pearls) game.pearls.pour(slot.pearls, slot.side);
    if (slot.core) game.pearls.pour(1, x < 0 ? -1 : 1, slot.core);
    if (slot.meter) this.addMeter(slot.meter);
    this.notify({ type: 'slot', index, slot });
  }

  addMeter(amount) {
    const { meter, rains } = fillMeter(this.meter, amount);
    this.meter = meter;
    for (let rain = 0; rain < rains; rain += 1) this.rain(RAIN_PEARLS);
  }

  rain(count) {
    this.game.pearls.pour(count, 0);
    this.lastSlotAt = this.game.elapsed;
    this.notify({ type: 'rain', count });
  }

  /** A star core went over the lip. */
  coreOut(level) {
    const { meter, pearls } = coreReward(level);
    if (meter > 0) this.addMeter(meter);
    if (pearls > 0) this.rain(pearls);
    this.notify({ type: 'core', level });
  }

  update(delta) {
    if (this.state === 'off') return;
    const { game } = this;
    this.slotGlow.forEach((glow, index) => {
      this.slotGlow[index] = Math.max(0, glow - delta * 3);
      this.slotMaterials[index].emissiveIntensity = 0.7 + this.slotGlow[index] * 3;
    });
    if (this.state !== 'play') return;
    const { pearls } = game;
    const lastExit = Math.max(pearls.exits.at(-1) ?? 0, this.lastSlotAt);
    if (roundOver({
      balls: this.balls,
      inFlight: this.inFlight,
      pouring: pearls.queue.length > 0,
      sinceExit: game.elapsed - lastExit,
      sinceLast: game.elapsed - this.lastSlotAt,
    })) {
      this.state = 'over';
      this.notify({ type: 'over' });
    }
  }
}
