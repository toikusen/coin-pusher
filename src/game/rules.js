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

export function clampAim(value) {
  return Math.max(-1.95, Math.min(1.95, value));
}

// The camera looks toward +Z, so screen-right maps to world -X.
export function screenAimToWorld(value) {
  return clampAim(-value);
}

export function worldAimToScreen(value) {
  return -value;
}

export function aimLabel(value) {
  if (value < -0.7) return '偏左';
  if (value > 0.7) return '偏右';
  return '置中';
}
