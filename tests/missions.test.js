import { describe, expect, it } from 'vitest';
import {
  DAILY_GOAL, DAILY_REWARD, advance, loadMissionState, localDay, missionAt, missionText, step,
} from '../src/game/missions.js';

const payout = (score, premium = 0, combo = 1) => ({ type: 'payout', score, premium, combo });

describe('missionAt', () => {
  it('never repeats a kind back to back, across the intro and the rotation wrap', () => {
    for (let level = 1; level < 60; level += 1) {
      expect(missionAt(level + 1).kind).not.toBe(missionAt(level).kind);
    }
  });

  it('stops getting harder once the rotation loops', () => {
    expect(missionAt(4)).toBe(missionAt(13));
    expect(missionAt(1000).target).toBeLessThanOrEqual(300);
  });
});

describe('advance', () => {
  it('feeds each kind from its own event', () => {
    expect(advance({ kind: 'score' }, 4, payout(3, 1, 2))).toBe(7);
    expect(advance({ kind: 'premium' }, 1, payout(3, 1, 2))).toBe(2);
    expect(advance({ kind: 'combo' }, 4, payout(3, 1, 2))).toBe(4);
    expect(advance({ kind: 'combo' }, 4, payout(9, 0, 6))).toBe(6);
    expect(advance({ kind: 'chest' }, 0, { type: 'chest' })).toBe(1);
    expect(advance({ kind: 'chest' }, 0, { type: 'open' })).toBe(0);
    expect(advance({ kind: 'score' }, 5, { type: 'open' })).toBe(5);
  });
});

describe('step', () => {
  const today = '2026-10-27';
  const big = payout(999, 99, 99);
  // Feeds the current mission whatever finishes it; returns every step's result.
  const finish = (state, day = today) => {
    const mission = missionAt(state.level);
    const event = mission.kind === 'drop' || mission.kind === 'chest' || mission.kind === 'open'
      ? { type: mission.kind }
      : big;
    const results = [];
    for (let fed = 0; fed < mission.target; fed += 1) {
      results.push(step(results.at(-1)?.state ?? state, event, day));
      if (results.at(-1).finished) break;
    }
    return results;
  };

  it('pays the reward once, on the step that reaches the target, without spilling progress', () => {
    const results = finish(loadMissionState(null, today));
    expect(results).toHaveLength(missionAt(1).target);
    expect(results.slice(0, -1).every((result) => result.rewards.length === 0)).toBe(true);
    expect(results.at(-1).rewards).toEqual([missionAt(1).reward]);
    expect(results.at(-1).state).toMatchObject({ level: 2, progress: 0, done: 1 });
  });

  it('adds the daily reward exactly once, on the DAILY_GOAL-th finish of the day', () => {
    let state = loadMissionState(null, today);
    const paid = [];
    for (let mission = 0; mission < DAILY_GOAL + 2; mission += 1) {
      const last = finish(state).at(-1);
      paid.push(last.rewards.length);
      state = last.state;
    }
    expect(paid).toEqual([1, 1, 2, 1, 1]);
    expect(state.bonus).toBe(true);
    expect(finish({ ...state, done: 2, bonus: false }).at(-1).rewards).toContainEqual(DAILY_REWARD);
  });

  it('starts a new day count when a mission finishes after midnight', () => {
    const yesterday = { ...loadMissionState(null, '2026-10-26'), level: 4, done: 5, bonus: true };
    const last = finish(yesterday).at(-1);
    expect(last.state).toMatchObject({ day: today, done: 1, bonus: false });
    expect(last.rewards).toHaveLength(1);
  });
});

describe('loadMissionState', () => {
  it('rejects broken saves and drops a stale daily count', () => {
    expect(loadMissionState({ level: -3, progress: 'x' }, '2026-10-27')).toMatchObject({ level: 1, progress: 0 });
    expect(loadMissionState({ level: 7, progress: 4, day: '2026-10-26', done: 3, bonus: true }, '2026-10-27'))
      .toMatchObject({ level: 7, progress: 4, done: 0, bonus: false });
  });
});

it('formats the HUD line and the local day', () => {
  expect(missionText({ kind: 'premium', target: 5 }, 7)).toBe('推落金幣 5 / 5');
  expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
});
