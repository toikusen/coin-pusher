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

// How far below the deck top (y = 0) a coin's centre has to be before it counts as falling.
// Resting coins sit at about +0.05, so this is a coin that has already left the bed.
export const NATURAL_FALL_Y = -0.3;

// The coin's own phases, without coinPhase's nudge. A coin is left to teeter at the lip for as
// long as the pile lets it - that hang is what makes the player drop one more - and is only
// latched as falling once it has actually gone over: centre past the bed's real front face and
// below the deck. z alone is not enough, a Rapier cylinder can sit on the corner or the pile
// past the face. The fall check runs before `lost` so one long step cannot skip the payout.
// ponytail: no hold timer. Headless runs teetered up to 27s with payouts never stalling; add a
// late nudge only if a parked coin is ever seen damming the pile.
export function coinFallPhase(coin, position) {
  if (coin.counted) return null;
  if (coin.falling && position.y < GAME.trayY) return 'score';
  if (!coin.falling && position.z < GAME.playfieldFrontZ && position.y < NATURAL_FALL_Y) return 'fall';
  if (position.y < GAME.lostY) return 'lost';
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
