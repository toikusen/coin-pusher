import { CHEATS } from './cheats.js';
import { GAME } from './config.js';

export function coinPhase(coin, position) {
  if (coin.counted) return null;
  if (coin.falling && position.y < GAME.trayY) return 'score';
  if (position.y < GAME.lostY) return 'lost';
  // Every frame it is over the lip, not only the first: edgeZ sits behind the bed's front face,
  // so a body that has just crossed still has most of its footprint on the deck and can balance
  // there. Latching on the first crossing left it parked with nothing ever nudging it again -
  // measured hangs of up to 51s, damming the pile behind it. nudgeOverLip only adds the motion
  // that is missing, so repeating it through a real fall changes nothing about the fall.
  if (position.z < GAME.edgeZ) return 'cross';
  return null;
}

export function calculateReward(coins, previousCombo, elapsedSinceScore) {
  const base = coins.reduce(
    (sum, coin) => sum + (coin.isPremium ? GAME.premiumValue : GAME.regularValue),
    0,
  );
  const carried = elapsedSinceScore < GAME.comboWindow ? previousCombo : 0;
  const combo = carried + coins.length;
  // The bonus fires on the payout that crosses the threshold, not on every payout above it.
  // A payout is one frame's worth of coins, and an avalanche arrives over several frames, so
  // paying per call handed the same coins a bonus once per frame - the faster the display ran,
  // the more the same drop was worth.
  const bonus = carried < GAME.comboThreshold && combo >= GAME.comboThreshold
    ? GAME.comboBonus
    : 0;
  return { base, combo, bonus, total: base + bonus };
}

// How many chest thresholds a payout carried the score across. Every threshold earns its own chest,
// an avalanche across two included - a chest takes over two minutes to ride the machine, so they
// share it rather than queueing. The chest's own reward is deliberately not fed back through here,
// so a bonus can never trigger the next chest.
export function chestsDue(previousScore, score) {
  const crossed = Math.floor(score / GAME.chestScoreStep)
    - Math.floor(previousScore / GAME.chestScoreStep);
  return Math.max(0, crossed);
}

// The three faces one chest's spin locks on. Each GAME.slotOutcomes entry owns a slice of [0, 1)
// worth its chance; anything past the last slice is a miss. random is injectable so a test can
// pin the result. The whole outcome is decided here, up front - the reels only play it back.
export function rollSlotResult(random = Math.random) {
  if (CHEATS.slot) return forcedSlotResult(CHEATS.slot, random);
  let cursor = random();
  for (const { symbol, chance } of GAME.slotOutcomes) {
    cursor -= chance;
    if (cursor < 0) return [symbol, symbol, symbol];
  }
  return slotMiss(random);
}

// cheats.slot, when a tester has pinned the outcome. 'miss' forces a losing line; anything else
// has to be a playable symbol, and an unknown one falls through to a normal roll rather than
// silently paying nothing.
function forcedSlotResult(forced, random) {
  if (forced === 'miss') return slotMiss(random);
  if (GAME.slotOutcomes.some((outcome) => outcome.symbol === forced)) return [forced, forced, forced];
  console.warn(`cheats.slot: unknown symbol "${forced}", rolling normally`);
  CHEATS.slot = null;
  return rollSlotResult(random);
}

// A miss is still three real faces, so it has to be built rather than left blank - and it must
// never accidentally line up. Randomise all three, then force the last one off the others.
// A single-symbol config cannot miss; keep at least two symbols playable.
function slotMiss(random) {
  const symbols = GAME.slotOutcomes.map((outcome) => outcome.symbol);
  const faces = [0, 0, 0].map(() => symbols[Math.min(symbols.length - 1, Math.floor(random() * symbols.length))]);
  if (faces.every((face) => face === faces[0])) {
    faces[2] = symbols[(symbols.indexOf(faces[0]) + 1) % symbols.length];
  }
  return faces;
}

// Which coins a gild turns premium: GAME.gildRatio of the plain ones, picked without replacement.
// A coin on its way down the chute is skipped - it is already counted, and gilding it would show
// gold for points nobody was paid. Rounded up, so any pile at all pays at least one coin: a prize
// that lands on zero because the ratio rounded down reads as a bug rather than as a small win.
// Pure and injectable so tests can pin the picks; CoinPusher does the material swap.
export function gildTargets(coins, ratio = GAME.gildRatio, random = Math.random) {
  const plain = coins.filter((coin) => !coin.counted && !coin.isPremium);
  const target = Math.min(plain.length, Math.ceil(plain.length * Math.min(Math.max(ratio, 0), 1)));
  const picked = [];
  // Partial Fisher-Yates over `plain`, which is this function's own copy: swapping the taken coin
  // out of the front means a coin can never be picked twice, and a small gild lands across the
  // whole pile instead of on whichever coins happen to be first in the list.
  for (let index = 0; index < target; index += 1) {
    const pick = index + Math.floor(random() * (plain.length - index));
    picked.push(plain[pick]);
    plain[pick] = plain[index];
  }
  return picked;
}

// What an earthquake adds to one coin's velocity, per second, this frame. Jitter on every axis so
// the pile rattles apart, biased towards the payout lip (negative z, see coinPhase) so it walks
// forward instead of buzzing in place. Never backwards: a quake that pushed coins away from the
// lip would be a punishment, not a prize.
export function quakeKick(random = Math.random) {
  return {
    x: (random() - 0.5) * GAME.quakeJitter,
    y: random() * GAME.quakeLift,
    z: -(GAME.quakeForward + random() * GAME.quakeJitter * 0.5),
  };
}

// What a finished spin pays: the symbol all three reels showed, or null for anything else. Only a
// three of a kind pays - a line with two alike is a miss like any other. main.js keys its prize
// table off the symbol.
export function slotWin(faces) {
  return faces[0] === faces[1] && faces[1] === faces[2] ? faces[0] : null;
}

// Aim is expressed from the player's view: -1 is screen-left and +1 is screen-right. The camera
// faces world +Z, which mirrors world X on screen, hence the minus sign in the conversion.
// The reach aim maps onto: the rail's half-width, or the part of it the window can frame, less the
// launcher's own half-width so the muzzle stops at the edge instead of past it. fov is vertical, so
// aspect is the only thing that moves this - a tall narrow window runs out of room first.
export function launcherReachFor(fovDegrees, aspect, depth, margin = 0) {
  const framed = Math.tan((fovDegrees * Math.PI) / 360) * depth * aspect;
  return Math.max(0, Math.min(GAME.launcherTravelHalfWidth, framed - margin));
}

// halfWidth is the reach aim maps onto, not a fixed constant: the rail is in front of the
// machine and close to the camera, so a narrow window sees less of it than launcherTravelHalfWidth
// and the muzzle would slide off screen at full aim. CoinPusher passes what it can actually frame.
export function launcherXFor(aim, halfWidth = GAME.launcherTravelHalfWidth) {
  const clamped = Math.min(Math.max(Number.isFinite(aim) ? aim : 0, -1), 1);
  const reach = Number.isFinite(halfWidth) ? halfWidth : GAME.launcherTravelHalfWidth;
  return clamped === 0 ? 0 : -clamped * reach;
}

// One fixed landing point, like a real machine's chute: aim moves it across the playfield, never
// along it. dropZoneZ stays over the moving tray for the whole stroke (tests/physics.test.js
// "drop zone"), so a world-fixed endpoint still always lands on the tray.
// Deliberately the full rail width, never the framed reach: where a shot lands is a rule of the
// game and must not change with the window's shape. The launcher is what gives ground when the
// frame is narrow - it stops short and the barrel turns to cover the rest, see launcherYawFor.
export function launcherTargetFor(aim) {
  return {
    x: launcherXFor(aim),
    z: GAME.dropZoneZ,
  };
}

// Where the barrel points: at the spot the shot lands, so a launcher parked short of its target
// still reads as aiming there rather than firing sideways out of a straight tube. The launcher
// only travels as far as the frame allows, so this is the whole of what covers the last stretch
// to the playfield's edges on a narrow window.
export function launcherYawFor(launcherX, targetX, reach = GAME.dropZoneZ - GAME.launcherMuzzleZ) {
  const cap = (GAME.launcherFanDegrees * Math.PI) / 180;
  // The model points +Z, and a yaw of t about Y sends +Z to (sin t, 0, cos t) - hence x over z.
  return Math.min(Math.max(Math.atan2(targetX - launcherX, reach), -cap), cap);
}

// Gravity has to match the world CoinPusher builds, or the derivation below stops describing it.
const GRAVITY_Y = 24;

// How long a press has to be held to reach full power. Short enough that a tap still feels like a
// deliberate weak launch rather than a mis-timed one.
export const CHARGE_SECONDS = 0.7;

// A held press, as a 0..1 power. Nothing above CHARGE_SECONDS counts, so holding forever is the
// same as holding exactly long enough - the player cannot lose a coin by over-charging.
export function chargeToPower(heldSeconds) {
  return Math.min(Math.max(heldSeconds, 0) / CHARGE_SECONDS, 1);
}

export function launchSpeedFor(power) {
  const clamped = Math.min(Math.max(power, 0), 1);
  return GAME.railSpeedMin + clamped * (GAME.railSpeedMax - GAME.railSpeedMin);
}

// Where a coin launched from `side` at this power touches down, as a ballistic arc off the rail's
// inner end. The coin rolls inwards, so it keeps travelling towards the far side after it leaves
// the rail: the weakest launch lands on the centre line, a hard one crosses it.
// Nothing on screen draws this any more - it is here because it is the derivation the rail config
// is built on (railExitX = railSpeedMin * the fall time), and tests/physics.test.js guards it.
// Delete it and the next person to change railSpeedMin has nothing telling them what broke.
export function landingXFor(side, power, dropHeight) {
  const fall = Math.sqrt((2 * Math.max(dropHeight, 0)) / GRAVITY_Y);
  return Math.sign(side || 1) * (GAME.railExitX - launchSpeedFor(power) * fall);
}
