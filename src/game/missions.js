// The mission chain: one mission at a time, each finished mission pays a machine event and hands
// over to the next, and the level number keeps counting up across launches. Every mission can
// always progress - there is no "hit 777" mission, since a specific slot prize can take a dozen
// chests - so none of them needs a fallback condition or a skip button.
//
// Kinds, and what feeds them:
//   drop     coins dropped into the machine
//   score    points paid by coins going over the lip (combo bonus included, mission rewards not)
//   premium  gold coins paid
//   combo    the longest combo reached during the mission
//   chest    chests won (every chestScoreStep points), whether they drop at once or queue
//   open     chests whose slot has finished spinning, whatever it showed
//
// Rewards are machine events from the chest prizes, scaled down: rain (coins), quake (seconds),
// gild (share of plain coins). The coins they produce still have to be pushed off to pay.

const KIND_TEXT = {
  drop: '投入硬幣',
  score: '取得分數',
  premium: '推落金幣',
  combo: '連擊',
  chest: '獲得寶箱',
  open: '開寶箱',
};

// The first three teach the loop: short, and each one a different kind. The first is about the
// button, not the pile - a fresh machine pays nothing for about a minute while it fills.
const INTRO = [
  { kind: 'drop', target: 10, reward: { type: 'rain', amount: 5 } },
  { kind: 'premium', target: 2, reward: { type: 'rain', amount: 5 } },
  { kind: 'combo', target: 3, reward: { type: 'rain', amount: 8 } },
];

// Then this loops for good. Ordered so the same kind never comes twice in a row, wrap included,
// and the targets stop growing: a mission should take a minute or two however long you have played.
// Sized against a 27-minute auto-drop run on the iPhone simulator (2026-10-27), rewards included:
// about 220 points a minute, combos of 8 within 15 s, chests won every ~25 s and opened every
// ~30 s once the queue is running. The first set of targets, half these, took 36 s a mission.
// ponytail: a fixed rotation, not a random draw - nothing to persist but the level. Upgrade path:
// seeded picks per level if players say it feels repetitive.
const ROTATION = [
  { kind: 'score', target: 180, reward: { type: 'rain', amount: 8 } },
  { kind: 'premium', target: 20, reward: { type: 'rain', amount: 8 } },
  { kind: 'combo', target: 10, reward: { type: 'rain', amount: 10 } },
  { kind: 'chest', target: 4, reward: { type: 'rain', amount: 10 } },
  { kind: 'score', target: 300, reward: { type: 'quake', amount: 0.8 } },
  { kind: 'premium', target: 30, reward: { type: 'gild', amount: 0.15 } },
  { kind: 'open', target: 2, reward: { type: 'rain', amount: 12 } },
  { kind: 'score', target: 240, reward: { type: 'gild', amount: 0.15 } },
  { kind: 'open', target: 3, reward: { type: 'quake', amount: 1 } },
];

export const DAILY_GOAL = 3;
export const DAILY_REWARD = { type: 'rain', amount: 20 };

/** The mission at `level` (1-based). */
export function missionAt(level) {
  const index = Math.max(1, Math.floor(level)) - 1;
  return index < INTRO.length ? INTRO[index] : ROTATION[(index - INTRO.length) % ROTATION.length];
}

/** HUD text for a mission and its progress, e.g. '推落金幣 3 / 5'. */
export function missionText(mission, progress) {
  return `${KIND_TEXT[mission.kind]} ${Math.min(progress, mission.target)} / ${mission.target}`;
}

/** Reward text for the completion notice, e.g. '硬幣雨 ×8'. */
export function rewardText(reward) {
  if (reward.type === 'rain') return `硬幣雨 ×${reward.amount}`;
  if (reward.type === 'quake') return '地震';
  return '鍍金';
}

/**
 * Progress after one game event. `event` is one of
 * { type: 'payout', score, premium, combo }, { type: 'drop' }, { type: 'chest' } or { type: 'open' };
 * anything the mission does not count leaves progress as it was.
 */
export function advance(mission, progress, event) {
  if (event.type === 'payout') {
    if (mission.kind === 'score') return progress + event.score;
    if (mission.kind === 'premium') return progress + event.premium;
    if (mission.kind === 'combo') return Math.max(progress, event.combo);
    return progress;
  }
  return mission.kind === event.type ? progress + 1 : progress;
}

/** Local calendar day as 'YYYY-MM-DD', so the daily count rolls over at the player's midnight. */
export function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Saved mission state, cleaned: storage is untrusted, and a missing or broken save starts at
 * level 1. The daily count only survives if it is from `today`.
 */
export function loadMissionState(saved, today) {
  const level = Number.isInteger(saved?.level) && saved.level >= 1 ? saved.level : 1;
  const progress = Number.isFinite(saved?.progress) && saved.progress >= 0 ? saved.progress : 0;
  const sameDay = saved?.day === today;
  const done = sameDay && Number.isInteger(saved?.done) && saved.done >= 0 ? saved.done : 0;
  return { level, progress, day: today, done, bonus: sameDay && saved?.bonus === true };
}

/**
 * Applies one event. Returns the next state and what to pay: the mission's reward when it
 * finishes, plus the daily reward the first time today's count reaches DAILY_GOAL. Progress past
 * the target does not spill into the next mission. A finish that lands on a new day starts that
 * day's count.
 */
export function step(state, event, today) {
  const mission = missionAt(state.level);
  const progress = advance(mission, state.progress, event);
  if (progress < mission.target) return { state: { ...state, progress }, rewards: [] };

  const fresh = state.day === today ? state : { ...state, day: today, done: 0, bonus: false };
  const done = fresh.done + 1;
  const bonus = !fresh.bonus && done >= DAILY_GOAL;
  return {
    state: { ...fresh, level: state.level + 1, progress: 0, done, bonus: fresh.bonus || bonus },
    rewards: bonus ? [mission.reward, DAILY_REWARD] : [mission.reward],
    finished: mission,
  };
}
