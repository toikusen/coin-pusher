import { GAME } from './config.js';

export function coinPhase(coin, position) {
  if (coin.counted) return null;
  if (coin.falling && position.y < GAME.trayY) return 'score';
  if (position.y < GAME.lostY) return 'lost';
  if (!coin.falling && position.z < GAME.edgeZ) return 'cross';
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
