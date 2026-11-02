import { describe, expect, it } from 'vitest';
import {
  afterLoss, ballSaved, hitPearls, inRescueMouth, RESCUE_MOUTH_WIDTH, rescueKick, rescueMouthX, settleDone,
  STAR_BOARD, START_LIVES,
} from '../src/game/astral.js';
import { PIN_BOARD } from '../src/game/CoinPusher.js';
import { calculateReward } from '../src/game/rules.js';
import {
  BALL_RADIUS, createFlippers, flipperLayout, flipperTip, launchBall, stepBoard,
} from '../src/game/pinball.js';

const layout = flipperLayout(PIN_BOARD);
const board = {
  halfWidth: PIN_BOARD.halfWidth, bottom: PIN_BOARD.bottom, ceiling: PIN_BOARD.top + 0.3,
  pins: STAR_BOARD.posts, bumpers: STAR_BOARD.targets, guides: layout.guides,
};
const run = (ball, flippers, input, seconds, into = board) => {
  const hits = [];
  for (let frame = 0; frame < seconds * 60; frame += 1) {
    const step = stepBoard(ball, flippers, into, input(frame / 60), 1 / 60);
    hits.push(...step.hits);
    if (step.drained) return { hits, drained: true };
  }
  return { hits, drained: false };
};

describe('flippers', () => {
  it('leave a gap at rest that a ball can drain through, and close it raised', () => {
    const [left, right] = createFlippers(layout);
    const gap = flipperTip(right, right.angle).x - flipperTip(left, left.angle).x;
    expect(gap).toBeGreaterThan(BALL_RADIUS * 2);
    expect(gap).toBeLessThan(BALL_RADIUS * 8);
  });

  it('rise while held and fall back when let go', () => {
    const flippers = createFlippers(layout);
    const rest = flippers[0].angle;
    stepBoard(launchBall(0, 8), flippers, board, { left: true, right: false }, 0.1);
    expect(flippers[0].angle).toBeGreaterThan(rest);
    expect(flippers[1].angle).toBe(rest);
    stepBoard(launchBall(0, 8), flippers, board, { left: false, right: false }, 0.1);
    expect(flippers[0].angle).toBe(rest);
  });

  it('drive a ball sitting on one back up the board', () => {
    const empty = { ...board, pins: [], bumpers: [] };
    const flippers = createFlippers(layout);
    const tip = flipperTip(flippers[0], flippers[0].angle);
    const ball = launchBall((flippers[0].x + tip.x) / 2, 2.6);
    let top = 0;
    run(ball, flippers, (time) => ({ left: time > 0.18, right: false }), 1.2, empty);
    top = ball.y;
    for (let frame = 0; frame < 60; frame += 1) {
      stepBoard(ball, flippers, empty, { left: false, right: false }, 1 / 60);
      top = Math.max(top, ball.y);
    }
    expect(top).toBeGreaterThan(4);
  });
});

describe('the ball on the board', () => {
  it('drains through an unattended gap, inside the walls all the way', () => {
    const ball = launchBall(0.1, 8);
    const flippers = createFlippers(layout);
    let wall = 0;
    for (let frame = 0; frame < 60 * 40; frame += 1) {
      wall = Math.max(wall, Math.abs(ball.x));
      if (stepBoard(ball, flippers, board, { left: false, right: false }, 1 / 60).drained) break;
    }
    expect(ball.y).toBeLessThan(board.bottom + 0.05);
    expect(wall).toBeLessThanOrEqual(board.halfWidth);
  });

  it('kicks a bumper once per contact, not once per substep', () => {
    const bumper = board.bumpers[0];
    const ball = launchBall(bumper.x, bumper.y + 0.7);
    const { hits } = run(ball, createFlippers(layout), () => ({ left: false, right: false }), 0.5,
      { ...board, pins: [] });
    expect(hits.filter(({ kind }) => kind === 'bumper')).toHaveLength(1);
  });

  it('shoves a ball balanced at rest rather than leaving it for good', () => {
    const pin = { x: 0, y: 5, radius: 0.06 };
    const ball = launchBall(0, 5 + 0.06 + BALL_RADIUS);
    ball.vy = 0;
    run(ball, [], () => ({ left: false, right: false }), 3, { ...board, pins: [pin], bumpers: [] });
    expect(Math.abs(ball.x)).toBeGreaterThan(0.1);
  });
});

describe('star machine rules', () => {
  it('earns pearls from targets only, the centre paying most', () => {
    expect(hitPearls({ kind: 'bumper', index: 0 })).toBe(2);
    expect(hitPearls({ kind: 'bumper', index: 1 })).toBe(2);
    expect(hitPearls({ kind: 'bumper', index: 2 })).toBe(5);
    expect(hitPearls({ kind: 'pin', index: 0 })).toBe(0);
  });

  it('forgives one quick drain a ball, not every one', () => {
    expect(ballSaved(3, false)).toBe(true);
    expect(ballSaved(3, true)).toBe(false);
    expect(ballSaved(9, false)).toBe(false);
  });

  it('calls the pile settled once it goes quiet, or after a ceiling', () => {
    expect(settleDone(1, 5)).toBe(false);
    expect(settleDone(2.5, 5)).toBe(true);
    expect(settleDone(0, 20)).toBe(true);
  });

  it('hops the rescued ball forward, towards the pressed side', () => {
    expect(rescueKick(-1).x).toBeLessThan(0);
    expect(rescueKick(1).x).toBeGreaterThan(0);
    expect(rescueKick(1).z).toBeLessThan(0);
    expect(rescueKick(1).y).toBeGreaterThan(0);
  });

  it('lights the recovery mouth away from the ball, and only saves a ball through it', () => {
    let roll = 0;
    const random = () => { roll = (roll + 0.137) % 1; return roll; };
    for (let run = 0; run < 40; run += 1) {
      expect(Math.abs(rescueMouthX(1, random) - 1)).toBeGreaterThanOrEqual(1.5);
    }
    expect(inRescueMouth(1 + RESCUE_MOUTH_WIDTH / 2 - 0.01, 1)).toBe(true);
    expect(inRescueMouth(1 + RESCUE_MOUTH_WIDTH / 2 + 0.01, 1)).toBe(false);
  });

  it('resets the ball level on a loss and ends on the last life', () => {
    expect(afterLoss(START_LIVES)).toEqual({ lives: START_LIVES - 1, ballLevel: 1, over: false });
    expect(afterLoss(1).over).toBe(true);
  });

  it('pays a star core its own value, combo rules untouched', () => {
    expect(calculateReward([{ value: 30 }, { isPremium: false }], 0, 99).base).toBe(31);
  });
});
