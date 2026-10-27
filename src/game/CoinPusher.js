import * as THREE from 'three';
import { clearPinsAround, pinLayout, simulateDrop } from './pachinko.js';
import { CHEST_ONLY_GROUPS, initPhysics, physicsBuild, PhysicsWorld } from './world.js';
import { boardThemeFor } from './themes/index.js';
import { drawReelStrip, REEL_IMAGE_FILES, trimmedArt } from './themes/nocturneReels.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  GAME,
  CABINET_BED_LENGTH,
  MACHINE_GEOMETRY_DEFAULTS,
  PALETTE,
  applyMachineGeometry,
  machineGeometryFor,
} from './config.js';
import {
  coinPhase,
  coinFallPhase,
  gildTargets,
  NATURAL_FALL_Y,
  quakeKick,
  rollSlotResult,
  slotWin,
} from './rules.js';
import {
  COIN_HEIGHT,
  COIN_RADIUS,
  TUNING_DEFAULTS,
  applyCoinTuning,
  createCoinBody,
  pusherMotionAt,
  seedPosition,
  BOARD_SILL_FRONT,
  chestDropZ,
  nudgeOverLip,
  onLowerBed,
  LOWER_BLADE_SINK,
  lowerBladeZAt,
  settleChestOnLowerBed,
} from './physics.js';

// Twelve seconds of play before the first frame, entered at full retreat (runPusherToFullRetreat).
// The three-layer seed keeps settling for a few strokes - a coin or two slides off the lip on
// some piles - and all of that has to happen here, where settlePile discards it, rather than in
// the player's first idle seconds. Six was enough for the lower blade's old 0.65 stroke; at 0.9
// seed 2024 still shed two coins in the first idle seconds after it. Rapier runs it in about a
// second.
const PILE_SETTLE_SECONDS = 12;

// How far off centre a chest may be dropped. playfieldHalfWidth less a whole chest width leaves
// more than the tumbling box's own half-diagonal clear of the glass at any spawn yaw.
const CHEST_DROP_HALF_WIDTH = GAME.playfieldHalfWidth - GAME.chestWidth;

// The spinning strip is exactly the payable symbols - see GAME.slotIdleSymbol for why the idle
// face is not one of them.
const REEL_STRIP = GAME.slotOutcomes.map((outcome) => outcome.symbol);
// Every part of the cabinet is cut from the playfield's half-width, so widening the machine is
// one config change rather than thirty literals. Kept as offsets from the interior, not ratios:
// a wider machine should get more playfield, not fatter trim.
const INNER_X = GAME.playfieldHalfWidth;
const BED_WIDTH = INNER_X * 2 + 0.15;
// Vertical fov at or above FRAME_ASPECT. Fov is vertical in three.js, so a field narrower than that
// would lose width off both sides - the bed's edges and the side rails - while gaining height it
// has no use for. Below it the vertical fov opens instead, holding the horizontal fov that
// FRAME_ASPECT gives, so the machine's full width always stays in frame and a tall field just
// shows a little more above and below. The pair is FLAT_CAMERA's: 71 degrees at the Duo's 0.87
// canvas is what seats the lip at the bottom with the slot's crown still in frame, and it holds
// the horizontal fov the old 62 at 1.03 did (tan 35.5 * 0.87 = tan 31 * 1.03), so the bed's
// width in frame is unchanged; a wider window just keeps the extra height.
const CAMERA_FOV = 71;
const FRAME_ASPECT = 0.87;

// The camera rides the hinge. Lying flat the display is one plane and the flat pose is right; stood
// up at 90 degrees the table lies on the lower half and the back wall rises on the upper, and the
// fold pose puts the pusher shelf's back edge on the fold with the lip's corners filling the width
// (at the Duo's ~0.87 canvas, the fold near mid-canvas). Angles between blend the two.
// ponytail: the fold pose is for that one layout. Upgrade path: solve the pitch from the hinge rect.
// The flat pose seats the lip at the frame's bottom now that no launcher stands in front of it:
// within 0.2 of the edge on a portrait phone, flush at the desktop's 1.05.
// Both pose for the tall pin board: lip near the frame's bottom with a margin under it, the slot's
// crown just inside its top, the board's bottom edge near mid-frame. Flat is a player standing at
// the machine (~10 degrees of pitch); stood up looks down ~25, so the half lying on the desk reads
// more like a table seen from above, at the cost of a narrower bed.
export const FLAT_CAMERA = { position: [0, 5.25, -7.5], target: [0, 4, 0] };
// ~25 degrees. Solved with the board turned square to it (boardReclineFor) and the sill carried
// onto the fold by poseCamera's view offset, so neither is a constraint on the pose itself - what
// is: the lip's corners inside the frame's sides and above its bottom, the slot's crown inside its
// top, and all of it held at every step of the blend from FLAT_CAMERA, on whichever layout the
// hinge has switched to (tests/camera.test.js). Within those, the widest pin board: searched over
// position, target and fov for the stood-up layout, where the canvas runs to the top of the display
// (html[data-fold]). Backing off and narrowing the fov from 66 flattens the perspective, so the
// board grows ~18% while the nearer lip stays in. The coin tray under the lip fills the band below
// it - see chuteZ.
export const FOLD_CAMERA = { fov: 50, position: [0, 14, -10.5], target: [0, 9, 0] };
// A foldable's flat pose. The sill rides the fold at every angle there (poseCamera), so the open
// end needs its own pose: FLAT_CAMERA's frame slid up that far loses the slot's crown. ~10 degrees
// of pitch, searched with FOLD_CAMERA fixed for the widest board at 150 degrees, the comfiest
// angle to play at, under the same constraints. Its board is the same size as the fold pose's
// within 1%, so folding stands the board up and tips the bed without zooming either.
export const OPEN_CAMERA = { fov: 54, position: [0, 11.5, -11.5], target: [0, 9.5, 0] };
// The pin board coins fall through, standing over the drop zone. Coins exit at its bottom onto the
// tray - the same z as ever, so every coin still lands on the moving tray - and its half-width is
// the old landing spread, so pins scatter the drop without ever throwing it off the tray.
// Both poses above were searched with this board: its bottom sits on the fold stood up, and the
// slot's crown stays in frame lying flat.
export const PIN_BOARD = Object.freeze({
  halfWidth: GAME.launcherTravelHalfWidth,
  // Up to the carriage's mouth, and a unit taller than it was so the slot rises into the empty band
  // that sat between its crown and the HUD (see GAME.slotY and the camera poses, searched with it).
  top: 8.1,
  bottom: 1.6,
  rows: 14,
  // Open fall under the last row of pins. With the pins run to the sill, coins could only leave
  // through the last row's gaps and the tray got a comb of landings with nothing under each pin;
  // this much free fall lets a coin's sideways speed smear that out.
  runout: 0.9,
  pinRadius: 0.06,
  coinRadius: COIN_RADIUS,
  // Pop bumpers, after the round kickers on 塔塔冒險隊's board: they kick a slow coin away
  // (pachinko.js), which is most of what makes the fall feel alive. Pins too close to one are
  // cleared so a coin can always slip past - see clearPinsAround.
  // Searched by simulation together with rows, runout and DROP_SWEEP for an even spread (4000
  // drops): every fourteenth of the sill gets 5-9% of the coins, against 0-12% when every coin
  // dropped from the centre, and each bumper is hit by ~30% of coins. From the centre the two top
  // bumpers sat 1.6 off the drop line with a single unit to fall, and only ~2.5% ever reached them.
  bumpers: Object.freeze([
    { x: -1.6, y: 7.1, radius: 0.28 },
    { x: 1.6, y: 7.1, radius: 0.28 },
    { x: 0, y: 3, radius: 0.28 },
  ]),
});
/** The board's pins: rows down to the runout, minus any too close to a bumper to pass. */
export function boardPins() {
  const pins = pinLayout({ ...PIN_BOARD, bottom: PIN_BOARD.bottom + PIN_BOARD.runout });
  return clearPinsAround(pins, PIN_BOARD.bumpers, PIN_BOARD.coinRadius);
}
// How fast a hit pin or bumper's flash and swell fade, per second.
const HIT_FADE = 5;
// The carriage rides the slot's beam; coins leave it clear of the top row of pins.
export const DROPPER_Y = GAME.slotY - 0.45;
// The carriage's mouth: coins meet the first row of pins as soon as they leave it.
const DROP_START_Y = PIN_BOARD.top;
// The mouth's shuttle sweeps the beam and drops each coin wherever it is, so every lane and both
// top bumpers are fed. A triangle wave rather than a sine: a sine lingers at the ends and piles
// coins against the walls. The period is kept off any multiple of GAME.autoInterval, or auto-play
// would drop on the same few spots every pass.
const DROP_SWEEP = 2.8;
const DROP_SWEEP_PERIOD = 3.1;
// The shuttle shows the next coin standing in its cell. After a drop the cell's floor shuts by
// 0.3s (themes/nocturne.js), then the next coin is minted into the seat: a mint flash and a short
// settle, inside the cell rather than slid in from above, where the crown's centre gap would show
// it appearing from nothing. Done well inside GAME.autoInterval.
const COIN_REFILL_DELAY = 0.3;
const COIN_REFILL_TIME = 0.2;
// Standing on edge in the board's plane - the pose updateLaunching plays the fall back in.
/**
 * The waiting coin's refill at `since` seconds after the cell's last drop.
 * @param {number} since Seconds since the drop (Infinity before the first one).
 * @returns {{visible: boolean, lift: number, scale: number, flash: number}} lift is above the seat.
 */
export function refillPose(since) {
  const t = (since - COIN_REFILL_DELAY) / COIN_REFILL_TIME;
  // Eases down the last 0.12 into the seat and grows from 0.7 as it is minted.
  const settle = Math.min(1, Math.max(0, t));
  return {
    visible: t >= 0,
    lift: 0.12 * (1 - settle) ** 2,
    scale: 0.7 + 0.3 * settle,
    flash: t >= 0 && t < 1.5 ? 0.9 * (1 - t / 1.5) : 0,
  };
}
const COIN_UPRIGHT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

/**
 * Where the shuttle stands at time t: a triangle wave across +-DROP_SWEEP, at 0 when t is 0.
 * @param {number} t Seconds on the game clock.
 * @returns {number} Board x.
 */
export function dropXAt(t) {
  const phase = (((t / DROP_SWEEP_PERIOD) + 0.25) % 1 + 1) % 1;
  return DROP_SWEEP * (1 - 4 * Math.abs(phase - 0.5));
}

// The board's pivot - its mint sill.
const BOARD_PIVOT = new THREE.Vector3(0, PIN_BOARD.bottom - 0.1, GAME.dropZoneZ - 0.1);

/**
 * The board's recline, in radians, that lays it parallel to the screen: the camera's own pitch,
 * read from its forward direction. A plane parallel to the image plane projects with no
 * perspective at all - an exact rectangle, as if printed on the upper half of the display - which
 * is what the stood-up half should show. Aiming it at the camera instead still left a 3% keystone.
 * Coins fall in the board's own plane (pachinko.js), so leaning it back changes nothing about
 * where they go, and the sill it turns about stays on the fold.
 */
export function boardReclineFor(cameraForward) {
  return Math.max(0, Math.asin(THREE.MathUtils.clamp(-cameraForward.y, -1, 1)));
}

/**
 * Whether the machine is paused because the phone is nearly shut: below 60 degrees it closes,
 * above 65 it opens again, and between the two it stays as it was so a hinge resting on the
 * threshold does not flicker it. A missing reading counts as open.
 */
export function closedFor(wasClosed, hingeDegrees) {
  if (!Number.isFinite(hingeDegrees)) return false;
  if (hingeDegrees < 60) return true;
  if (hingeDegrees > 65) return false;
  return Boolean(wasClosed);
}

/**
 * How stood up the display is, 0 lying flat to 1 at a right angle or tighter, from the hinge angle
 * in degrees. Smoothstepped, so the camera eases into both ends instead of arriving at them at full
 * speed - a straight ramp reads as a hard stop when the hinge reaches 90.
 */
export function foldFor(hingeDegrees) {
  if (!Number.isFinite(hingeDegrees)) return 0;
  return THREE.MathUtils.smoothstep((180 - hingeDegrees) / 90, 0, 1);
}

// The pin board's mint sill, which the stood-up view puts on the fold (see buildDropper).
const SILL_HEIGHT = PIN_BOARD.bottom - 0.1;
// How high a coin stack can stand under the board's sill before the chest guard stops it.
const CHEST_GUARD_COIN_CLEARANCE = 0.35;
// Coins are drawn this much thicker than they collide. The physics wants a thin coin (0.05) so the
// pile shingles and hangs over the lip, but coin.glb is modelled at thickness/diameter 0.195 and
// squashed to 0.07 its rim bevel turned into a hairline: at the game camera they read as paper.
// 1.5 brings the rim back; stacked coins then overlap by about 0.025, which the shingling hides.
const COIN_DRAW_THICKEN = 1.5;
// How long a coin may sit stranded behind the blade, under the tray, before it is recycled.
const STRANDED_SECONDS = 1;
// How long a paid chest stays in sight before it is retired, in case it lodges in the chute.
const CHEST_RETIRE_SECONDS = 1.5;
// How long a chest may sit past the lip without falling before it pays anyway.
const CHEST_WEDGE_SECONDS = 2;

/**
 * Vertical view offset, in canvas pixels, that carries the sill from sillNdc (where the camera puts
 * it, in canvas NDC) onto the fold, foldY pixels below the canvas top.
 */
export function foldShiftFor(foldY, canvasHeight, sillNdc) {
  const foldNdc = 1 - (2 * foldY) / canvasHeight;
  return ((foldNdc - sillNdc) * canvasHeight) / 2;
}

// The balustrade lamps (cabinet.glb fence_lamp_<bay>_<side>, bay 1 nearest the player): resting
// level, and which bay is lit at a time - one per FENCE_LAMP_STEP, front to back, the board's
// marquee beat (themes/nocturne.js).
const FENCE_LAMP_IDLE = 0.25;
const FENCE_LAMP_BAYS = 6;
const FENCE_LAMP_STEP = 0.45;

/** The bay (1 at the player's end) whose lamps are lit at `time` seconds. */
export function fenceLampLit(time) {
  return (Math.floor(time / FENCE_LAMP_STEP) % FENCE_LAMP_BAYS) + 1;
}

// The machine's fanfare: the lamps race front to back twice, a bay every LAMP_RACE_STEP, then fall
// back to the marquee beat. It plays when a foldable stands the machine up and on every chest prize.
const LAMP_RACE_STEP = 0.07;
const LAMP_RACE_LAPS = 2;

/** The bay racing `since` seconds into a lamp race, or 0 once it is over. */
export function lampRaceLit(since) {
  const step = Math.floor(since / LAMP_RACE_STEP);
  if (!(since >= 0) || step >= FENCE_LAMP_BAYS * LAMP_RACE_LAPS) return 0;
  return (step % FENCE_LAMP_BAYS) + 1;
}

/** The reels (indices into `locks`) that locked between two points of the spin clock. */
export function reelsLockedBetween(previous, now, locks) {
  return locks.flatMap((lock, index) => (previous < lock && lock <= now ? [index] : []));
}

/**
 * Whether this fold powers the machine on: once, as it opens past the fold of a 165 degree hinge,
 * and armed again only back past 172, so a hinge resting near the line does not replay it.
 */
export function standUpFor(armed, fold) {
  if (armed && fold > foldFor(165)) return { fire: true, armed: false };
  return { fire: false, armed: armed || fold < foldFor(172) };
}

// The reel drums' faces, in order round each drum, and the angle between neighbours. The idle '?'
// rides the drum too, so a machine that has not paid shows it rather than a blank.
const DRUM_FACES = ['7', 'bag', 'quake', 'gild', '?'];
const DRUM_STEP = (Math.PI * 2) / DRUM_FACES.length;
// Calibrated by eye against the rendered drums: which way the cells are turned on the texture,
// and which way round the drum turns, so symbols stand upright and roll down past the window.
const DRUM_TEXTURE_TURN = Math.PI / 2;
const DRUM_DIRECTION = 1;

/** The drum angle, radians, that shows `face` square in the window. */
export function drumAngleFor(face) {
  const index = Math.max(0, DRUM_FACES.indexOf(face));
  return (index + 0.5) * DRUM_STEP;
}

/**
 * A drum's angle `elapsed` seconds into a spin: it runs at `speed` from `start`, and over the last
 * `settle` seconds before `lockAt` eases onto `target` - the first equivalent of it far enough
 * ahead to keep rolling forward - overshooting a touch and settling back like a real reel.
 */
export function drumAngleAt({ start, target, elapsed, lockAt, speed = 9, settle = 0.65 }) {
  const settleFrom = Math.max(0, lockAt - settle);
  if (elapsed <= settleFrom) return start + speed * elapsed;
  const from = start + speed * settleFrom;
  const turn = Math.PI * 2;
  const end = target + turn * Math.ceil((from + turn / 3 - target) / turn);
  if (elapsed >= lockAt) return end;
  const t = (elapsed - settleFrom) / (lockAt - settleFrom) - 1;
  // A small overshoot, a real reel's brake catching it; more read as bouncing back.
  const back = 0.3;
  return from + (end - from) * (1 + (back + 1) * t ** 3 + back * t ** 2);
}

// Frames slower than this, sustained for ADAPT_SECONDS, step the render quality down.
const ADAPT_FRAME = 1 / 45;
const ADAPT_SECONDS = 2;
// Physics a settle slice may run before yielding a frame - most of a 60 Hz frame.
const SETTLE_SLICE_MS = 12;
const nextFrame = () => new Promise((resolve) => { requestAnimationFrame(resolve); });
const TRIM_INTERVAL = 0.25;

/**
 * The running count of slow time behind adaptQuality: grows by slow frames, resets on a fast one,
 * and calls for one step down once it reaches ADAPT_SECONDS (then starts over).
 */
/**
 * Catch-up steps a frame may run, from the last frame's mean step time: one once a step eats most
 * of a frame, back to the profile's count only when there is clear room again. The gap between
 * 10 and 6 ms is the hysteresis - restoring on one cheap frame let the next catch-up spike in.
 */
export function nextMaxSubSteps(current, stepMs, normal) {
  if (stepMs > 10) return 1;
  if (stepMs < 6) return normal;
  return current;
}

export function adaptiveStepFor(slowFor, frameDelta) {
  if (frameDelta <= ADAPT_FRAME) return { slowFor: 0, stepDown: false };
  const next = slowFor + frameDelta;
  return next >= ADAPT_SECONDS ? { slowFor: 0, stepDown: true } : { slowFor: next, stepDown: false };
}

/** A drop path's pose at time t, linearly between its samples; past the end it holds the last. */
export function pathAt(path, t, next = path.findIndex((sample) => sample.t >= t)) {
  if (next < 0 || next >= path.length) return path[path.length - 1];
  if (next === 0) return path[0];
  const from = path[next - 1];
  const to = path[next];
  const k = (t - from.t) / (to.t - from.t);
  return {
    t,
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    angle: from.angle + (to.angle - from.angle) * k,
  };
}

/**
 * pathAt's lookup resumed from where the last frame left it: the first index at or after `from`
 * whose sample is at or past t. Only valid while t never goes backwards, which a shot's clock doesn't.
 */
export function pathCursor(path, t, from = 0) {
  let index = from;
  while (index < path.length && path[index].t < t) index += 1;
  return index;
}

/** Vertical fov, in degrees, that keeps the machine's width in frame at this aspect. */
export function fovForAspect(aspect) {
  if (!(aspect > 0) || aspect >= FRAME_ASPECT) return CAMERA_FOV;
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * (FRAME_ASPECT / aspect);
  return THREE.MathUtils.radToDeg(2 * Math.atan(halfHeight));
}
// World units per tile of public/textures/deck_plate.jpg. The tile is two plates across, so a
// plate is two units - about three coin diameters.
const DECK_PLATE_TILE = 4;
// How much the plate art is darkened, 0..1.
const DECK_PLATE_SHADE = 0.3;
// Where a horizontal seam falls in the plate art, as a fraction of the tile (315 of 1254 px).
const DECK_PLATE_SEAM = 0.25;
// Colour multiplied over the plate art on the scraper's upright face.
const DECK_PLATE_SCRAPER_TINT = 0xd0d0d0;
// Colour multiplied over the plate art on the tray inlays. Grey, not glassTint - see inlaySurface.
const DECK_PLATE_INLAY_TINT = 0xffffff;
// The payout chute hangs off the front lip, so it travels with playfieldFrontZ - which the
// geometry panel moves, so this is read per placement rather than captured at import.
// It is also the coin tray the stood-up view shows under the lip: with the pin board's sill on the
// fold, the bed cannot reach the bottom of the frame, and this fills that band instead of black.
// Sized for FOLD_CAMERA: its back wall's top lands near -0.71 and its front near -0.96. Back edge
// tucked 0.1 under the lip so a coin coming off the bed falls straight in.
const chuteZ = () => GAME.playfieldFrontZ - 1.1;
const FRONT_TRIM_HEIGHT = 0.12;
const FRONT_TRIM_DEPTH = 0.04;
const frontTrimZ = () => GAME.playfieldFrontZ - 0.002 + FRONT_TRIM_DEPTH / 2;
const CHUTE_FLOOR_Y = -1.6; // top face; under trayY (-1.4), so a coin resting here has scored
const CHUTE_WALL_TOP = -1.0;
// The payout slot: a solid front panel whose back face stands this far in front of the lip, so the
// only opening is a dark slit under the bed's front edge. Its top sits over CHUTE_WALL_TOP to hide
// the tray floor from FOLD_CAMERA - a lit floor there read as coins landing on the ground.
const FASCIA_GAP = 0.45;
const FASCIA_TOP_Y = -0.65;
// Trim finish. On a machine made of painted metal an emissive strip is the one thing that cannot
// be a real object, so the gold reads as polished brass instead: same colour, same job marking an
// edge, but lit by the room rather than glowing on its own.
const BRASS = Object.freeze({ roughness: 0.26, metalness: 0.92, envMapIntensity: 0.9 });
const SETTLE_SOLVER_ITERATIONS = 4;

export class CoinPusher {
  constructor(canvas, quality, callbacks = {}) {
    this.canvas = canvas;
    this.quality = quality;
    this.callbacks = callbacks;
    this.elapsed = 0;
    this.running = false;
    this.activeCoins = [];
    this.coinPool = [];
    this.createdCoins = 0;
    // Paid coins go as they touch the tray: left to gather there for seconds, they read as coins
    // dropped on the floor that blink out later.
    this.recycleDelay = 0.38;
    this.frameId = 0;
    this.cleanup = [];
    this.launching = [];
    // 0 lying flat, 1 stood up at 90 degrees or less - see setHingeAngle. fold eases towards
    // foldTarget so a coarse hinge reading glides rather than jumps.
    this.fold = 0;
    this.foldTarget = 0;
    // Set by the first hinge reading - see setHingeAngle.
    this.foldable = false;
    this.standUpArmed = true;
    this.lampRaceAt = -Infinity;
    // Mechanical surfaces re-skinned when a cabinet shell loads: the tray, its inlay, the blade,
    // the scraper and the rear deck. Their own materials are tuned for the procedural machine -
    // the scraper's gold emissive in particular only reads as a lit guard against procedural
    // furniture - and left showing next to a shell they are the thing that looks pasted on. The
    // bed is deliberately not among them: it carries drawn markings.
    this.shellSurfaces = [];
    // Cabinet furniture: hidden wholesale when a real cabinet model loads. Functional surfaces
    // (bed, glass, tray, scraper, rails) are never in here - those are aligned to physics and a
    // model cannot replace them without the collision bodies moving too.
    this.decor = [];
    // Parts whose Z placement or length is decided by the geometry panel. Collected during the
    // build and re-placed by layoutGeometry(), so a slider never rebuilds the machine.
    this.glassPanes = [];
    this.neonBars = [];
    // Emissive shell parts the pulse in animate() drives. Empty without a cabinet model.
    this.shellNeon = [];
    this.chuteParts = [];
    this.shellPosts = [];
    this.shellSkirts = [];
    this.headboardParts = [];
    this.trayParts = [];
    // Read back off GAME rather than passed in: main.js applies any saved geometry before the
    // machine is built, and this is the same five numbers seen from the other side.
    this.geometry = machineGeometryFor({
      scraperZ: GAME.scraperZ,
      upperCenterZ: GAME.pusherOriginZ,
      upperLength: GAME.pusherDepth + GAME.pusherRearExtension,
      lowerCenterZ: (GAME.playfieldFrontZ + GAME.playfieldBackZ) / 2,
      lowerLength: GAME.playfieldBackZ - GAME.playfieldFrontZ,
    });
    // Solver iterations are the one knob whose default is device-dependent, so it is seeded
    // from the quality profile rather than the shared defaults.
    this.tuning = { ...TUNING_DEFAULTS, solverIterations: quality.solverIterations };
  }

  async init() {
    this.setupRenderer();
    const environmentReady = this.setupScene();
    await initPhysics();
    this.setupPhysics();
    await Promise.all([
      environmentReady,
      this.setupSharedAssets(environmentReady),
    ]);
    this.buildMachine();
    // After buildMachine: the cabinet hides the procedural furniture, which has to exist first.
    await this.loadCabinet();
    // After loadCabinet: the slot machine sits on the cabinet's crown, whose height it measures.
    this.buildBonusStage();
    // The slot crowns the board, so it reclines with it. attach() keeps the world pose it was built in.
    for (const part of [this.slotMesh, this.reelPanel]) if (part) this.boardInner.attach(part);
    await this.setupBloom();
    this.setupParticles();
    this.bindResize();
    await this.resetPile();
    // Compile every shader and draw one frame behind the onboarding dialog. Left to the first
    // animate(), shader compilation stalled the tap on 開始挑戰 on an iPhone 13, and the dialog
    // sat over an empty canvas.
    await this.renderer.compileAsync(this.scene, this.camera);
    this.syncCoinInstances();
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    return this;
  }

  setupRenderer() {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: !this.quality.lowPower,
        alpha: false,
        powerPreference: this.quality.lowPower ? 'low-power' : 'high-performance',
      });
    } catch (error) {
      throw new Error('無法建立 WebGL 畫面，請更新瀏覽器或開啟硬體加速。', { cause: error });
    }
    renderer.setPixelRatio(this.quality.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = this.quality.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    const onContextLost = (event) => {
      event.preventDefault();
      this.stop();
      this.callbacks.onError?.('圖形裝置中斷，請按「重新載入」恢復遊戲。');
    };
    this.canvas.addEventListener('webglcontextlost', onContextLost);
    this.cleanup.push(() => this.canvas.removeEventListener('webglcontextlost', onContextLost));
  }

  setupScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.scene);
    scene.fog = new THREE.Fog(PALETTE.fog, 17, 42);
    this.scene = scene;

    // First person: the player stands at the cabinet instead of looking down on it. The pose follows
    // the hinge, between FLAT_CAMERA and FOLD_CAMERA - see poseCamera. The pitch clears the
    // machine's rear, so the hall backdrop shows through the playfield's back opening as a lit
    // backglass. Fov is vertical, so only the bed's share of the width moves with aspect, and a
    // tall narrow window is what runs out of room first.
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
    camera.position.set(...FLAT_CAMERA.position);
    camera.lookAt(...FLAT_CAMERA.target);
    this.camera = camera;
    // Where the camera rests, so an earthquake can shake it and put it back. poseCamera moves it.
    this.cameraBase = camera.position.clone();

    scene.add(new THREE.HemisphereLight(PALETTE.white, PALETTE.shell, 1.35));
    const key = new THREE.DirectionalLight(PALETTE.white, this.quality.shadows ? 2.35 : 1.85);
    key.position.set(-4, 10, -6);
    key.castShadow = this.quality.shadows;
    key.shadow.mapSize.set(this.quality.lowPower ? 512 : 1024, this.quality.lowPower ? 512 : 1024);
    Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 32 });
    scene.add(key);

    const playfieldFill = new THREE.PointLight(PALETTE.goldSoft, 5.2, 18);
    playfieldFill.position.set(0, 5.5, -2.5);
    scene.add(playfieldFill);

    // Brand colors remain as restrained accent light instead of tinting the machine.
    const tealAccent = new THREE.PointLight(PALETTE.blue, 2.2, 16);
    tealAccent.position.set(-5.2, 4.6, -3.2);
    scene.add(tealAccent);
    const goldAccent = new THREE.PointLight(PALETTE.gold, 1.1, 12);
    goldAccent.position.set(5.2, 4.4, -1.2);
    scene.add(goldAccent);
    // Cool rim from behind the cabinet, matching the mock's corridor lighting. Its range is what
    // keeps it a rim: it sits on the centre line like the camera, so its mirror point on the bed is
    // the centre line too, at z -1.2, 7.66 away - and at 18 it painted a blue hot spot down the
    // middle of the payout area every time the tray pulled back. 6.5 stops short of that point
    // and still reaches the scraper (3.1) and the middle of the tray (6.2).
    const rimAccent = new THREE.PointLight(PALETTE.blue, 3.2, 6.5);
    rimAccent.position.set(0, 4.2, 5.2);
    scene.add(rimAccent);
    // x 7, outside the cabinet's width: this camera sees a point light mirrored in the bed at
    // x * 5.4 / (5.4 + 2.6), which from x 5.4 was 3.65 - a hard white spot halfway up the bed.
    // From 7 it lands at 4.73, inside the side wall.
    const purpleAccent = new THREE.PointLight(PALETTE.goldSoft, 1.4, 16);
    purpleAccent.position.set(7, 2.6, 3);
    scene.add(purpleAccent);

    return this.loadCoinEnvironment();
  }

  // What every metal surface in the machine reflects. It used to be decor_shop_1k.hdr, a bright
  // daylit shop interior: the coins and the gold trim mirrored windows and warm room light while
  // standing in a dark neon hall, which is most of why the machine read as pasted in front of its
  // backdrop. This is the hall instead, built rather than loaded - a navy corridor with the
  // backdrop's mint wall columns, gold ceiling rings and teal far glow, in PALETTE. Colours are
  // pushed past 1 on purpose: PMREM renders to half float, and it is the over-bright strips that
  // give a coin a crisp highlight rather than a grey sheen.
  async loadCoinEnvironment() {
    const room = new THREE.Scene();
    room.background = new THREE.Color(PALETTE.scene);
    const lit = (color, strength) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(strength),
      side: THREE.DoubleSide,
    });
    const add = (geometry, material, x, y, z) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      room.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(24, 12, 60), new THREE.MeshBasicMaterial({ color: PALETTE.dark, side: THREE.BackSide }), 0, 4, 0);
    const column = new THREE.BoxGeometry(0.2, 7, 0.2);
    const mint = lit(PALETTE.mint, 4);
    for (let z = -24; z <= 24; z += 4) {
      for (const x of [-11.8, 11.8]) add(column, mint, x, 3.5, z);
    }
    const gold = lit(PALETTE.gold, 3);
    for (let z = -20; z <= 20; z += 8) {
      add(new THREE.TorusGeometry(3.2, 0.08, 6, 48), gold, 0, 9.9, z).rotation.x = Math.PI / 2;
    }
    // Soft warm panel straight overhead, where playfieldFill hangs: the top light coins and gold
    // trim read their colour by. Dimmer than the neon so it lifts rather than whitens.
    add(new THREE.PlaneGeometry(14, 22), lit(PALETTE.white, 1.0), 0, 9.95, 2).rotation.x = Math.PI / 2;
    add(new THREE.PlaneGeometry(10, 8), lit(PALETTE.mintSoft, 1.6), 0, 4, 29.9);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = pmremGenerator.fromScene(room, 0.04).texture;
    pmremGenerator.dispose();
    room.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
  }

  // The mock's look is mostly bloom: neon trim and gold rims bleeding into the dark cabinet.
  // ponytail: skipped on low-power devices — an extra full-screen pass is the first thing to cut.
  async setupBloom() {
    if (this.quality.lowPower) return;
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // strength / radius / threshold — only emissive trim and lit coin rims pass the threshold.
    // Down from 0.34 / 0.92: the machine grew a lot of emissive after this was first set (the
    // cabinet's rails and marquee, the launcher, the slot's crown), and each addition spent the
    // same budget. Raising the threshold first is what keeps the trim reading as trim — it cuts
    // the number of pixels that glow rather than dimming the ones that should.
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.42, 0.96));
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.resize?.();
  }

  setupPhysics() {
    // Six friction pairs - coin against the bed, other coins and the pusher, and the chest against
    // the same three at GAME.chestFrictionScale times the grip - all derived per collider from the
    // tuning (world.js frictionFor), so setPhysics re-derives them live.
    this.world = new PhysicsWorld({
      gravity: { x: 0, y: -24, z: -this.tuning.tilt },
      fixedStep: this.quality.physicsStep,
      maxSubSteps: this.quality.physicsMaxSubSteps,
      iterations: this.tuning.solverIterations,
      tuning: this.tuning,
      chestScale: GAME.chestFrictionScale,
    });
  }

  // Live tuning. Everything but thickness lands on the running world; thickness resizes every
  // coin's collision shape, which would leave a settled pile interpenetrating, so the pile is
  // reseeded instead. Pooled coins are patched too, or a recycled coin reverts to old values.
  setPhysics(patch) {
    Object.assign(this.tuning, patch);
    const resizeShape = Object.hasOwn(patch, 'thickness');
    this.world.setGravity({ x: 0, y: -24, z: -this.tuning.tilt });
    this.world.setIterations(this.tuning.solverIterations);
    this.world.setFriction(this.tuning);
    const scaleY = (this.tuning.thickness / COIN_HEIGHT) * COIN_DRAW_THICKEN;
    // In-flight coins too: resetPile returns them to the pool, and an untuned one would be reused.
    for (const coin of [...this.activeCoins, ...this.coinPool, ...this.launching.map((shot) => shot.coin)]) {
      applyCoinTuning(coin.body, this.tuning, resizeShape);
      coin.mesh.scale.y = scaleY;
    }
    if (resizeShape) this.resetPile();
  }

  async setupSharedAssets(environmentReady) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    // Optional decoration loads the same way the launcher does: a missing file is a warning and a
    // feature that quietly does nothing, never a failed boot.
    const optional = (path, label) => new GLTFLoader().loadAsync(path).catch((error) => {
      console.warn(`[${label}] GLB unavailable.`, error);
      return null;
    });
    const [model, hallTexture, chestModel, slotModel, deckPlate] = await Promise.all([
      new GLTFLoader().loadAsync('models/coin.glb'),
      new THREE.TextureLoader().loadAsync('backdrop/hall.jpg'),
      optional('models/chest_tripo.glb', 'chest'),
      optional('models/slot_tripo.glb', 'slot'),
      // The bed's plate art. Missing, the bed falls back to its drawn grid.
      new THREE.ImageLoader().loadAsync('textures/deck_plate.jpg').catch((error) => {
        console.warn('[deck] plate texture unavailable.', error);
        return null;
      }),
    ]);
    this.deckPlate = deckPlate;
    hallTexture.colorSpace = THREE.SRGBColorSpace;
    this.hallTexture = hallTexture;
    this.chestModelSource = chestModel?.scene ?? null;
    this.slotModelSource = slotModel?.scene ?? null;
    const sourceMeshes = [];
    model.scene.traverse((object) => {
      if (object.isMesh) sourceMeshes.push(object);
    });
    const sourceCoin = model.scene.getObjectByName('coin_lp') ?? sourceMeshes[0];
    if (!sourceCoin?.isMesh) throw new Error('硬幣模型中找不到可用的網格。');

    sourceCoin.updateWorldMatrix(true, false);
    this.coinGeometry = sourceCoin.geometry.clone().applyMatrix4(sourceCoin.matrixWorld);
    this.coinGeometry.center();
    this.coinGeometry.computeBoundingBox();
    const modelSize = new THREE.Vector3();
    this.coinGeometry.boundingBox.getSize(modelSize);
    this.coinGeometry.scale(
      (COIN_RADIUS * 2) / modelSize.x,
      COIN_HEIGHT / modelSize.y,
      (COIN_RADIUS * 2) / modelSize.z,
    );
    this.coinGeometry.computeBoundingSphere();

    // Silver and gold, from one gold asset. Both share the model's normal map, its ambient
    // occlusion and its packed roughness/metalness - only the base colour differs.
    //
    // The premium coin used to be this same gold multiplied by mint, and that is why it was hard
    // to read: `color` multiplies `map` in three.js, so a tint can only take channels away. Gold
    // has almost no blue to take, so no tint turns it silver - it turns it olive. The two coins
    // ended up differing by a muddy hue shift on identical brightness, in a scene already full of
    // teal. Nulling `map` on the plain coin instead hands its hue entirely to `color`, and the
    // pair then differs on hue AND on value, which is what tells them apart at a glance.
    //
    // Which way round is not arbitrary: the mechanic is already called gilding. gildCoins() turns
    // plain coins premium, and a silver coin turning gold is the thing the player watches happen.
    await environmentReady;
    const regular = sourceCoin.material.clone();
    regular.envMap = this.environmentTexture;
    regular.map = null;
    // Brushed pewter, not chrome. A metal takes its colour entirely from what it reflects, so
    // all three of these dim it and they do different jobs: colour tints the reflection, envMap
    // intensity scales the HDR feeding it, and roughness spreads the key light's highlight from a
    // hot spot into a sheen. At metalness 1 / roughness 0.34 / intensity 1.1 the plain coins came
    // back as mirrors of a brightly lit shop HDR - brighter than the neon, and flat enough to
    // lose the relief the normal map is there to show. The palette has no silver, so the hue is
    // its white taken down in value rather than a new colour.
    regular.color = new THREE.Color(PALETTE.white).multiplyScalar(0.62);
    regular.metalness = 0.92;
    regular.roughness = 0.56;
    regular.envMapIntensity = 0.55;
    regular.needsUpdate = true;

    const premium = sourceCoin.material.clone();
    premium.envMap = this.environmentTexture;
    // A glint, not a lamp. The pair already reads without it; this is what makes the rare one
    // feel rare when a few of them sit in a pile of plain ones.
    premium.emissive = new THREE.Color(PALETTE.gold);
    premium.emissiveIntensity = 0.18;
    premium.needsUpdate = true;
    this.coinMaterials = { regular, premium };
    // Every coin is drawn by one of two instanced meshes, one per material: a few hundred coins
    // as a few hundred meshes was a few hundred draw calls, twice over with shadows. A coin keeps
    // an Object3D as its transform (see makeCoin) and syncCoinInstances copies those in per frame.
    this.coinBatches = {};
    for (const name of Object.keys(this.coinMaterials)) this.growCoinBatch(name, 256);

    sourceMeshes.forEach((mesh) => {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    });
    this.buildSurfaceMaps();
    this.glowTexture = this.createGlowTexture();
    this.badgeTexture = this.createBadgeTexture();
  }

  // Built as data, not drawn on a canvas: a canvas gradient that fades to transparent leaves the
  // colour of its clear pixels undefined, and the iOS simulator filled them with garbage - the
  // floor's light pool, a 64px texture stretched over 16 x 22 units, came out as coloured specks.
  // Here every texel is white and only alpha falls off, so there is no colour to go wrong.
  createGlowTexture() {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
        // The old canvas stops: 1 at the centre, 0.7 at 0.3, 0 at the rim.
        const alpha = r < 0.3 ? 1 - r : Math.max(0, 0.7 * (1 - (r - 0.3) / 0.7));
        data.set([255, 255, 255, Math.round(alpha * 255)], (y * size + x) * 4);
      }
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  createBackTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    const wash = context.createLinearGradient(0, 0, 0, 256);
    wash.addColorStop(0, '#0a2432');
    wash.addColorStop(1, '#050f1a');
    context.fillStyle = wash;
    context.fillRect(0, 0, 512, 256);
    context.textAlign = 'center';
    context.fillStyle = '#f2c94c';
    context.font = '700 30px Rajdhani, sans-serif';
    context.fillText('PUSH YOUR LUCK', 256, 226);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.backTexture = texture;
    return texture;
  }

  // Playfield art. What makes a cabinet look like it has content is graphic design on its
  // surfaces, not polygon count, and graphics are the one thing a 2D canvas is genuinely good at. This is the largest single surface on screen - the camera looks straight down
  // the bed - so it carries most of what the machine looks like, and it is the one place the
  // backdrop's own floor treatment can be quoted directly: dark navy ground, faint gold grid.
  //
  // Orientation is derived, not guessed. BoxGeometry's +Y face is buildPlane('x','z','y',1,1,...)
  // with uv.v = 1 - iy/gridY, and iy = 0 sits at z = -depth/2 - so uv.v = 1 is the machine's FRONT.
  // CanvasTexture defaults to flipY, which samples uv.v = 1 from the image's first row. Therefore
  // canvas y = 0 is the payout edge and canvas y = height is the back panel. Get this backwards
  // and the payout band ends up marking the wall the coins can never reach.
  createDeckTexture() {
    // The plate art's seams are a few pixels wide in the source; at 1024 across 8 units they fall
    // under a pixel and the bed reads as flat colour. The drawn grid never needed more.
    const width = this.quality.lowPower ? 512 : (this.deckPlate ? 2048 : 1024);
    const depth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const height = Math.round((width * depth) / BED_WIDTH);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    // One scale for both axes, so the grid below comes out square rather than stretched.
    const perUnit = width / BED_WIDTH;
    const toX = (x) => (x + BED_WIDTH / 2) * perUnit;
    const toY = (z) => (z - GAME.playfieldFrontZ) * perUnit;

    const wash = context.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, '#0b2530');
    wash.addColorStop(0.5, '#071820');
    wash.addColorStop(1, '#0b2530');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

    if (this.deckPlate) {
      // Plate art instead of the grid: one tile is two plates across, laid against world units like
      // the grid was, so the seams stay square whatever the canvas resolution.
      const plates = context.createPattern(this.deckPlate, 'repeat');
      const scale = (perUnit * DECK_PLATE_TILE) / this.deckPlate.width;
      plates.setTransform(new DOMMatrix().translate(toX(0), toY(0)).scale(scale));
      context.fillStyle = plates;
      context.fillRect(0, 0, width, height);
      // The art is painted a step lighter than PALETTE.felt; keep the bed under the coins.
      context.fillStyle = `rgba(3, 10, 16, ${DECK_PLATE_SHADE})`;
      context.fillRect(0, 0, width, height);
    }

    // The backdrop's floor, quoted: faint gold grid on near-black, every world unit, with every
    // fourth line carried brighter, laid out against world coordinates rather than the texture's
    // own 0..1.
    //
    // It stretches with the bed and that is fine. placeBox scales the mesh rather than rebuilding
    // its geometry, and nothing regenerates this texture, so at the geometry panel's longest bed
    // the cells come out 1 x 1.43 - the same stretch the hexagon and the pinstripes have always
    // taken. Looking down the bed, z is foreshortened hard enough that the stretched cells read
    // closer to square on screen than the true ones do.
    context.lineWidth = Math.max(1, perUnit * 0.012);
    for (let x = -Math.floor(BED_WIDTH / 2); x <= BED_WIDTH / 2 && !this.deckPlate; x += 1) {
      context.strokeStyle = `rgba(242, 201, 76, ${x % 4 === 0 ? 0.17 : 0.075})`;
      context.beginPath();
      context.moveTo(toX(x), 0);
      context.lineTo(toX(x), height);
      context.stroke();
    }
    for (let z = Math.ceil(GAME.playfieldFrontZ); z <= GAME.playfieldBackZ && !this.deckPlate; z += 1) {
      context.strokeStyle = `rgba(242, 201, 76, ${z % 4 === 0 ? 0.17 : 0.075})`;
      context.beginPath();
      context.moveTo(0, toY(z));
      context.lineTo(width, toY(z));
      context.stroke();
    }

    // Watermark hexagon, the same mark the badge and the UI use.
    context.save();
    context.translate(width / 2, height / 2);
    context.beginPath();
    for (let corner = 0; corner < 6; corner += 1) {
      const angle = (Math.PI / 3) * corner - Math.PI / 2;
      const radius = width * 0.3;
      context[corner === 0 ? 'moveTo' : 'lineTo'](radius * Math.cos(angle), radius * Math.sin(angle));
    }
    context.closePath();
    context.strokeStyle = 'rgba(242, 201, 76, 0.13)';
    context.lineWidth = perUnit * 0.08;
    context.stroke();
    context.restore();

    // Lane pinstripes with tick marks: the eye reads them as the machine telling it where coins
    // are supposed to travel, which is most of what playfield art is for. Dimmer than they were,
    // because the grid now carries the structure and two full-strength systems fight.
    for (const x of [width * 0.28, width * 0.72]) {
      context.strokeStyle = 'rgba(242, 201, 76, 0.2)';
      context.lineWidth = perUnit * 0.024;
      context.beginPath();
      context.moveTo(x, height * 0.12);
      context.lineTo(x, height * 0.88);
      context.stroke();
      context.strokeStyle = 'rgba(46, 230, 210, 0.26)';
      for (let tick = 0; tick <= 8; tick += 1) {
        const y = height * 0.12 + (height * 0.76 * tick) / 8;
        context.beginPath();
        context.moveTo(x - perUnit * 0.072, y);
        context.lineTo(x + perUnit * 0.072, y);
        context.stroke();
      }
    }

    // The payout edge, lit. It is the only line on the bed that pays, and until now nothing on the
    // deck said so - the gold front trim marks it from outside the glass, where a player looking
    // down the machine is not looking. Fades back over a coin diameter and a half so it reads as
    // the edge glowing rather than as a painted stripe.
    const lip = context.createLinearGradient(0, 0, 0, perUnit * COIN_RADIUS * 3);
    lip.addColorStop(0, 'rgba(46, 230, 210, 0.5)');
    lip.addColorStop(0.45, 'rgba(46, 230, 210, 0.14)');
    lip.addColorStop(1, 'rgba(46, 230, 210, 0)');
    context.fillStyle = lip;
    context.fillRect(0, 0, width, perUnit * COIN_RADIUS * 3);

    // ponytail: the hazard chevrons that used to band both ends were cut on request - the payout
    // band above marks the lip now. Re-add them here if the edge ever needs the warning.

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // Headboard artwork. ExtrudeGeometry writes UVs straight from the shape's own coordinates, not
  // normalised 0..1, so the panel's UVs run about -w/2..w/2 - without the repeat and offset below
  // the texture tiles several times across it instead of fitting once.
  createHeadboardTexture(width, panelWidth, panelHeight) {
    const height = Math.round((width * panelHeight) / panelWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');

    const wash = context.createLinearGradient(0, 0, 0, height);
    wash.addColorStop(0, '#0b1a2a');
    wash.addColorStop(0.55, '#061220');
    wash.addColorStop(1, '#0a1826');
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

    // Faint hex lattice, so the panel is not a void behind the badge.
    context.strokeStyle = 'rgba(46, 230, 210, 0.09)';
    context.lineWidth = 2;
    const cell = width / 22;
    for (let row = -1; row * cell * 1.5 < height + cell; row += 1) {
      for (let column = -1; column * cell * 1.74 < width + cell; column += 1) {
        const cx = column * cell * 1.74 + (row % 2 ? cell * 0.87 : 0);
        const cy = row * cell * 1.5;
        context.beginPath();
        for (let corner = 0; corner < 6; corner += 1) {
          const angle = (Math.PI / 3) * corner - Math.PI / 2;
          context[corner === 0 ? 'moveTo' : 'lineTo'](cx + cell * Math.cos(angle), cy + cell * Math.sin(angle));
        }
        context.closePath();
        context.stroke();
      }
    }

    context.strokeStyle = 'rgba(242, 201, 76, 0.5)';
    context.lineWidth = Math.max(2, height * 0.016);
    for (const y of [height * 0.14, height * 0.86]) {
      context.beginPath();
      context.moveTo(width * 0.06, y);
      context.lineTo(width * 0.94, y);
      context.stroke();
    }

    context.textAlign = 'center';
    context.fillStyle = 'rgba(238, 247, 251, 0.9)';
    context.font = `700 ${Math.round(height * 0.15)}px Orbitron, sans-serif`;
    context.fillText('COIN PUSHER', width / 2, height * 0.32);
    context.fillStyle = 'rgba(46, 230, 210, 0.85)';
    context.font = `700 ${Math.round(height * 0.085)}px Rajdhani, sans-serif`;
    context.letterSpacing = '10px';
    context.fillText('SILVER HALL · ARCADE', width / 2, height * 0.78);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Negative on U: the panel is extruded towards +Z and the camera sits at -Z, so what it sees
    // is the extrusion's back cap, whose UVs run the other way. Left as positive, the wordmark
    // comes out mirrored. The offset still puts the shape's origin at the texture's centre.
    texture.repeat.set(-1 / panelWidth, 1 / panelHeight);
    texture.offset.set(0.5, 0.5);
    return texture;
  }

  // Surface detail, drawn rather than downloaded. An untextured MeshStandardMaterial is one flat
  // colour at one roughness, which is exactly what reads as unpainted plastic: a large panel gets
  // a single uniform highlight, and nothing in a real machine is uniform. The roughness map does
  // most of the work here; the normal map is derived from the same height field so the streaks
  // that dull a reflection are the ones that catch the light, rather than two unrelated patterns
  // fighting each other.
  // ponytail: box UVs run 0..1 per face, so one repeat cannot be right for a 7-unit bed and a
  // 0.3-unit post at once. Each set is tuned for its biggest consumer and reused as-is elsewhere;
  // split the texture per part only if the density difference ever actually shows.
  buildSurfaceMaps() {
    // Deterministic: a machine that looks slightly different on every reload is a machine whose
    // screenshots cannot be compared.
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Brushed metal for the cabinet: fine streaks along U, which is what breaks a long highlight
    // into something that reads as rolled steel.
    const brushed = this.surfaceMaps(256, 4, 2.4, (context, size) => {
      context.fillStyle = '#8c8c8c';
      context.fillRect(0, 0, size, size);
      for (let stroke = 0; stroke < size * 4; stroke += 1) {
        const shade = Math.round(96 + random() * 104);
        context.strokeStyle = `rgba(${shade},${shade},${shade},0.42)`;
        context.lineWidth = random() < 0.85 ? 1 : 2;
        context.beginPath();
        const y = random() * size;
        context.moveTo(0, y);
        context.lineTo(size, y);
        context.stroke();
      }
    });

    // Playfield deck: panel seams plus a fine grain. The seams are the important half - a groove
    // with a lit edge is the cheapest thing that tells the eye a surface has been built rather
    // than filled in.
    const deck = this.surfaceMaps(256, 3, 3.6, (context, size) => {
      context.fillStyle = '#767676';
      context.fillRect(0, 0, size, size);
      for (let speck = 0; speck < size * 24; speck += 1) {
        const shade = Math.round(104 + random() * 76);
        context.fillStyle = `rgba(${shade},${shade},${shade},0.3)`;
        context.fillRect(random() * size, random() * size, 1, 1);
      }
      context.strokeStyle = '#e2e2e2';
      context.lineWidth = Math.max(2, size / 96);
      for (const offset of [0, size / 2]) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset, size);
        context.moveTo(0, offset);
        context.lineTo(size, offset);
        context.stroke();
      }
    });

    this.surfaces = { brushed, deck };
  }

  // The bed's relief, read off the plate art itself so its grooves sit exactly under the painted
  // seams. surfaceMaps repeats square; the bed's UVs span its own width and depth, so the repeat is
  // reset per axis to one tile every DECK_PLATE_TILE units, matching createDeckTexture.
  // withArt adds the plate art itself as the colour map, for the tray inlays; the bed draws it
  // into its own canvas under the markings instead.
  plateSurfaceMaps(width, depth, withArt = false) {
    if (!this.plateBase) {
      this.plateBase = this.surfaceMaps(1024, 1, 2.4, (context, size) => {
        context.filter = 'grayscale(1)';
        context.drawImage(this.deckPlate, 0, 0, size, size);
      });
      this.plateBase.map = this.artTexture(this.deckPlate);
    }
    const maps = {};
    for (const [key, texture] of Object.entries(this.plateBase)) {
      if (key === 'map' && !withArt) continue;
      // clone() shares the image and the upload; only the repeat is per surface.
      maps[key] = texture.clone();
      maps[key].repeat.set(width / DECK_PLATE_TILE, depth / DECK_PLATE_TILE);
    }
    return maps;
  }

  artTexture(image) {
    const art = new THREE.Texture(image);
    art.colorSpace = THREE.SRGBColorSpace;
    art.wrapS = THREE.RepeatWrapping;
    art.wrapT = THREE.RepeatWrapping;
    art.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    art.needsUpdate = true;
    return art;
  }

  // The tray inlays' surface: plate art where it loaded, the drawn deck grid where it did not.
  // White under the art, because glassTint multiplied into an already-teal image crushes it; the
  // art is painted in that family, so the upper tier keeps its tint either way.
  inlaySurface(width, depth) {
    if (!this.deckPlate) return { ...this.surfaces.deck, color: PALETTE.glassTint };
    return { ...this.plateSurfaceMaps(width, depth, true), color: DECK_PLATE_INLAY_TINT };
  }

  // One height field in, a roughness map and the normal map that agrees with it out.
  surfaceMaps(size, repeat, strength, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    draw(context, size);
    const height = context.getImageData(0, 0, size, size);

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = size;
    normalCanvas.height = size;
    const normalContext = normalCanvas.getContext('2d');
    const normal = normalContext.createImageData(size, size);
    // Wrapped central differences, so the normal map tiles exactly where the height field does.
    // Sampling the red channel only: the height field is greyscale by construction.
    const at = (x, y) => height.data[((((y + size) % size) * size + ((x + size) % size)) * 4)];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = ((at(x + 1, y) - at(x - 1, y)) / 255) * strength;
        const dy = ((at(x, y + 1) - at(x, y - 1)) / 255) * strength;
        const length = Math.hypot(dx, dy, 1);
        const index = (y * size + x) * 4;
        normal.data[index] = (-dx / length) * 127.5 + 127.5;
        normal.data[index + 1] = (-dy / length) * 127.5 + 127.5;
        normal.data[index + 2] = (1 / length) * 127.5 + 127.5;
        normal.data[index + 3] = 255;
      }
    }
    normalContext.putImageData(normal, 0, 0);

    const roughnessMap = new THREE.CanvasTexture(canvas);
    const normalMap = new THREE.CanvasTexture(normalCanvas);
    for (const texture of [roughnessMap, normalMap]) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat, repeat);
    }
    return { roughnessMap, normalMap };
  }

  addStaticBox(width, height, depth, x, y, z, color, options = {}) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({
        color,
        roughness: options.roughness ?? 0.78,
        metalness: options.metalness ?? 0.16,
        roughnessMap: options.roughnessMap ?? null,
        normalMap: options.normalMap ?? null,
        envMap: options.envMap ?? null,
        envMapIntensity: options.envMapIntensity ?? 1,
        emissive: options.emissive ?? 0x000000,
        emissiveIntensity: options.emissiveIntensity ?? 0,
        map: options.map ?? null,
      }),
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = this.quality.shadows && Boolean(options.receiveShadow);
    this.scene.add(mesh);
    if (!options.visualOnly) {
      const collisionWidth = options.collisionWidth ?? width;
      const collisionHeight = options.collisionHeight ?? height;
      const collisionDepth = options.collisionDepth ?? depth;
      const half = { x: collisionWidth / 2, y: collisionHeight / 2, z: collisionDepth / 2 };
      const body = this.world.addStaticBox(half, {
        x: options.collisionX ?? x,
        y: options.collisionY ?? y,
        z: options.collisionZ ?? z,
      });
      mesh.userData.collisionHalf = half;
      // layoutGeometry() moves these again when a geometry slider does; it needs the collider and
      // the offsets it was built with, and nothing else keeps a static body reachable.
      mesh.userData.body = body;
      mesh.userData.collisionHalfZ = collisionDepth / 2;
      mesh.userData.collisionZOffset = (options.collisionZ ?? z) - z;
    }
    return mesh;
  }

  // The fixed rear deck reaches from the moving tray's back edge at full extension to the back
  // panel, and a long tray on a short bed reaches the panel on its own - leaving this nothing to
  // cover, or less than nothing. It stays a real box at a sliver's depth either way - a negative
  // half extent would turn the box inside out and let coins fall straight through it - and the
  // mesh is hidden so the sliver is not a bright seam under the tray.
  static rearDeckSpan() {
    const front = GAME.pusherOriginZ - GAME.pusherAmplitude
      + GAME.pusherDepth / 2 + GAME.pusherRearExtension - 0.15;
    const span = GAME.playfieldBackZ - 0.05 - front;
    return {
      centre: front + span / 2,
      depth: Math.max(span, 0.02),
      inlayDepth: Math.max(span - 0.12, 0.02),
      covers: span > 0.02,
    };
  }

  // Move, and optionally restretch, one box along Z. Depth is baked into BoxGeometry, so the
  // stretch rides on scale.z against the depth the part was built with, and the static collider
  // addStaticBox left on the mesh follows by the same factor.
  placeBox(mesh, z, depth) {
    const built = mesh.geometry.parameters?.depth;
    mesh.position.z = z;
    const stretch = depth && built ? depth / built : 1;
    if (depth && built) mesh.scale.z = stretch;
    const body = mesh.userData.body;
    if (!body) return;
    body.setPose({ ...body.position, z: z + mesh.userData.collisionZOffset });
    if (depth && built) {
      body.collider.setHalfExtents({ ...mesh.userData.collisionHalf, z: mesh.userData.collisionHalfZ * stretch });
    }
  }

  // Re-place every part the geometry panel owns, from whatever GAME currently holds. Called once
  // at the end of buildMachine and again on each slider move; the build's own literals are the
  // sizes the geometry was baked at, and only this decides where anything ends up.
  layoutGeometry() {
    const front = GAME.playfieldFrontZ;
    const back = GAME.playfieldBackZ;
    const depth = back - front;
    const centre = (back + front) / 2;

    this.placeBox(this.bed, centre, depth);
    this.placeBox(this.backPanel, back + 0.05);
    this.placeBox(this.frontTrim, frontTrimZ());
    for (const glass of this.glassPanes) this.placeBox(glass, centre, depth + 0.2);
    for (const bar of this.neonBars) this.placeBox(bar, centre, depth + 0.2);
    for (const { mesh, offset } of this.chuteParts) this.placeBox(mesh, chuteZ() + offset);
    for (const { mesh, front: isFront } of this.shellPosts) {
      mesh.position.z = isFront ? front + 0.1 : back - 0.1;
    }
    for (const skirt of this.shellSkirts) this.placeBox(skirt, centre, depth - 0.2);
    for (const { mesh, offset } of this.headboardParts) mesh.position.z = back + offset;
    // The cabinet model is fitted to the playfield's centre, so it travels with it, and it
    // stretches with the bed's length: a fixed-size machine standing around a longer playfield
    // is a bed growing out through its own front panel. Scale 1 is the default length, which is
    // the length the model was hand-fitted against.
    if (this.cabinet) {
      this.cabinet.position.z = centre;
      this.cabinet.scale.z = depth / CABINET_BED_LENGTH;
    }

    // Moving deck: the blade end is fixed to the centre, the rear tail carries the length.
    const deckDepth = GAME.pusherDepth + GAME.pusherRearExtension;
    const deckCentre = GAME.pusherRearExtension / 2;
    for (const { mesh, inset } of this.trayParts) this.placeBox(mesh, deckCentre, deckDepth - inset);
    if (this.pusherDeckShape) {
      this.pusherDeckShape.setHalfExtents({ ...this.pusherDeckShape.halfExtents(), z: deckDepth / 2 });
      this.pusherDeckShape.setTranslationWrtParent({ x: 0, y: GAME.upperTrayY, z: deckCentre });
    }

    const rear = CoinPusher.rearDeckSpan();
    this.rearDeck.visible = rear.covers;
    this.rearDeckTop.visible = rear.covers;
    this.placeBox(this.rearDeck, rear.centre, rear.depth);
    this.placeBox(this.rearDeckTop, rear.centre, rear.inlayDepth);

    this.placeBox(this.scraper, GAME.scraperZ);
    this.placeBox(this.scraperStrip, GAME.scraperZ - 0.02);
  }

  // The geometry panel's commit. Everything lands at once - meshes, colliders and the payout
  // edge - because a machine whose collision does not match what it looks like is worse than a
  // frame of visible stretch. `reseed` is the drag's release: coins settled against the old
  // layout can be pinched by a moved part or left hanging over a gap, so the pile is rebuilt.
  setMachineGeometry(patch, { reseed = false } = {}) {
    this.geometry = applyMachineGeometry({ ...this.geometry, ...patch });
    this.layoutGeometry();
    if (reseed) this.resetPile();
    return this.geometry;
  }

  // Rounded-rectangle profile shared by the headboard and its glow frame.
  static roundedRect(width, height, radius) {
    const shape = new THREE.Shape();
    const w = width / 2;
    const h = height / 2;
    shape.moveTo(-w + radius, -h);
    shape.lineTo(w - radius, -h);
    shape.quadraticCurveTo(w, -h, w, -h + radius);
    shape.lineTo(w, h - radius);
    shape.quadraticCurveTo(w, h, w - radius, h);
    shape.lineTo(-w + radius, h);
    shape.quadraticCurveTo(-w, h, -w, h - radius);
    shape.lineTo(-w, -h + radius);
    shape.quadraticCurveTo(-w, -h, -w, -h + radius);
    return shape;
  }

  createBackdropTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, '#030710');
    gradient.addColorStop(0.46, '#06182a');
    gradient.addColorStop(0.62, '#0b3b46');
    gradient.addColorStop(0.78, '#061a28');
    gradient.addColorStop(1, '#030710');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 512);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  createBadgeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    const hexagon = (radius) => {
      context.beginPath();
      for (let corner = 0; corner < 6; corner += 1) {
        const angle = (Math.PI / 3) * corner - Math.PI / 2;
        const method = corner === 0 ? 'moveTo' : 'lineTo';
        context[method](128 + radius * Math.cos(angle), 128 + radius * Math.sin(angle));
      }
      context.closePath();
    };
    const fill = context.createLinearGradient(0, 0, 256, 256);
    fill.addColorStop(0, '#2ee6d2');
    fill.addColorStop(0.55, '#00c8b4');
    fill.addColorStop(1, '#3b4fd8');
    hexagon(112);
    context.fillStyle = fill;
    context.fill();
    hexagon(112);
    context.strokeStyle = '#f2c94c';
    context.lineWidth = 9;
    context.stroke();
    context.fillStyle = '#041018';
    context.font = '700 92px Orbitron, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('CP', 128, 134);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  // The room the cabinet stands in: graded sky, wet-looking floor, corridor light columns.
  buildBackdrop() {
    this.scene.background = this.createBackdropTexture();
    this.addHall();

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({
        color: PALETTE.shellDeep,
        metalness: 0.92,
        roughness: 0.24,
        envMap: this.environmentTexture,
        envMapIntensity: 0.7,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.78;
    floor.receiveShadow = this.quality.shadows;
    this.scene.add(floor);

    // Pool of light the cabinet sits in — additive so it never darkens the floor.
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 22),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: PALETTE.goldSoft,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, -2.74, -0.5);
    this.scene.add(pool);

    const grid = new THREE.GridHelper(64, 32, PALETTE.gold, PALETTE.gold);
    grid.position.y = -2.76;
    Object.assign(grid.material, { transparent: true, opacity: 0.07, depthWrite: false });
    this.scene.add(grid);

  }

  // Optional cabinet shell, standing in for the procedural furniture. Absent is a supported state
  // and must stay cheap and quiet: a missing file is not an error, it just means the procedural
  // cabinet keeps its job.
  //
  // The model is generated, not downloaded - tools/build_cabinet.py authors it at the world origin
  // the mount expects, in the palette the rest of the machine already uses, and with its emissive
  // trim baked in. That is why nothing here fits, rotates, hides or re-lights it: the apparatus
  // that did all four is gone, and tests/cabinet.test.js is what keeps the model honest enough to
  // not need it back. Rebuild with:
  //   /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_cabinet.py
  //
  // Only the furniture is replaced. The bed, glass, tray, scraper and rails stay exactly where
  // they are, because their positions are the physics - a model cannot take those over without
  // every collision body moving with it, and then the machine plays differently than it looks.
  async loadCabinet() {
    let model;
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      model = await new GLTFLoader().loadAsync('models/cabinet.glb');
    } catch {
      return; // no cabinet.glb - procedural furniture stands
    }
    const cabinet = model.scene;
    // scene.environment is never set: loadCoinEnvironment only builds the PMREM texture, and every
    // material is handed it one at a time with its own intensity. A model that skips this pass has
    // no reflection at all - and reflection is the shell's entire look, a near-black polished body
    // that is only legible by what it reflects.
    cabinet.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = this.quality.shadows;
      object.receiveShadow = this.quality.shadows;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material || material.envMap || material.transparent) continue;
        material.envMap = this.environmentTexture;
        material.envMapIntensity = 0.55;
        material.needsUpdate = true;
      }
    });
    // An unrotated parent, purely so the geometry panel can stretch the machine along world Z.
    // The stretch is close to free from where the player sits: the camera looks down Z, so the
    // front elevation, which is all the artwork anyone reads, keeps its proportions however deep
    // the machine gets. What it is not free of is the front face - see build_cabinet.py on why
    // that face is pinned to the bed's front lip rather than standing proud of it.
    const mount = new THREE.Group();
    mount.add(cabinet);
    this.scene.add(mount);
    this.cabinet = mount;
    // The mount carries the playfield's centre and length, and buildMachine's layout pass has
    // already been and gone by the time a cabinet finishes loading - so run it again rather than
    // placing the mount here and having two places that decide where the machine stands.
    this.layoutGeometry();

    // Two exceptions to hiding the procedural furniture. The side glass is already tuned - opacity
    // 0.15 over envMapIntensity 0.45 - and the model deliberately stops 0.3 short of it rather
    // than reproduce it. The payout chute is placed off chuteZ() in world space instead of riding
    // the mount, so a model part cannot follow it: at the longest bed the two would sit about 1.2
    // apart. All of the chute is below the frame's bottom edge either way.
    const keep = new Set([...this.glassPanes, ...this.chuteParts.map((part) => part.mesh)]);
    for (const mesh of this.decor) if (!keep.has(mesh)) mesh.visible = false;

    // Bring the mechanical surfaces into the shell's lighting instead of re-colouring them. Two
    // adjustments, both fixing something specific:
    //
    // envMap, because none of these five ever had one. Every part of the shell does (the traverse
    // above), so without it the tray, its inlay, the blade and the scraper are the only unlit,
    // unreflective things in the machine, and they read as flat plastic parked inside polished
    // metal. This is the whole of what "looks pasted on" meant.
    //
    // emissive off, because the scraper carries gold at 0.35. Against procedural furniture that
    // reads as a lit guard rail; against a near-black shell it is the brightest surface in the
    // machine and reads as a painted mustard board.
    //
    // What is deliberately NOT touched is their colour. The tray inlay and the rear deck are
    // glassTint, the same family the bed's drawn deck texture sits in, and that shared tint is
    // what separates the upper tier from the lower one. Re-skinning all five in one dark metal
    // does fix both complaints and takes the tier read with it - the machine goes uniformly black.
    // Emissive parts that animate. glTF shares one material across every mesh that uses it, so
    // each of these needs its own copy or the whole set pulses in lockstep - the same trap the old
    // cabinetGlow pass documented. Node transforms are all applied in the build script, so the
    // geometry's own bounding box is already in model-local coordinates.
    // The balustrades' signal lamps, one per bay, chase from the player's end to the back in step
    // with the board's marquee. Each gets its own material to light on its own; the export folded
    // the authored strength into the colour, so the emissive colour is reset to full mint here.
    this.fenceLamps = [];
    cabinet.traverse((object) => {
      const match = object.isMesh && /^fence_lamp_(\d+)_[LR]$/.exec(object.name);
      if (!match) return;
      object.material = object.material.clone();
      object.material.emissive.set(PALETTE.mint);
      object.material.emissiveIntensity = FENCE_LAMP_IDLE;
      this.fenceLamps.push({ material: object.material, bay: Number(match[1]) });
    });

    for (const mesh of this.shellSurfaces) {
      mesh.material.envMap = this.environmentTexture;
      mesh.material.envMapIntensity = 0.55;
      mesh.material.emissiveIntensity = 0;
      mesh.material.needsUpdate = true;
    }
  }

  // Fit a downloaded prop by its own X extent and re-origin it so the group's position means
  // "centred here, standing on here" - which is the only thing the callers below want to say.
  fitProp(source, width) {
    const prop = source.clone(true);
    prop.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(prop);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.x > 0 ? width / size.x : 1;
    prop.scale.setScalar(scale);
    const centre = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
    prop.position.set(-centre.x, -box.min.y * scale, -centre.z);
    prop.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = this.quality.shadows;
      object.receiveShadow = this.quality.shadows;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material || material.envMap || material.transparent) continue;
        material.envMap = this.environmentTexture;
        material.envMapIntensity = 0.55;
        material.needsUpdate = true;
      }
    });
    const group = new THREE.Group();
    group.add(prop);
    return group;
  }

  // Bonus stage: the slot machine at the top of the machine, and the chest that drops into the tray
  // to start it. The slot is pure decoration; the chest is a real body in the world.
  buildBonusStage() {
    this.chests = [];
    this.pendingChests = [];
    this.waitingChests = [];
    this.chestPool = [];
    // Chests waiting for the reels. One chest, one spin - see spinSlot.
    this.slotQueue = [];
    this.slotHold = 0;
    this.coinRain = null;
    this.quake = null;
    if (this.chestModelSource) {
      // Kept off the scene as the template every dropped chest is cloned from - a chest takes over
      // two minutes to ride the machine, so several are in flight whenever thresholds come close.
      this.chestPrototype = this.fitProp(this.chestModelSource, GAME.chestWidth);
      const size = new THREE.Box3().setFromObject(this.chestPrototype).getSize(new THREE.Vector3());
      // fitProp stands the model on the group's origin; a physics body's origin is its centre. Sink
      // the model half its height inside the group and the group can track the body's pose
      // directly, tumbling included.
      this.chestPrototype.children[0].position.y -= size.y / 2;
      this.chestHalfExtents = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
      this.chestHalfHeight = size.y / 2;
      this.chestHalfDepth = size.z / 2;
    }
    if (!this.slotModelSource) return;
    const slot = this.fitProp(this.slotModelSource, GAME.slotWidth * GAME.slotScale);
    // It hangs in the air over the front of the machine, so the key light dropped its whole
    // footprint onto the middle of the bed as a hard black block with nothing visibly above it.
    slot.traverse((object) => { object.castShadow = false; });
    slot.rotation.y = GAME.slotYaw;
    slot.position.set(0, GAME.slotY, GAME.slotZ);
    this.scene.add(slot);
    this.slotMesh = slot;

    // The readout goes over the model's own three reel windows, which are blank panes: find them by
    // material and take their footprint, so the panel keeps fitting if slotWidth or slotY move.
    const windows = new THREE.Box3();
    slot.updateMatrixWorld(true);
    slot.traverse((object) => {
      if (object.isMesh && object.material?.name === GAME.slotReelMaterial) {
        windows.union(new THREE.Box3().setFromObject(object));
      }
    });
    if (windows.isEmpty()) return;

    // Three real drums turning behind the window, each a cylinder lying on its side with the
    // symbols wrapped round it. Each axis sits a little behind the window's plane, sized so the
    // drum's chord there is exactly the window's height: what protrudes in front stays inside the
    // window outline, and the curvature, the lighting falling off top and bottom and a symbol
    // rolling away round the edge are all real rather than painted.
    const size = windows.getSize(new THREE.Vector3());
    // The model's own reel panes are flat and opaque; the drums stand where they were.
    slot.traverse((object) => {
      if (object.isMesh && object.material?.name === GAME.slotReelMaterial) object.visible = false;
    });
    // ponytail: 1.0x (flatter) pokes the drums out below the window from the player's low eye.
    const radius = size.y * 0.75;
    const depth = Math.sqrt(radius ** 2 - (size.y / 2) ** 2);
    const stripCanvas = document.createElement('canvas');
    stripCanvas.width = 512 * DRUM_FACES.length;
    stripCanvas.height = 472;
    const paintStrip = (images) => drawReelStrip(stripCanvas.getContext('2d'), DRUM_FACES, {
      palette: PALETTE, turn: DRUM_TEXTURE_TURN, images,
    });
    paintStrip();
    const strip = new THREE.CanvasTexture(stripCanvas);
    strip.colorSpace = THREE.SRGBColorSpace;
    strip.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // The artwork arrives after the machine is up; until then (or if a file is missing) the drums
    // carry the drawn marks, so the slot is never blank.
    Promise.all(DRUM_FACES.map((face) => new THREE.ImageLoader().loadAsync(REEL_IMAGE_FILES[face])
      .then((image) => [face, trimmedArt(image)], () => [face, null])))
      .then((loaded) => {
        paintStrip(Object.fromEntries(loaded.filter(([, image]) => image)));
        strip.needsUpdate = true;
      });
    this.reelMaterial = new THREE.MeshStandardMaterial({
      map: strip, roughness: 0.75, metalness: 0,
    });
    // One group for the readout: drums, a dark well behind them and the bezel. Its +Z faces the
    // player and +X is the player's right.
    const panel = new THREE.Group();
    const drumWidth = (size.x / 3) * 0.9;
    const drumGeometry = new THREE.CylinderGeometry(radius, radius, drumWidth, 48, 1, false).rotateZ(Math.PI / 2);
    this.reelDrums = [-1, 0, 1].map((column) => {
      const drum = new THREE.Mesh(drumGeometry, this.reelMaterial);
      drum.position.set(column * (size.x / 3), 0, -depth);
      panel.add(drum);
      return drum;
    });
    const well = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y * 1.6, 0.02),
      new THREE.MeshBasicMaterial({ color: PALETTE.shellDeep }),
    );
    well.position.z = -depth - radius - 0.02;
    panel.add(well);
    // Three question marks until a chest pays: the machine must not sit there displaying a win it
    // has not paid yet. They stay on the winning symbol afterwards, as a real one does.
    this.reelSymbols = [GAME.slotIdleSymbol, GAME.slotIdleSymbol, GAME.slotIdleSymbol];
    const centre = windows.getCenter(new THREE.Vector3());
    panel.position.set(centre.x, centre.y, windows.min.z - 0.01);
    panel.rotation.y = Math.PI;
    this.scene.add(panel);
    this.reelPanel = panel;
    this.drawReels();
    // A brass bezel round the window, so the reels sit in a fitted instrument case rather than on
    // the model's flat pane. Built on the panel (whose +Z faces the player) to travel with it.
    const brass = new THREE.MeshStandardMaterial({
      ...BRASS, ...this.surfaces.brushed, color: PALETTE.gold, envMap: this.environmentTexture,
      emissive: new THREE.Color(PALETTE.gold), emissiveIntensity: 0,
    });
    // A win lights the bezel, not the drums: glow over the artwork washes it out.
    this.reelBezel = brass;
    const bar = Math.min(size.x, size.y) * 0.06;
    for (const [w, h, x, y] of [
      [size.x + bar * 2, bar, 0, size.y / 2 + bar / 2], [size.x + bar * 2, bar, 0, -size.y / 2 - bar / 2],
      [bar, size.y, size.x / 2 + bar / 2, 0], [bar, size.y, -size.x / 2 - bar / 2, 0],
    ]) {
      const piece = new THREE.Mesh(new RoundedBoxGeometry(w, h, bar * 0.8, 2, bar * 0.25), brass);
      piece.position.set(x, y, bar * 0.2);
      panel.add(piece);
    }
  }

  // A drum's angle during a spin, off the spin clock (drumAngleAt).
  reelAngle(index, spin) {
    const locks = GAME.slotReelLocks;
    return drumAngleAt({
      start: spin.startAngles[index],
      target: drumAngleFor(spin.faces[index]),
      elapsed: spin.elapsed,
      lockAt: locks[index],
      // Each drum at its own pace, or the two still turning roll past in lock-step.
      speed: 8 + index * 1.2,
      ...(index === locks.length - 1 ? { settle: GAME.slotLastSettle } : {}),
    });
  }

  // Poses the drums: during a spin from the spin clock, otherwise on the faces shown.
  drawReels() {
    if (!this.reelDrums) return;
    const spin = this.slotSpin;
    this.reelDrums.forEach((drum, index) => {
      const angle = spin ? this.reelAngle(index, spin) : drumAngleFor(this.reelSymbols[index]);
      drum.rotation.x = DRUM_DIRECTION * angle;
    });
    // A finished spin only, and never the idle face: three of a kind lights the drums gold.
    const win = !spin && this.reelSymbols[0] !== GAME.slotIdleSymbol && slotWin(this.reelSymbols) !== null;
    this.reelWin = win;
    if (this.reelBezel) this.reelBezel.emissiveIntensity = win ? 0.6 : 0;
  }



  // A chest body and its model, pooled: retired chests come back rather than rebuilding the clone.
  acquireChest() {
    const pooled = this.chestPool.pop();
    if (pooled) return pooled;
    const mesh = this.chestPrototype.clone(true);
    mesh.visible = false;
    this.scene.add(mesh);
    // Its own material, at GAME.chestFrictionScale times the coin's friction: a box on the coin's
    // grip slides off the bed on the payout tilt alone.
    const body = this.world.addDynamicBox(this.chestHalfExtents, {
      mass: GAME.chestMass,
      linearDamping: GAME.chestLinearDamping,
      angularDamping: GAME.chestAngularDamping,
    });
    const chest = { body, mesh, drop: null };
    // Touchdown is whatever it hits first - the tray, or the coins already on it. It is dust
    // only: the prize is paid when the chest falls off the front, not when it lands.
    body.onContact = () => {
      if (!chest.drop || chest.drop.landed) return;
      chest.drop.landed = true;
      const { x, y, z } = body.position;
      this.emitParticles(x, y, z, 14, true);
    };
    return chest;
  }

  // Random across the tray, re-rolled while it would land on a chest already sitting at the drop
  // line: one payout can clear two thresholds, and two boxes spawned inside each other in the same
  // frame shove one another out of the machine.
  chestDropX() {
    const clear = (x) => this.chests.every(({ body }) => Math.abs(body.position.x - x) > GAME.chestWidth
      || Math.abs(body.position.z - chestDropZ(this.chestHalfDepth)) > 2 * this.chestHalfDepth);
    let x = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      x = (Math.random() * 2 - 1) * CHEST_DROP_HALF_WIDTH;
      if (clear(x)) break;
    }
    return x;
  }

  // Drop a bonus chest into the tray. It then rides the machine like a coin - swept off the tray
  // onto the lower bed, shoved forward by the blade, over the payout lip - and `onWin` fires once,
  // when the reels have spun after it has fully dropped - three of a kind pays, a miss does not. A chest still on the machine has paid
  // nothing yet.
  dropChest(onWin) {
    if (!this.chestPrototype) return false;
    // Won while a pile is settling: it would ride the remaining settle steps at many times game
    // speed. Held until settlePile() finishes, which drops it then.
    if (this.settling) {
      this.pendingChests.push(onWin);
      return true;
    }
    // A full machine queues the chest; retireChest drops it when one leaves.
    if (this.chests.length >= GAME.chestsOnMachine) {
      this.waitingChests.push(onWin);
      return true;
    }
    const chest = this.acquireChest();
    const { body } = chest;
    body.setEnabled(true);
    body.setPose(
      { x: this.chestDropX(), y: GAME.chestStartY, z: chestDropZ(this.chestHalfDepth) },
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2),
    );
    body.setAngularVelocity({ x: 0, y: 1.8, z: 0 });
    chest.mesh.visible = true;
    // Only once it is really in the world: a chest held through a pile settle tells the player
    // when it lands, not when it was won.
    this.callbacks?.onChestDrop?.();
    chest.drop = {
      landed: false,
      lowerBedLanded: false,
      falling: false,
      counted: false,
      onWin,
    };
    this.chests.push(chest);
    return true;
  }

  // Take one chest out of the world and back into the pool.
  retireChest(index) {
    const chest = this.chests[index];
    if (!chest) return;
    chest.body.setEnabled(false);
    chest.mesh.visible = false;
    chest.drop = null;
    this.chests.splice(index, 1);
    this.chestPool.push(chest);
    if (this.waitingChests.length > 0 && !this.settling) this.dropChest(this.waitingChests.shift());
  }

  cancelChest() {
    // The queues first: retiring a chest drops the next waiting one, which a cancel must not do.
    this.pendingChests = [];
    this.waitingChests = [];
    for (let index = this.chests.length - 1; index >= 0; index -= 1) this.retireChest(index);
    this.slotSpin = null;
    this.slotQueue = [];
    this.coinRain = null;
    this.quake = null;
    this.camera.position.copy(this.cameraBase);
  }

  // Money-bag payout: coins burst from the top of the pin board and rain down through it. Returns how many were scheduled, which is
  // what the HUD announces - a rain arriving on top of one still running just adds to the queue.
  rainCoins(count = GAME.coinRainCount) {
    this.coinRain = { remaining: (this.coinRain?.remaining ?? 0) + count, timer: 0 };
    return count;
  }

  updateCoinRain(delta) {
    const rain = this.coinRain;
    if (!rain) return;
    rain.timer -= delta;
    // Bounded by remaining, so a long frame catches up rather than dropping coins on the floor.
    while (rain.remaining > 0 && rain.timer <= 0) {
      rain.timer += GAME.coinRainInterval;
      rain.remaining -= 1;
      // Thrown out to either side and up from the dropper, so the stream fans out over the top row of
      // pins like scattered petals before the board takes it - and still lands through its exit.
      const side = Math.random() < 0.5 ? -1 : 1;
      this.sendDownBoard({
        x: (Math.random() - 0.5) * 0.6,
        y: DROP_START_Y,
        vx: side * (GAME.coinRainSpread[0] + Math.random() * (GAME.coinRainSpread[1] - GAME.coinRainSpread[0])),
        vy: GAME.coinRainLift[0] + Math.random() * (GAME.coinRainLift[1] - GAME.coinRainLift[0]),
        ceiling: DROP_START_Y + GAME.coinRainHeadroom,
      }, Math.random() < GAME.premiumChance);
    }
    if (rain.remaining <= 0) this.coinRain = null;
  }

  // Gild payout: turns the coins gildTargets picked. Returns how many changed, which is what the
  // HUD announces and, on an empty machine, is legitimately zero.
  gildCoins(ratio = GAME.gildRatio) {
    const gilded = gildTargets(this.activeCoins, ratio);
    for (const coin of gilded) {
      coin.isPremium = true;
      coin.mesh.material = this.coinMaterials.premium;
    }
    return gilded.length;
  }

  // Earthquake payout. Overlapping quakes extend rather than stack: two events shaking the same
  // pile twice as hard would fire coins into the glass.
  shakeTable(seconds = GAME.quakeSeconds) {
    this.quake = { remaining: Math.max(this.quake?.remaining ?? 0, seconds) };
    return seconds;
  }

  updateQuake(delta) {
    const quake = this.quake;
    if (!quake) return;
    quake.remaining -= delta;
    for (const coin of this.activeCoins) {
      // A counted coin is already down the chute; shaking it only fights its recycle.
      if (coin.counted) continue;
      const kick = quakeKick();
      const v = coin.body.velocity;
      coin.body.setVelocity({ x: v.x + kick.x * delta, y: v.y + kick.y * delta, z: v.z + kick.z * delta });
    }
    // reducedMotion drops the camera work and keeps the physics, the same rule the neon follows.
    if (!this.quality.reducedMotion) {
      // Decaying, so the shake settles instead of stopping dead on the last frame.
      const amount = GAME.quakeCameraShake * Math.min(1, quake.remaining / GAME.quakeSeconds);
      this.camera.position.set(
        this.cameraBase.x + (Math.random() - 0.5) * amount,
        this.cameraBase.y + (Math.random() - 0.5) * amount,
        this.cameraBase.z,
      );
    }
    if (quake.remaining > 0) return;
    this.quake = null;
    this.camera.position.copy(this.cameraBase);
  }

  updateBonus(delta) {
    this.updateCoinRain(delta);
    this.updateQuake(delta);
    // Backwards, because a retired chest is spliced out of the list.
    for (let index = this.chests.length - 1; index >= 0; index -= 1) {
      const { body, mesh, drop } = this.chests[index];
      body.lerpPose(this.world.alpha, mesh.position, mesh.quaternion);
      // The same phases a coin runs through: over the lip, then paid once it is under the bed.
      // ponytail: no hold timer. A chest lives until it drops - chestWidth is kept under what the
      // scraper can clear (tests/physics.test.js) and the blade spans the whole bed, so nothing
      // can park out of its reach.
      settleChestOnLowerBed(body, drop, this.chestHalfHeight, this.chestHalfDepth);
      const phase = coinPhase(drop, body.position);
      if (phase === 'cross') {
        drop.falling = true;
        // The chest gets the same nudge a coin does. It used to be left to the pile, and a chest
        // balanced on the lip - eight times a coin's friction, 0.9 damping - is exactly what the
        // pile cannot shift: its centre of mass is still over the bed, so it does not even tip.
        nudgeOverLip(body);
      }
      // coinPhase keeps answering 'cross' for a chest wedged past the lip, so this counts every frame.
      if (drop.falling && !drop.counted) drop.fallingFor = (drop.fallingFor ?? 0) + delta;
      // Over the lip pays once it is below the deck, as it does for a coin (coinFallPhase), or once
      // it has been over for CHEST_WEDGE_SECONDS. Waiting for trayY alone left chests wedged on the
      // chute's side (y -1.03) and between the lip and the fascia: never paid, never retired, each
      // holding one of the chestsOnMachine slots while every later chest queued behind them.
      if (!drop.counted && (phase === 'score' || (drop.falling
        && (body.position.y < NATURAL_FALL_Y || drop.fallingFor > CHEST_WEDGE_SECONDS)))) {
        drop.counted = true;
        drop.retireIn = CHEST_RETIRE_SECONDS;
        const { x, z } = body.position;
        this.emitParticles(x, GAME.trayY, z, 18, true);
        this.spinSlot(drop.onWin);
      }
      if (drop.counted) drop.retireIn -= delta;
      // Paid or not, it leaves the world down the chute rather than blinking out at the tray line -
      // or, if it lodges on the way, a moment after it paid.
      if (phase === 'lost' || body.position.y < GAME.lostY || drop.retireIn <= 0) this.retireChest(index);
    }

    const spin = this.slotSpin;
    if (!spin) {
      // Between two chests' spins: hold the finished faces long enough to read them, then take
      // the next chest off the queue. Nothing to hold for while the queue is empty.
      if (this.slotQueue.length === 0) return;
      this.slotHold -= delta;
      if (this.slotHold <= 0) this.startSpin(this.slotQueue.shift());
      return;
    }
    const locks = GAME.slotReelLocks;
    const last = locks.length - 1;
    const previous = spin.elapsed;
    spin.elapsed += delta;
    // The drums turn off the spin clock and lock left to right, the last on the final beat - see
    // drumAngleAt. The faces only count once the spin is over.
    this.drawReels();
    for (const index of reelsLockedBetween(previous, spin.elapsed, locks)) {
      this.callbacks?.onReelStop?.(index, index === last);
    }
    // Once the others have locked, the last drum ticks past each face as it crawls in, so the
    // ticks slow with it. Read off the drum itself rather than scheduled ahead, so a dropped frame
    // or a closed hinge cannot put the sound out of step with what is on screen.
    if (spin.elapsed > locks[last - 1] && spin.elapsed < locks[last]) {
      const step = Math.floor(this.reelAngle(last, spin) / DRUM_STEP);
      if (spin.lastStep !== undefined && step !== spin.lastStep) this.callbacks?.onReelTick?.();
      spin.lastStep = step;
    }
    if (spin.elapsed < locks[last]) return;
    // Cleared before the last redraw, because that is what turns the glow on - see drawReels.
    this.slotSpin = null;
    this.reelSymbols = spin.faces;
    this.drawReels();
    const win = slotWin(spin.faces);
    // Confetti on a win only - a miss gets the reels it earned and nothing else.
    if (win !== null) {
      const reel = this.reelPanel.getWorldPosition(new THREE.Vector3());
      // As many sparks as the pool holds, up to a burst that reads from across the machine.
      this.emitParticles(0, reel.y, reel.z, Math.min(48, this.particles?.length ?? 48), true);
      this.lampRaceAt = this.elapsed;
    }
    this.slotHold = GAME.slotHoldSeconds;
    spin.notify?.(win);
  }

  // onResult is called with the slotWin result - the symbol three reels showed, or null.
  spinSlot(onResult) {
    if (!this.reelDrums) {
      onResult?.(slotWin(rollSlotResult()));
      return;
    }
    // One chest, one spin. A second chest paying while the reels are still turning queues up and
    // spins for itself once they stop: it rode the whole machine to earn that spin, and two chests
    // sharing one set of faces reads as the machine paying twice for a single result.
    if (this.slotSpin || this.slotQueue.length > 0) {
      this.slotQueue.push(onResult);
      return;
    }
    this.startSpin(onResult);
  }

  startSpin(notify) {
    this.slotSpin = {
      elapsed: 0,
      faces: rollSlotResult(),
      notify,
      // Where each drum stands now, so the spin rolls on from it.
      startAngles: this.reelSymbols.map((face) => drumAngleFor(face)),
    };
  }

  // Matte-painted casino hall. The camera never moves, so one unlit plane is the entire set - no
  // side walls, no room geometry, nothing lit.
  //
  // The numbers below are one derivation, not a set of knobs. Given the camera (9.2 up, 10.4 back,
  // 56° fov, 39° pitch) the frame's top ray meets the HALL_Z plane 5.13 above the floor, so the
  // strip of the painting the player can ever see is the 7.91 units from the real floor at -2.78
  // up to there. HALL_HORIZON is where the painting's own horizon sits, measured from the bottom
  // of the image, and the plane is sized and sunk so that line lands exactly on the real floor:
  //   height >= 7.91 / (1 - HALL_HORIZON)   and   y = -2.78 + height * (0.5 - HALL_HORIZON)
  // Height is taken above that minimum on purpose - it is what widens the plane, and at the bare
  // minimum the plane is only as wide as the frame, so a wide window shows past its edges.
  // Re-solve all of it together after touching the camera or swapping the art; if the painted
  // horizon drifts off the real floor line the whole illusion goes with it.
  addHall() {
    const HALL_Z = 11;
    const HALL_ASPECT = 2.334;
    // Measured off the art, not guessed: the row where the corridor converges.
    const HALL_HORIZON = 0.51;
    // Where that row goes: at the camera's own eye height. The art is an eye-level photograph,
    // and a horizon always sits at the viewer's eye. It used to sit on the hall floor, 8.2 below
    // the camera, which put the corridor's vanishing point about 22 degrees under where this
    // camera's real horizon is - the hall read as photographed from the floor while the player
    // looks down into the machine from above it, a flat poster stood up behind the cabinet.
    const HALL_EYE_Y = this.camera.position.y;
    // Above the 12.9 minimum on purpose, and not only for the width. Scaling the plane up moves
    // the visible band down the painting: at the minimum the frame is filled by the nearest
    // ceiling ring, and it takes roughly this much to trade that for the receding corridor, which
    // is what actually reads as a hall. The cost is magnification - about 370 source pixels
    // stretched over the band - which the fog, the defocused look, and now the cabinet standing
    // in front of most of it absorb.
    const height = 24;
    const hall = new THREE.Mesh(
      new THREE.PlaneGeometry(height * HALL_ASPECT, height),
      // Unlit on purpose: a matte painting carries its own light, and the scene's accent lamps
      // would smear across it as flat blobs. Fog still applies, which is what sells the depth.
      new THREE.MeshBasicMaterial({ map: this.hallTexture, color: 0xcdd8e2 }),
    );
    hall.position.set(0, HALL_EYE_Y + height * (0.5 - HALL_HORIZON), HALL_Z);
    hall.rotation.y = Math.PI;
    this.scene.add(hall);
    // Reclined with the board in poseCamera.
    this.hall = hall;
  }

  // Headboard: glowing arch frame, dark inner panel, hexagon CP badge, gold sill.
  buildHeadboard() {
    const extrude = { depth: 0.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 10 };
    const frame = new THREE.Mesh(
      new THREE.ExtrudeGeometry(CoinPusher.roundedRect(BED_WIDTH + 1.5, 3.5, 0.85), extrude),
      new THREE.MeshStandardMaterial({
        ...this.surfaces.brushed,
        color: PALETTE.shellRaised,
        emissive: PALETTE.gold,
        emissiveIntensity: 0.24,
        roughness: 0.32,
        metalness: 0.62,
        envMap: this.environmentTexture,
        envMapIntensity: 0.9,
      }),
    );
    this.headboardParts.push({ mesh: frame, offset: 0.5 });
    frame.position.set(0, 1.75, GAME.playfieldBackZ + 0.5);
    this.scene.add(frame);
    this.decor.push(frame);
    this.neon.push(frame);

    const panel = new THREE.Mesh(
      new THREE.ExtrudeGeometry(CoinPusher.roundedRect(BED_WIDTH + 0.6, 2.7, 0.6), extrude),
      new THREE.MeshStandardMaterial({
        ...this.surfaces.brushed,
        map: this.createHeadboardTexture(768, BED_WIDTH + 0.6, 2.7),
        color: PALETTE.white,
        roughness: 0.42,
        metalness: 0.55,
        envMap: this.environmentTexture,
        envMapIntensity: 0.5,
      }),
    );
    this.headboardParts.push({ mesh: panel, offset: 0.34 });
    panel.position.set(0, 1.75, GAME.playfieldBackZ + 0.34);
    this.scene.add(panel);
    this.decor.push(panel);

    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(1.35, 1.35),
      new THREE.MeshStandardMaterial({
        map: this.badgeTexture,
        emissiveMap: this.badgeTexture,
        emissive: PALETTE.white,
        emissiveIntensity: 0.55,
        transparent: true,
        roughness: 0.4,
      }),
    );
    this.headboardParts.push({ mesh: badge, offset: -0.09 });
    badge.position.set(0, 1.62, GAME.playfieldBackZ - 0.09);
    badge.rotation.y = Math.PI;
    this.scene.add(badge);
    // The badge belongs to the headboard, so it has to go with it - a CP hexagon left floating
    // where a hidden panel used to be is worse than no badge at all.
    this.decor.push(badge);

    // Gold sill under the headboard, matching the front lip.
    const sill = this.addStaticBox(BED_WIDTH + 0.9, 0.1, 0.34, 0, 0.16, GAME.playfieldBackZ + 0.42, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    });
    this.headboardParts.push({ mesh: sill, offset: 0.42 });
    this.decor.push(sill);
  }

  // Rounded corner posts and gold rails that give the boxy cabinet the mock's soft silhouette.
  buildCabinetShell() {
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    const postGeometry = new THREE.CapsuleGeometry(0.17, 2.15, 4, 10);
    const postMaterial = new THREE.MeshStandardMaterial({
      ...this.surfaces.brushed,
      color: PALETTE.glassTint,
      roughness: 0.3,
      metalness: 0.5,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.12,
      envMap: this.environmentTexture,
      envMapIntensity: 0.6,
    });
    for (const x of [-(INNER_X + 0.355), INNER_X + 0.355]) {
      for (const z of [GAME.playfieldFrontZ + 0.1, GAME.playfieldBackZ - 0.1]) {
        const post = new THREE.Mesh(postGeometry, postMaterial);
        this.decor.push(post);
        this.shellPosts.push({ mesh: post, front: z < playfieldCenter });
        post.position.set(x, 0.95, z);
        this.scene.add(post);
      }
      // Outer skirt closes the gap between the posts.
      const skirt = this.addStaticBox(0.3, 2.5, playfieldDepth - 0.2, x, 0.9, playfieldCenter, PALETTE.metal, {
        ...this.surfaces.brushed,
        roughness: 0.34,
        metalness: 0.72,
        visualOnly: true,
      });
      this.shellSkirts.push(skirt);
      this.decor.push(skirt);
    }
  }

  buildMachine() {
    this.buildBackdrop();
    // Lower stationary playfield and cabinet.
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    // White base colour, not PALETTE.felt: the deck texture already carries the navy it is drawn
    // on, and a tinted material would multiply the two and crush the markings to black.
    this.bed = this.addStaticBox(BED_WIDTH, 0.5, playfieldDepth, 0, -0.25, playfieldCenter, PALETTE.white, {
      ...(this.deckPlate ? this.plateSurfaceMaps(BED_WIDTH, playfieldDepth) : this.surfaces.deck),
      map: this.createDeckTexture(),
      roughness: 0.42,
      metalness: 0.3,
      receiveShadow: true,
    });
    const backPanel = this.backPanel = this.addStaticBox(BED_WIDTH, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05, PALETTE.dark, { map: this.createBackTexture() });
    Object.assign(backPanel.material, {
      emissiveMap: this.backTexture,
      emissive: new THREE.Color(PALETTE.white),
      emissiveIntensity: 0.5,
    });
    // Side walls read as tinted glass, so the pile stays visible through them like the mock.
    for (const x of [-(INNER_X + 0.125), INNER_X + 0.125]) {
      const glass = this.addStaticBox(0.25, 2.4, playfieldDepth + 0.2, x, 0.95, playfieldCenter, PALETTE.glassTint, {
        metalness: 0.1,
        roughness: 0.16,
        collisionRole: 'side-wall',
      });
      this.decor.push(glass);
      this.glassPanes.push(glass);
      Object.assign(glass.material, {
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
        envMap: this.environmentTexture,
        // Was 1.6, which turned the glass into an opaque mint slab that hid the pile behind it.
        envMapIntensity: 0.45,
      });
    }
    // Also decor: a real cabinet brings its own lit window frame, and these bars sit outside it,
    // reading as two loose glowing sticks rather than part of the machine. The pulse in animate()
    // keeps running on them either way - it just has nothing visible to drive.
    this.neon = [
      this.addStaticBox(0.14, 0.14, playfieldDepth + 0.2, -(INNER_X + 0.125), 2.2, playfieldCenter, PALETTE.gold, { emissive: PALETTE.gold, emissiveIntensity: 0.85, visualOnly: true }),
      this.addStaticBox(0.14, 0.14, playfieldDepth + 0.2, INNER_X + 0.125, 2.2, playfieldCenter, PALETTE.gold, { emissive: PALETTE.gold, emissiveIntensity: 0.85, visualOnly: true }),
    ];
    this.decor.push(...this.neon);
    // buildHeadboard adds its frame to this.neon for the pulse, and that one does not move with
    // the playfield's length - so the two bars that do are kept apart here.
    this.neonBars = [...this.neon];
    // Inlaid in the bed's front face, never proud of it: it has no collider, and a coin left
    // teetering at the lip (rules.js coinFallPhase) tips its rim through anything that stands above
    // the deck or out past the face - the old 0.12 x 0.14 bar, 0.04 above and 0.09 out, read as
    // coins sinking into the platform. 0.002 proud of the face only, to keep it off the bed's face.
    this.frontTrim = this.addStaticBox(BED_WIDTH, FRONT_TRIM_HEIGHT, FRONT_TRIM_DEPTH, 0, -FRONT_TRIM_HEIGHT / 2 - 0.002, frontTrimZ(), PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.14,
      visualOnly: true,
    });
    const chuteFloor = this.addStaticBox(BED_WIDTH + 0.4, 0.3, 2, 0, CHUTE_FLOOR_Y - 0.15, chuteZ(), PALETTE.dark, { receiveShadow: true });
    this.decor.push(chuteFloor);
    // A thin upright panel, not a block: FOLD_CAMERA looks down on this band, and a block's top
    // face read as a grey slab jutting out of the cabinet. It collides, so a coin that comes off
    // the lip fast stops behind it instead of landing in view on the hidden tray floor in front.
    const fasciaBottom = CHUTE_FLOOR_Y - 0.3;
    const fasciaDepth = 0.12;
    const fasciaOffset = 1.1 - FASCIA_GAP - fasciaDepth / 2;
    const fascia = this.addStaticBox(BED_WIDTH + 0.4, FASCIA_TOP_Y - fasciaBottom, fasciaDepth, 0, (FASCIA_TOP_Y + fasciaBottom) / 2, chuteZ() + fasciaOffset, PALETTE.scene, {
      // Near-black and matte, the same as the cabinet's base it continues.
      envMapIntensity: 0,
      metalness: 0,
      roughness: 1,
    });
    const fasciaTrim = this.addStaticBox(BED_WIDTH + 0.5, 0.06, 0.1, 0, FASCIA_TOP_Y, chuteZ() + 1.1 - FASCIA_GAP - 0.05, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    });
    // Lit inside the slit only, under the lip, so the opening reads as a lit mouth, not a floor.
    const chuteGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(BED_WIDTH + 0.2, 0.8),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: PALETTE.goldSoft,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    chuteGlow.rotation.x = -Math.PI / 2;
    chuteGlow.position.set(0, CHUTE_FLOOR_Y + 0.02, chuteZ() + 1.3);
    this.scene.add(chuteGlow);
    const wallHeight = CHUTE_WALL_TOP - CHUTE_FLOOR_Y + 0.3;
    const wallY = CHUTE_WALL_TOP - wallHeight / 2;
    const chuteWalls = [
      this.addStaticBox(0.2, wallHeight, 2, -(INNER_X + 0.175), wallY, chuteZ(), PALETTE.metal),
      this.addStaticBox(0.2, wallHeight, 2, INNER_X + 0.175, wallY, chuteZ(), PALETTE.metal),
      this.addStaticBox(BED_WIDTH + 0.4, wallHeight, 0.2, 0, wallY, chuteZ() - 0.9, PALETTE.metal),
    ];
    this.decor.push(...chuteWalls);
    // The tray itself stays a collider only: seen, it is the floor coins appeared to land on.
    for (const mesh of [chuteFloor, ...chuteWalls]) mesh.visible = false;
    // The whole chute hangs off the front lip: offsets from chuteZ(), never absolute positions.
    this.chuteParts = [
      { mesh: chuteFloor, offset: 0 },
      { mesh: fascia, offset: fasciaOffset },
      { mesh: fasciaTrim, offset: 1.1 - FASCIA_GAP - 0.05 },
      { mesh: chuteGlow, offset: 1.3 },
      { mesh: chuteWalls[0], offset: 0 },
      { mesh: chuteWalls[1], offset: 0 },
      { mesh: chuteWalls[2], offset: -0.9 },
    ];

    // A fixed rear deck closes the dead zone the retreating tray leaves behind. It sits a
    // hair below the tray so the tray slides over it and a coin never rests on both at once.
    // Its front edge has to reach the tray's back edge at full extension, or the shortfall is an
    // open slot straight down to the lower bed. It used to be a literal 1.85 against a tray that
    // reached 1.75, and the 0.1 of daylight only went unnoticed because the scraper stood at 1.72
    // and hid it; moving scraperZ back uncovered it. Derived from the stroke now, so it cannot
    // come apart again, with an overlap so the seam is never exactly on the tray's edge.
    const rear = CoinPusher.rearDeckSpan();
    this.rearDeck = this.addStaticBox(BED_WIDTH - 0.2, GAME.upperTrayHeight, rear.depth, 0, GAME.upperTrayY - GAME.deckClearance, rear.centre, PALETTE.shell, {
      ...this.surfaces.deck,
      roughness: 0.45,
      metalness: 0.38,
      receiveShadow: true,
    });
    // Same inlay the moving tray carries, so the strip the tray uncovers at full extension reads
    // as more shelf rather than a different object parked behind it. Sits at the deck's own top
    // face, not the tray's, or the tray would drag coins across a raised lip every stroke.
    const deckTop = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.5, 0.035, rear.inlayDepth),
      new THREE.MeshStandardMaterial({ ...this.inlaySurface(BED_WIDTH - 0.5, rear.inlayDepth), metalness: 0.25, roughness: 0.55 }),
    );
    this.rearDeckTop = deckTop;
    deckTop.position.set(0, GAME.upperTrayY - GAME.deckClearance + GAME.upperTrayHeight / 2 - 0.0175, rear.centre);
    this.shellSurfaces.push(deckTop);
    this.scene.add(deckTop);
    const trayTopY = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const scraperGuardHeight = GAME.scraperGuardTopY - trayTopY;
    // The scraper wears the deck's plate art, at the deck's own scale, so the board standing behind
    // the tray reads as the same build as the floor in front of it. Gold frames on brushed metal
    // were tried first and read as a different machine bolted on. The art is offset so one gold
    // seam lands on the board's bottom edge, where it meets the tray, and none crosses its face.
    // A step darker than the inlays: an upright plate in the middle of the shot, lit as brightly as
    // the floor, would read as a wall of light.
    const scraperPlates = this.deckPlate && this.plateSurfaceMaps(BED_WIDTH - 0.2, 1.2, true);
    for (const texture of Object.values(scraperPlates || {})) texture.offset.y = DECK_PLATE_SEAM;
    this.shellSurfaces.push(this.scraper = this.addStaticBox(BED_WIDTH - 0.2, 1.2, 0.16, 0, 1.31, GAME.scraperZ, scraperPlates ? DECK_PLATE_SCRAPER_TINT : PALETTE.metal, {
      ...(scraperPlates || this.surfaces.brushed),
      // The inlays' finish when it wears their art: at 0.7 metal the face is mostly a mirror of a
      // dark room and the plate colour never shows.
      roughness: scraperPlates ? 0.55 : 0.4,
      metalness: scraperPlates ? 0.25 : 0.7,
      emissive: PALETTE.gold,
      emissiveIntensity: 0.35,
      // BED_WIDTH overlaps the side-wall colliders, so an edge-on coin cannot squeeze around
      // either end; the top reaches the glass, so a pile impact cannot vault it.
      collisionWidth: BED_WIDTH,
      collisionHeight: scraperGuardHeight,
      collisionY: trayTopY + scraperGuardHeight / 2,
    }));
    // Visual only, so its front face must not stand ahead of the scraper's collider (scraperZ -
    // 0.08): at 0.19 deep it stood 0.035 proud and a coin pressed against the scraper at full
    // retreat sat inside it. 0.124 leaves it 0.002 proud - enough to avoid z-fighting the plate.
    const scraperStrip = this.addStaticBox(BED_WIDTH - 0.35, 0.08, 0.124, 0, 0.73, GAME.scraperZ - 0.02, PALETTE.gold, {
      ...BRASS,
      ...this.surfaces.brushed,
      envMap: this.environmentTexture,
      visualOnly: true,
    });
    // The board's sill hangs over the tray at coin height plus a little, so a chest - near three
    // coins tall - would ride under it into the pin board. This wall fills the sill's footprint
    // down to just above a small coin stack, and only chests collide with it: a pushed-back chest
    // stops at the sill's face, and the retreating deck slides it off its front edge instead.
    // ponytail: fixed, so it follows the sill in the flat pose only - a foldable reclines the board
    // and the sill moves; add the guard to the board rig if a chest is ever seen clipping there.
    const guardBottom = trayTopY + CHEST_GUARD_COIN_CLEARANCE;
    const guardTop = SILL_HEIGHT + 0.1;
    this.world.addStaticBox(
      { x: BED_WIDTH / 2, y: (guardTop - guardBottom) / 2, z: BOARD_SILL_FRONT / 2 },
      { x: 0, y: (guardTop + guardBottom) / 2, z: GAME.dropZoneZ - BOARD_SILL_FRONT / 2 },
      { groups: CHEST_ONLY_GROUPS },
    );
    this.scraperStrip = scraperStrip;

    // Moving upper tray: coins land here, meet the fixed scraper, then spill to the lower bed.
    const pusherMesh = new THREE.Group();
    const pusherDeckDepth = GAME.pusherDepth + GAME.pusherRearExtension;
    const pusherDeckCenterZ = GAME.pusherRearExtension / 2;
    const trayMaterial = new THREE.MeshStandardMaterial({ ...this.surfaces.brushed, color: PALETTE.shellRaised, metalness: 0.55, roughness: 0.35 });
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, GAME.upperTrayHeight, pusherDeckDepth),
      trayMaterial,
    );
    tray.position.set(0, GAME.upperTrayY, pusherDeckCenterZ);
    this.trayParts.push({ mesh: tray, inset: 0 });
    this.shellSurfaces.push(tray);
    tray.castShadow = this.quality.shadows;
    tray.receiveShadow = this.quality.shadows;
    pusherMesh.add(tray);

    const trayTop = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.5, 0.035, pusherDeckDepth - 0.12),
      new THREE.MeshStandardMaterial({ ...this.inlaySurface(BED_WIDTH - 0.5, pusherDeckDepth - 0.12), metalness: 0.25, roughness: 0.55 }),
    );
    this.shellSurfaces.push(trayTop);
    this.trayParts.push({ mesh: trayTop, inset: 0.12 });
    trayTop.position.set(0, GAME.upperTrayY + GAME.upperTrayHeight / 2 + 0.018, pusherDeckCenterZ);
    pusherMesh.add(trayTop);

    const bladeHeight = 0.64;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, bladeHeight, 0.14),
      new THREE.MeshStandardMaterial({ ...this.surfaces.brushed, color: PALETTE.shellRaised, metalness: 0.72, roughness: 0.3 }),
    );
    this.shellSurfaces.push(blade);
    blade.position.set(0, bladeHeight / 2, 0);
    blade.castShadow = this.quality.shadows;
    // The blade moves on its own shorter stroke (GAME.lowerBladeAmplitude), so it has its own group.
    const bladeMesh = new THREE.Group();
    bladeMesh.add(blade);

    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(BED_WIDTH - 0.3, 0.11, 0.075),
      new THREE.MeshStandardMaterial({ ...BRASS, ...this.surfaces.brushed, color: PALETTE.gold, envMap: this.environmentTexture }),
    );
    strip.position.set(0, 0.55, -0.075);
    bladeMesh.add(strip);

    // Gold edge strips, sunk so their top face is the tray's collision surface rather than a lip
    // standing 0.08 above it. The tray is only BED_WIDTH - 0.3 wide while a coin can rest with its
    // centre out at INNER_X - COIN_RADIUS, so a coin against either wall always overhangs these:
    // as a raised lip they were a gold bar drawn straight through the coin. Nothing on the tray
    // may sit above trayTopY for that reason - if these ever want to be a real lip they need a
    // collider on the pusher body too, which costs the outer 0.36 of tray on each side.
    for (const x of [-(INNER_X - 0.125), INNER_X - 0.125]) {
      // Flush by design, so the strip's top, front and back faces are coplanar with the tray's and
      // the two z-fought along both edges as the tray moved. The offset settles every tie in the
      // strip's favour without lifting it off trayTopY.
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.12, pusherDeckDepth),
        new THREE.MeshStandardMaterial({
          ...BRASS,
          ...this.surfaces.brushed,
          color: PALETTE.gold,
          envMap: this.environmentTexture,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      rail.position.set(x, trayTopY - 0.06, pusherDeckCenterZ);
      this.trayParts.push({ mesh: rail, inset: 0 });
      pusherMesh.add(rail);
    }
    this.scene.add(pusherMesh);
    this.scene.add(bladeMesh);
    this.buildCabinetShell();
    this.buildHeadboard();

    // The deck. Only its length follows the panel; the blade is a separate body (below) whose stroke
    // is fixed in config, which is what keeps the stroke's calibration out of the player's hands.
    const pusherBody = this.world.addKinematicBoxes([
      {
        halfExtents: { x: (BED_WIDTH - 0.3) / 2, y: GAME.upperTrayHeight / 2, z: pusherDeckDepth / 2 },
        offset: { x: 0, y: GAME.upperTrayY, z: pusherDeckCenterZ },
      },
    ], { x: 0, y: 0, z: pusherMotionAt(this.world.stepNumber, this.quality.physicsStep).positionZ });
    this.pusherDeckShape = pusherBody.colliders[0];
    const bladeBody = this.world.addKinematicBoxes([
      {
        halfExtents: { x: (BED_WIDTH - 0.3) / 2, y: (bladeHeight + LOWER_BLADE_SINK) / 2, z: 0.07 },
        offset: { x: 0, y: (bladeHeight - LOWER_BLADE_SINK) / 2, z: 0 },
      },
    ], { x: 0, y: 0, z: lowerBladeZAt(this.world.stepNumber, this.quality.physicsStep) });
    // Targeted before each step from the analytic strokes, so neither ever drifts.
    this.world.beforeStep.push((stepNumber) => {
      const { positionZ } = pusherMotionAt(stepNumber, this.quality.physicsStep);
      pusherBody.rb.setNextKinematicTranslation({ x: 0, y: 0, z: positionZ });
      bladeBody.rb.setNextKinematicTranslation({ x: 0, y: 0, z: lowerBladeZAt(stepNumber, this.quality.physicsStep) });
    });

    this.pusherMesh = pusherMesh;
    this.pusherBody = pusherBody;
    this.bladeMesh = bladeMesh;
    this.bladeBody = bladeBody;
    this.bladeHalfDepth = bladeBody.collider.halfExtents().z;
    this.buildDropper();
    // Every geometry-driven part now exists, so a saved layout can be applied in one pass
    // instead of being threaded through the build.
    this.layoutGeometry();
  }

  // Coins come in from above, the way a real pusher feeds them, and fall through a pin board on the
  // way down: every coin leaves a carriage at the centre of the slot's beam, and the pins and
  // bumpers decide where it actually lands. The board fills the stood-up half. What it looks like
  // is the board theme's (themes/); the fall itself is simulated in pachinko.js.
  buildDropper() {
    // The pop-up joint: everything above the fold - board, pins, bumpers, carriage and, once it is
    // built, the slot - hangs off the mint sill and reclines with the hinge (see setHingeAngle).
    // boardInner cancels the pivot, so its parts keep their world coordinates and only the rig turns.
    this.boardRig = new THREE.Group();
    this.boardRig.position.copy(BOARD_PIVOT);
    this.boardInner = new THREE.Group();
    this.boardInner.position.copy(this.boardRig.position).negate();
    this.boardRig.add(this.boardInner);
    this.scene.add(this.boardRig);

    const layout = boardPins();
    this.pinBoard = { ...PIN_BOARD, pins: layout };
    this.pinGlow = new Float32Array(layout.length);
    const { halfWidth, bottom, pinRadius } = PIN_BOARD;
    const theme = boardThemeFor(this.boardThemeId);
    const built = theme.build({
      board: this.boardInner,
      palette: PALETTE,
      quality: this.quality,
      glowTexture: this.glowTexture,
      // Lit by the room like the rest of the machine: brushed maps and the environment.
      metal: (options) => new THREE.MeshStandardMaterial({
        ...this.surfaces.brushed,
        envMap: this.environmentTexture,
        envMapIntensity: 0.65,
        ...options,
      }),
      // Coins fall in the plane z = dropZoneZ; the plate stands just behind a coin's thickness.
      bounds: {
        left: -halfWidth - 0.15,
        right: halfWidth + 0.15,
        bottom: bottom - 0.1,
        top: GAME.slotY,
        backZ: GAME.dropZoneZ + 0.4,
        coinZ: GAME.dropZoneZ,
      },
      layout,
      pinRadius,
      bumpers: PIN_BOARD.bumpers,
      mouth: { x: 0, y: DROPPER_Y - 0.31, halfWidth: COIN_RADIUS * 1.2 },
      seat: { y: DROP_START_Y, radius: COIN_RADIUS },
      carriageY: DROPPER_Y,
    });
    this.boardTheme = built;
    this.pinMesh = built.pins;
    this.bumpers = built.bumpers;
    this.dropper = built.carriage;
    this.dropShuttle = built.shuttle;
    this.buildNextCoin();
    for (const material of built.neon) this.shellNeon.push({ material, base: material.emissiveIntensity, phase: 0 });
  }

  // The coin waiting in the shuttle's cell. Its own mesh, not a pooled coin: it is never in the
  // world, and it hands over to a real coin at the exact pose that coin starts its fall in.
  buildNextCoin() {
    this.nextPremium = Math.random() < GAME.premiumChance;
    this.droppedAt = -Infinity;
    if (!this.dropShuttle || !this.coinGeometry) return;
    const seatY = DROP_START_Y - DROPPER_Y;
    const coin = new THREE.Mesh(this.coinGeometry, this.coinMaterials[this.nextPremium ? 'premium' : 'regular']);
    coin.quaternion.copy(COIN_UPRIGHT);
    coin.position.y = seatY;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: PALETTE.mint,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    flash.scale.setScalar(COIN_RADIUS * 4);
    flash.position.set(0, seatY, -0.05);
    this.dropShuttle.add(coin, flash);
    this.nextCoin = coin;
    this.nextCoinFlash = flash;
  }

  updateNextCoin() {
    const coin = this.nextCoin;
    if (!coin) return;
    const { visible, lift, scale, flash } = refillPose(this.elapsed - this.droppedAt);
    coin.visible = visible;
    coin.position.y = DROP_START_Y - DROPPER_Y + lift;
    coin.scale.setScalar(scale);
    this.nextCoinFlash.material.opacity = flash;
  }

  launchCoin() {
    // The coin that drops is the one the cell showed, colour included.
    // From wherever the shuttle is: the pins decide where a coin lands, so there is nothing to aim.
    const premium = this.nextPremium ?? Math.random() < GAME.premiumChance;
    if (!this.sendDownBoard({ x: dropXAt(this.elapsed), y: DROP_START_Y }, premium)) return false;
    this.boardTheme?.dispense?.(this.elapsed);
    // A press during a refill still drops: the cell just restarts its refill.
    this.nextPremium = Math.random() < GAME.premiumChance;
    this.droppedAt = this.elapsed;
    if (this.nextCoin) {
      this.nextCoin.material = this.coinMaterials[this.nextPremium ? 'premium' : 'regular'];
      this.nextCoin.visible = false;
    }
    return true;
  }

  // Puts a coin on the pin board. start is simulateDrop's, so it may carry a launch velocity.
  sendDownBoard(start, premium) {
    const coin = this.acquireCoin();
    if (!coin) return false;
    coin.isPremium = premium;
    coin.mesh.material = this.coinMaterials[coin.isPremium ? 'premium' : 'regular'];
    coin.counted = false;
    coin.falling = false;
    coin.recycleAt = Infinity;
    // The whole fall is worked out up front; the frames just play it back.
    const { path, hits } = simulateDrop(start, this.pinBoard);
    // Posed now, not on the next update: shown before then it would flash wherever it last was.
    coin.mesh.position.copy(this.boardToWorld(start.x, start.y));
    coin.mesh.quaternion.copy(this.boardRig.quaternion).multiply(COIN_UPRIGHT);
    coin.mesh.visible = true;
    this.launching.push({ coin, path, hits, hitIndex: 0, elapsed: 0 });
    return true;
  }

  // Coins stay scripted down the pin board, standing on edge and rolling as they bounce, and Cannon
  // takes over at the board's bottom edge with the velocity and spin the board left them with. A
  // coin that leaves on edge lands on edge and topples, which is what a real one does.
  updateLaunching(delta) {
    const spinAxis = new THREE.Vector3(0, 0, 1);
    for (let index = this.launching.length - 1; index >= 0; index -= 1) {
      const shot = this.launching[index];
      shot.elapsed += delta;
      const { path } = shot;
      const last = path[path.length - 1];
      shot.cursor = pathCursor(path, shot.elapsed, shot.cursor ?? 0);
      const sample = pathAt(path, shot.elapsed, shot.cursor);
      // The fall is simulated in the board's own plane; the rig carries it wherever the hinge has
      // reclined the board.
      const boardTurn = this.boardRig.quaternion;
      while (shot.hitIndex < shot.hits.length && shot.hits[shot.hitIndex].t <= shot.elapsed) {
        this.playHit(shot.hits[shot.hitIndex], shot.coin.isPremium);
        shot.hitIndex += 1;
      }
      shot.coin.mesh.position.copy(this.boardToWorld(sample.x, sample.y));
      shot.coin.mesh.quaternion.copy(boardTurn).multiply(new THREE.Quaternion().setFromAxisAngle(spinAxis, sample.angle)).multiply(COIN_UPRIGHT);
      if (shot.elapsed < last.t) continue;

      this.launching.splice(index, 1);
      const before = path[Math.max(0, path.length - 2)];
      const step = Math.max(last.t - before.t, 1e-6);
      const q = shot.coin.mesh.quaternion;
      const exit = this.boardToWorld(last.x, last.y);
      this.releaseCoin(shot.coin, {
        position: exit,
        // Tamed for the tray: the board can leave a coin doing 9, which the tray would bounce
        // straight off. A real chute slows it the same way. Both are in the board's plane, so they
        // turn with it like everything else the board hands over.
        velocity: (new THREE.Vector3(
          THREE.MathUtils.clamp((last.x - before.x) / step, -1.5, 1.5),
          Math.max((last.y - before.y) / step, -4),
          0,
        ).applyQuaternion(this.boardRig.quaternion)),
        angularVelocity: (new THREE.Vector3(
          0, 0, THREE.MathUtils.clamp((last.angle - before.angle) / step, -12, 12),
        ).applyQuaternion(this.boardRig.quaternion)),
        orientation: q,
      });
    }
  }

  // A hit lights what was struck, scaled by how hard: pins flash and swell, bumpers flash, swell and
  // throw sparks. main.js turns the same callback into a tick or a thump.
  playHit({ kind, index, x, y, speed }, premium) {
    const strength = THREE.MathUtils.clamp(speed / 6, 0.25, 1);
    if (kind === 'pin') this.pinGlow[index] = Math.max(this.pinGlow[index], strength);
    if (kind === 'bumper') {
      this.bumpers[index].glow = 1;
      const spark = this.boardToWorld(x, y, GAME.dropZoneZ - 0.3);
      this.emitParticles(spark.x, spark.y, spark.z, 8, premium);
    }
    this.callbacks.onBoardHit?.(kind, strength);
  }

  updateHits(delta) {
    const fade = Math.exp(-HIT_FADE * delta);
    if (this.pinGlow?.some((glow) => glow > 0)) {
      const pose = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const colour = new THREE.Color();
      this.pinGlow.forEach((glow, index) => {
        if (glow <= 0) return;
        const next = glow < 0.01 ? 0 : glow * fade;
        this.pinGlow[index] = next;
        this.pinMesh.getMatrixAt(index, pose);
        pose.decompose(position, rotation, scale);
        const swell = 1 + next * 0.5;
        pose.compose(position, rotation, scale.set(swell, 1, swell));
        this.pinMesh.setMatrixAt(index, pose);
        this.pinMesh.setColorAt(index, colour.setScalar(1 + next * 3));
      });
      this.pinMesh.instanceMatrix.needsUpdate = true;
      this.pinMesh.instanceColor.needsUpdate = true;
    }
    // The theme draws a bumper's glow (themes/: animate); this only lets it fade.
    for (const bumper of this.bumpers ?? []) {
      if (bumper.glow <= 0) continue;
      bumper.glow = bumper.glow < 0.01 ? 0 : bumper.glow * fade;
    }
    if (this.dropShuttle) this.dropShuttle.position.x = dropXAt(this.elapsed);
    this.updateNextCoin();
    this.boardTheme?.animate({ time: this.elapsed, delta });
    this.updateFenceLamps();
  }

  releaseCoin(coin, { position, velocity, angularVelocity, orientation }) {
    coin.body.setEnabled(true);
    coin.body.setPose(position, orientation);
    coin.body.setVelocity(velocity);
    coin.body.setAngularVelocity(angularVelocity);
    this.activeCoins.push(coin);
  }

  setupParticles() {
    const count = this.quality.sparkCount;
    this.particles = [];
    if (count === 0) return;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) positions[index * 3 + 1] = -100;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.28,
      map: this.glowTexture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.particlePoints = new THREE.Points(geometry, material);
    this.scene.add(this.particlePoints);
    this.particleCursor = 0;
    this.particles = Array.from({ length: count }, () => ({ life: 0, velocity: new THREE.Vector3() }));
  }

  emitParticles(x, y, z, amount, premium) {
    if (!this.particlePoints) return;
    const position = this.particlePoints.geometry.attributes.position;
    const color = this.particlePoints.geometry.attributes.color;
    // Follows the coins: gold sparks for the gold coin, cool white for the silver one. The
    // premium burst used to be mint to match a mint coin, and both moved together.
    const sparkColor = new THREE.Color(premium ? PALETTE.goldSoft : PALETTE.white);
    for (let index = 0; index < amount; index += 1) {
      const particleIndex = this.particleCursor % this.particles.length;
      this.particleCursor += 1;
      const particle = this.particles[particleIndex];
      particle.life = 0.55 + Math.random() * 0.3;
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 2.2;
      particle.velocity.set(Math.cos(angle) * speed, 2.2 + Math.random() * 2.5, Math.sin(angle) * speed - 1);
      position.setXYZ(particleIndex, x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4);
      color.setXYZ(particleIndex, sparkColor.r, sparkColor.g, sparkColor.b);
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
  }

  updateParticles(delta) {
    if (!this.particlePoints) return;
    const position = this.particlePoints.geometry.attributes.position;
    let changed = false;
    this.particles.forEach((particle, index) => {
      if (particle.life <= 0) return;
      particle.life -= delta;
      changed = true;
      if (particle.life <= 0) {
        position.setXYZ(index, 0, -100, 0);
        return;
      }
      particle.velocity.y -= 10 * delta;
      position.setXYZ(
        index,
        position.getX(index) + particle.velocity.x * delta,
        position.getY(index) + particle.velocity.y * delta,
        position.getZ(index) + particle.velocity.z * delta,
      );
    });
    if (changed) position.needsUpdate = true;
  }

  // Keeps a struggling device smooth: two seconds under ~45 fps steps the render down - pixel ratio
  // first, then shadows - and never back up mid-session. Physics is left alone: its step is the
  // payout calibration, and on the measured pile it costs ~1 ms of a 16 ms frame anyway.
  adaptQuality(frameDelta) {
    const slow = adaptiveStepFor(this.slowFor ?? 0, frameDelta);
    this.slowFor = slow.slowFor;
    if (!slow.stepDown) return;
    const ratio = this.renderer.getPixelRatio();
    if (ratio > 1) {
      const next = Math.max(1, ratio - 0.25);
      this.renderer.setPixelRatio(next);
      // The composer reads the ratio once, when it is built, and keeps its bloom buffers at that
      // size - without this a phone stepped down to 1 still bloomed at 1.75, ~3x the pixels.
      this.composer?.setPixelRatio(next);
      this.resize?.();
      return;
    }
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.scene.traverse((object) => { if (object.material) object.material.needsUpdate = true; });
    }
  }

  updateFenceLamps() {
    // A win breathes the reel bezel 0.6 -> 1.2 -> 0.6 every 0.8 s; a steady glow read as just stopped.
    if (this.reelWin && this.reelBezel && !this.quality.reducedMotion) {
      this.reelBezel.emissiveIntensity = 0.9 - 0.3 * Math.cos((this.elapsed * Math.PI * 2) / 0.8);
    }
    if (!this.fenceLamps?.length) return;
    const racing = this.quality.reducedMotion ? 0 : lampRaceLit(this.elapsed - this.lampRaceAt);
    const lit = this.quality.reducedMotion ? 0 : racing || fenceLampLit(this.elapsed);
    for (const { material, bay } of this.fenceLamps) {
      if (this.quality.reducedMotion) material.emissiveIntensity = 0.3;
      else if (bay === lit) material.emissiveIntensity = racing ? 1.4 : 0.6;
      else material.emissiveIntensity = FENCE_LAMP_IDLE;
    }
  }

  // Copies every visible coin's transform into its material's batch.
  syncCoinInstances() {
    if (!this.coinBatches) return;
    const counts = { regular: 0, premium: 0 };
    const draw = (coin) => {
      const { mesh } = coin;
      if (!mesh.visible) return;
      const name = mesh.material === this.coinMaterials.premium ? 'premium' : 'regular';
      mesh.updateMatrix();
      let batch = this.coinBatches[name];
      if (counts[name] >= batch.instanceMatrix.count) batch = this.growCoinBatch(name, batch.instanceMatrix.count * 2);
      batch.setMatrixAt(counts[name], mesh.matrix);
      counts[name] += 1;
    };
    // A pile still settling is mid-collapse from its seed lattice - not something to show.
    if (!this.settling) for (const coin of this.activeCoins) draw(coin);
    for (const shot of this.launching) draw(shot.coin);
    for (const [name, batch] of Object.entries(this.coinBatches)) {
      batch.count = counts[name];
      batch.instanceMatrix.needsUpdate = true;
    }
  }

  makeCoin() {
    const isPremium = Math.random() < GAME.premiumChance;
    // Not a mesh in the scene: a transform plus the material picking its batch. syncCoinInstances
    // draws it. The geometry is shared and baked at COIN_HEIGHT, so thickness rides on the scale.
    const mesh = new THREE.Object3D();
    mesh.material = this.coinMaterials[isPremium ? 'premium' : 'regular'];
    mesh.scale.y = (this.tuning.thickness / COIN_HEIGHT) * COIN_DRAW_THICKEN;
    const body = createCoinBody(this.world, this.tuning);
    const coin = {
      mesh,
      body,
      isPremium,
      counted: false,
      falling: false,
      recycleAt: Infinity,
    };
    this.createdCoins += 1;
    return coin;
  }

  // No cap: the machine bounds itself - coins leave over the lip as fast as they come in, so a long
  // session holds steady around 160-200 - and the batches grow to whatever that turns out to be.
  acquireCoin() {
    if (this.coinPool.length > 0) return this.coinPool.pop();
    return this.makeCoin();
  }

  // (Re)makes one material's instanced mesh with room for `capacity` coins. Instanced buffers are
  // fixed-size, so growing means a new mesh; doubling keeps that rare.
  growCoinBatch(name, capacity) {
    const old = this.coinBatches[name];
    const batch = new THREE.InstancedMesh(this.coinGeometry, this.coinMaterials[name], capacity);
    batch.count = 0;
    batch.frustumCulled = false;
    batch.castShadow = this.quality.shadows;
    batch.receiveShadow = this.quality.shadows;
    batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(batch);
    if (old) {
      this.scene.remove(old);
      old.dispose();
    }
    this.coinBatches[name] = batch;
    return batch;
  }

  spawnCoin(x, y, z, seedTier = null) {
    const coin = this.acquireCoin();
    if (!coin) return false;
    const seed = seedTier !== null;
    const lowerSeed = seedTier === 'lower';
    coin.isPremium = seed ? Math.random() < GAME.premiumChance : Math.random() < GAME.premiumChance;
    coin.mesh.material = this.coinMaterials[coin.isPremium ? 'premium' : 'regular'];
    coin.mesh.visible = true;
    coin.counted = false;
    coin.falling = false;
    coin.recycleAt = Infinity;
    // A seeded coin gets a sideways shove rather than being placed at rest: sliding a few
    // centimetres into its neighbours during settlePile() is what rubs out the rows and
    // columns it was seeded on. A dropped coin still just falls. The lower bed is a flat, open
    // layer and gets no shove: a large startup kick climbed coins over their neighbours before
    // frame one, and its randomized slots already provide the variation it needs.
    const kick = seed ? (lowerSeed ? 0 : 0.8) : 0;
    const velocity = seed
      ? { x: (Math.random() - 0.5) * kick, y: 0, z: (Math.random() - 0.5) * kick }
      : { x: 0, y: -1, z: 0 };
    const spin = lowerSeed ? 0 : 1;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(Math.random(), 0, Math.random()).normalize(),
      (Math.random() - 0.5) * (lowerSeed ? 0 : seed ? 0.42 : 0.3),
    );
    const orientation = yaw.multiply(tilt);
    coin.body.setEnabled(true);
    coin.body.setPose({ x, y, z }, orientation);
    // The mesh too: a coin spawned mid-frame (the bonus rain) is drawn before the next
    // interpolation pass, and would flash at wherever it last was.
    coin.mesh.position.set(x, y, z);
    coin.mesh.quaternion.copy(orientation);
    coin.body.setVelocity(velocity);
    coin.body.setAngularVelocity({
      x: (Math.random() - 0.5) * 2 * spin,
      y: (Math.random() - 0.5) * 4 * spin,
      z: (Math.random() - 0.5) * 2 * spin,
    });
    this.activeCoins.push(coin);
    return true;
  }

  /** Settling a new pile, physics behind real time, or a full machine - auto-drop waits (main.js). */
  get busy() {
    return Boolean(this.settling || this.behind);
  }

  drop() {
    if (this.closed || this.settling) return false;
    return this.launchCoin();
  }

  // A coin behind the lower blade and under the tray can never be pushed out again - the blade
  // only ever shoves forward - so it sits there, peeking out under the tray's lip. Some get there
  // (24 in four minutes of auto-drop, mostly off the tray's left half), so rather than chase every
  // way in, one that has stayed there for STRANDED_SECONDS goes back to the pool, unpaid.
  strandedUnderTray(coin, delta) {
    const { y, z } = coin.body.position;
    const behindBlade = z > this.bladeBody.position.z + this.bladeHalfDepth + COIN_RADIUS;
    const underTray = y < GAME.upperTrayY - GAME.upperTrayHeight / 2;
    coin.strandedFor = behindBlade && underTray ? (coin.strandedFor ?? 0) + delta : 0;
    return coin.strandedFor > STRANDED_SECONDS;
  }

  // A coin that has come down off the tray onto the lower bed takes the bed's high coin-on-coin
  // grip (physics.js LOWER_COIN_FRICTION); the tray keeps the low one it needs to drain. Coins
  // only ever travel down, so this is one-way until the coin is recycled.
  gripOnLowerBed(body) {
    if (body.material === 'coin' && onLowerBed(body.position)) this.world.setMaterial(body, 'lowerCoin');
  }

  // Frame and physics timings, averaged over half a second, for the dev overlay in main.js.
  recordPerf(frameSeconds, physicsMs) {
    const perf = this.perfWindow ??= { time: 0, frames: 0, steps: 0, dropped: 0, physics: 0, physicsMax: 0, render: 0 };
    perf.time += frameSeconds;
    perf.frames += 1;
    perf.steps += this.world.lastSteps ?? 0;
    perf.dropped += this.world.droppedSeconds ?? 0;
    perf.physics += physicsMs;
    perf.render += this.lastRenderMs ?? 0;
    perf.physicsMax = Math.max(perf.physicsMax, physicsMs);
    if (perf.time < 0.5) return;
    // Physics fell behind over the last half second: auto-drop holds off (main.js) until it is back.
    this.behind = perf.dropped > 0.05;
    this.perf = {
      fps: perf.frames / perf.time,
      physicsMs: perf.physics / perf.frames,
      physicsMaxMs: perf.physicsMax,
      renderMs: perf.render / perf.frames,
      pixelRatio: this.renderer.getPixelRatio(),
      build: physicsBuild,
      coins: this.activeCoins.length,
    };
    this.perfWindow = null;
  }

  recycleCoin(index) {
    const [coin] = this.activeCoins.splice(index, 1);
    if (!coin) return;
    this.world.setMaterial(coin.body, 'coin');
    coin.body.setEnabled(false);
    coin.mesh.visible = false;
    coin.falling = false;
    coin.strandedFor = 0;
    this.coinPool.push(coin);
  }

  resetPile() {
    this.cancelChest();
    for (const shot of this.launching) {
      shot.coin.mesh.visible = false;
      this.coinPool.push(shot.coin);
    }
    this.launching.length = 0;
    for (let index = this.activeCoins.length - 1; index >= 0; index -= 1) this.recycleCoin(index);
    this.runPusherToFullRetreat();
    const pileSeed = Math.floor(Math.random() * 1_000_000_000);
    for (let index = 0; index < this.quality.seedCount; index += 1) {
      const position = seedPosition(index, pileSeed, this.tuning.thickness, this.pusherBody.position.z);
      this.spawnCoin(position.x, position.y, position.z, position.tier);
    }
    return this.settlePile();
  }

  // Run the empty world - no coins in it, so the steps cost nothing - up to the instant the
  // pusher sits at full retreat. settlePile() then spends its whole budget on the forward
  // half of the stroke, which is the half that does the work.
  runPusherToFullRetreat() {
    const step = this.quality.physicsStep;
    const perStroke = Math.round((2 * Math.PI / GAME.pusherSpeed) / step);
    const atRetreat = Math.round((Math.PI / 2 / GAME.pusherSpeed) / step);
    const wait = ((atRetreat - this.world.stepNumber) % perStroke + perStroke) % perStroke;
    for (let i = 0; i < wait; i += 1) this.world.stepOnce();
  }

  // A seeded lattice reads as a grid however hard the slots are jittered - the eye locks onto
  // the columns, not the millimetres. So the player never sees the lattice: the world runs
  // forward before the first frame and the pile arrives already collapsed, coins tipped and
  // riding on each other the way they are after a minute of play. Half of that is the pusher
  // squeezing the pile against the lip; gravity alone just settles it back into flat rows.
  //
  // Run in frame-sized slices, yielding between them: in one go it is 360 steps (~200 ms on a
  // desktop, seconds on a phone) with the page frozen - at load, on 重新開始 and on a thickness
  // or geometry change. The steps and their order are the same, so the pile settles the same.
  // While `settling`, animate() leaves physics, scoring and the pile's drawing alone and drop()
  // refuses; a newer resetPile() supersedes this one through the token.
  async settlePile() {
    const token = {};
    this.settleToken = token;
    this.settling = true;
    // Much the most expensive thing the game ever does - every coin awake, every pair in
    // contact - so the solver runs lean. Residual error is cleaned up by the first real
    // frames at full iterations, before the player has taken a turn.
    this.world.setIterations(SETTLE_SOLVER_ITERATIONS);
    const total = Math.round(PILE_SETTLE_SECONDS / this.quality.physicsStep);
    for (let i = 0; i < total;) {
      const sliceStart = performance.now();
      do {
        this.world.stepOnce();
        for (const coin of this.activeCoins) this.gripOnLowerBed(coin.body);
        i += 1;
      } while (i < total && performance.now() - sliceStart < SETTLE_SLICE_MS);
      if (i < total) await nextFrame();
      if (this.settleToken !== token) return;
    }
    this.world.setIterations(this.tuning.solverIterations);
    this.world.accumulator = 0;
    // A coin the stroke shoved over the lip never happened: recycle it, or the payout check
    // on frame one pays the player for a pile that fell over on its own. Only coins that really
    // went over - one still hanging on the lip is the pile the player is meant to find.
    for (let i = this.activeCoins.length - 1; i >= 0; i -= 1) {
      if (coinFallPhase({}, this.activeCoins[i].body.position)) this.recycleCoin(i);
    }
    for (const coin of this.activeCoins) {
      coin.mesh.position.copy(coin.body.position);
      coin.mesh.quaternion.copy(coin.body.quaternion);
    }
    this.settling = false;
    for (const onWin of this.pendingChests.splice(0)) this.dropChest(onWin);
  }

  setEnvironmentRotation(horizontalDegrees, verticalDegrees) {
    const horizontal = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(horizontalDegrees, -180, 180));
    const vertical = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(verticalDegrees, -90, 90));
    Object.values(this.coinMaterials).forEach((material) => {
      material.envMapRotation.set(vertical, horizontal, 0);
    });
  }

  bindResize() {
    const resize = () => {
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.poseCamera();
      this.renderer.setSize(width, height, false);
      this.composer?.setSize(width, height);
    };
    this.resize = resize;
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(this.canvas);
    this.cleanup.push(() => this.resizeObserver.disconnect());
    resize();
  }

  /**
   * Follows the hinge: 180 lies the machine flat, 90 or less stands it up (see FOLD_CAMERA) and
   * stands the board up with it (see boardReclineFor). The camera and the board ease there over a
   * few frames rather than jumping with each coarse hinge reading. Nearly shut, the machine pauses.
   */
  setHingeAngle(degrees) {
    this.foldTarget = foldFor(degrees);
    this.closed = closedFor(this.closed, degrees);
    // A hinge reading means a foldable: from now on the sill rides the fold at every angle.
    if (!this.foldable) {
      this.foldable = true;
      this.poseCamera();
    }
  }

  /** A point in the pin board's plane (z defaults to the coins' plane), in world space. */
  boardToWorld(x, y, z = GAME.dropZoneZ) {
    this.boardInner.updateWorldMatrix(true, false);
    return this.boardInner.localToWorld(new THREE.Vector3(x, y, z));
  }

  // The pose for the current fold: position, target and fov blended from the open pose (the flat
  // one off a foldable) to the fold pose.
  poseCamera() {
    const fold = this.fold;
    const open = this.foldable ? OPEN_CAMERA : { ...FLAT_CAMERA, fov: fovForAspect(this.camera.aspect) };
    const lerp = (from, to) => from.map((value, index) => THREE.MathUtils.lerp(value, to[index], fold));
    this.camera.position.set(...lerp(open.position, FOLD_CAMERA.position));
    this.camera.lookAt(...lerp(open.target, FOLD_CAMERA.target));
    // The board lies parallel to the screen at whatever pitch the camera now has - see boardReclineFor.
    this.camera.updateMatrixWorld();
    const recline = boardReclineFor(this.camera.getWorldDirection(new THREE.Vector3()));
    this.boardRig.rotation.x = recline;
    // The hall leans back with it, about its middle. Upright, its columns converged under a camera
    // looking down while the board beside them stayed square, so the board read as a sticker on a
    // tilted room; parallel to the screen too, every vertical on the upper half stays vertical.
    if (this.hall) this.hall.rotation.x = recline;
    this.camera.fov = THREE.MathUtils.lerp(open.fov, FOLD_CAMERA.fov, fold);
    // The poses only put the sill near the fold: where the fold lands in the canvas moves with the
    // controls and the window, and a fixed target was 2.3 pt off on the device. So measure both -
    // where this pose puts the sill, where the fold is - and slide the frame by the difference, at
    // every angle: the crease is the machine's hinge, and the sill sat below it part-way through the
    // fold while the slide was scaled in with it, putting the crease across the pins at 135-155.
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const top = this.canvas.getBoundingClientRect().top;
    const sillNdc = new THREE.Vector3(0, SILL_HEIGHT, GAME.dropZoneZ - 0.1).project(this.camera).y;
    const shift = this.foldable && height ? foldShiftFor(window.innerHeight / 2 - top, height, sillNdc) : 0;
    if (Math.abs(shift) >= 0.5) {
      this.camera.setViewOffset(width, height, 0, shift, width, height);
      this.camera.updateProjectionMatrix();
    }
    this.cameraBase.copy(this.camera.position);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.animate();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  animate = (timestamp) => {
    if (!this.running) return;
    this.frameId = requestAnimationFrame(this.animate);
    this.timer.update(timestamp);
    const frameDelta = Math.min(this.timer.getDelta(), 0.05);
    this.adaptQuality(frameDelta);
    // Nearly shut, game time stops: physics, the board, scoring, recycling and the slot's spin all
    // read it, so a spin in progress cannot finish and pay while nobody can see it. Rendering,
    // dimming and the hinge's easing keep the real frame time.
    let delta = this.closed || this.settling ? 0 : frameDelta;

    // The pusher always runs, including before the first player drop. Initial stability comes
    // from the seeded clearances in physics.js, not from pausing the machine.
    // Nearly shut: nobody can see the machine, so it holds still rather than paying out unseen.
    if (delta > 0) {
      const physicsStart = performance.now();
      this.world.step(delta);
      // Game time is the time physics actually simulated: when a struggling device drops the
      // backlog (world.js step), the board, recycling, bonus timers and auto-drop slow with it
      // rather than outrunning the pile they feed.
      delta -= this.world.droppedSeconds;
      const physicsMs = performance.now() - physicsStart;
      this.recordPerf(frameDelta, physicsMs);
      // A device whose single step eats most of a frame cannot catch up by stepping more: each
      // catch-up frame is longer still, and it locks at a third of the frame rate (measured: an
      // iPhone at 20 fps, 66 ms of physics a frame). One step a frame there, which plays a little
      // slow instead.
      if (this.world.lastSteps > 0) {
        this.world.maxSubSteps = nextMaxSubSteps(this.world.maxSubSteps, physicsMs / this.world.lastSteps, this.quality.physicsMaxSubSteps);
      }
      this.updateLaunching(delta);
    }
    this.elapsed += delta;

    const scored = [];
    for (let index = this.settling ? -1 : this.activeCoins.length - 1; index >= 0; index -= 1) {
      const coin = this.activeCoins[index];
      // Render from the interpolated pose: world.step() runs a fixed-step accumulator, so
      // a display running at any other rate takes 0 or 2 steps on some frames. Reading the
      // raw pose there freezes a coin for a frame and double-jumps it the next.
      coin.body.lerpPose(this.world.alpha, coin.mesh.position, coin.mesh.quaternion);
      if (coin.counted && coin.recycleAt <= this.elapsed) {
        this.recycleCoin(index);
        continue;
      }
      this.gripOnLowerBed(coin.body);
      const phaseResult = coinFallPhase(coin, coin.body.position);
      if (phaseResult === 'fall') {
        coin.falling = true;
      } else if (phaseResult === 'score') {
        coin.counted = true;
        coin.recycleAt = this.elapsed + this.recycleDelay;
        scored.push(coin);
        // At the slot's mouth: the coin itself is already behind the fascia by now.
        this.emitParticles(coin.body.position.x, FASCIA_TOP_Y, chuteZ() + 1.1 - FASCIA_GAP, coin.isPremium ? 12 : 7, coin.isPremium);
      } else if (phaseResult === 'lost' || this.strandedUnderTray(coin, delta)) {
        this.recycleCoin(index);
      }
    }
    if (scored.length > 0) this.callbacks.onScore?.(scored, this.elapsed);

    if (!this.quality.reducedMotion) {
      const pulse = 0.75 + 0.2 * Math.sin(this.elapsed * 3);
      this.neon.forEach((mesh) => { mesh.material.emissiveIntensity = pulse; });
      this.frontTrim.material.emissiveIntensity = 0.12 + 0.06 * Math.sin(this.elapsed * 3 + 1);
      // Squared so the crest is narrow: a plain sine reads as everything breathing together,
      // where this reads as one bright band travelling through the set.
      for (const part of this.shellNeon) {
        const wave = 0.5 + 0.5 * Math.sin(this.elapsed * 2.4 - part.phase);
        part.material.emissiveIntensity = part.base * (0.2 + 0.8 * wave * wave);
      }
    }
    const exposure = this.closed ? 0.35 : 1.05;
    if (this.renderer.toneMappingExposure !== exposure) {
      this.renderer.toneMappingExposure = THREE.MathUtils.damp(this.renderer.toneMappingExposure, exposure, 6, frameDelta);
      if (Math.abs(this.renderer.toneMappingExposure - exposure) < 0.01) this.renderer.toneMappingExposure = exposure;
    }
    if (this.fold !== this.foldTarget) {
      // About a fifth of a second to settle; snaps the last sliver so it stops re-posing.
      this.fold = THREE.MathUtils.damp(this.fold, this.foldTarget, 12, frameDelta);
      if (Math.abs(this.fold - this.foldTarget) < 0.001) this.fold = this.foldTarget;
      const standUp = standUpFor(this.standUpArmed, this.fold);
      this.standUpArmed = standUp.armed;
      if (standUp.fire) {
        this.lampRaceAt = this.elapsed;
        this.callbacks.onStandUp?.();
      }
      this.poseCamera();
    }
    // Chests and coin rain wait out a settling pile (dropChest queues; rain resumes after).
    if (!this.settling) this.updateBonus(delta);
    this.updateHits(delta);
    this.syncCoinInstances();
    this.updateParticles(delta);
    this.pusherBody.lerpPose(this.world.alpha, this.pusherMesh.position);
    this.bladeBody.lerpPose(this.world.alpha, this.bladeMesh.position);
    const renderStart = performance.now();
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.lastRenderMs = performance.now() - renderStart;
  };

  destroy() {
    this.stop();
    this.composer?.dispose();
    this.cleanup.splice(0).forEach((cleanup) => cleanup());
    for (const shot of this.launching) shot.coin.mesh.visible = false;
    this.launching.length = 0;
    for (let index = this.activeCoins.length - 1; index >= 0; index -= 1) this.recycleCoin(index);
    // Last: everything above still talks to the bodies, and a freed world's bodies are dangling.
    this.world?.free();
    // The scene walk below frees geometry and materials, not an instanced mesh's own buffers.
    for (const batch of Object.values(this.coinBatches ?? {})) batch.dispose();
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    this.scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.filter(Boolean).forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.add(value);
      });
      material.dispose();
    });
    textures.forEach((texture) => texture.dispose());
    this.environmentTexture?.dispose();
    this.timer?.dispose();
    this.renderer.dispose();
  }
}
