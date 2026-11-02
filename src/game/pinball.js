// The hero ball's board: a live 2D simulation, unlike pachinko.js, which works a whole fall out up
// front and plays it back. A flipper has to answer the player mid-flight, so this steps with the
// frame. Coordinates are the pin board's own (x across, y up). Gravity is well under the coins' 24:
// at that a ball falls the board in 0.7 s, too fast to read and flip. With the star board's layout,
// 240 bot balls: aimed flips lasted 18 s and earned 29 pearls, mashing 14 s and 19. A flatter flipper
// rest (-0.45) traps the ball against the drain post, so -0.5 is as tight as this goes.

export const BALL_RADIUS = 0.2;
const GRAVITY = 5.5;
const MAX_SPEED = 15;
const SUBSTEP = 1 / 240;
const WALL_BOUNCE = 0.5;
const PIN_BOUNCE = 0.9;
const BUMPER_BOUNCE = 0.8;
const BUMPER_KICK = 5;
const BUMPER_COOLDOWN = 0.5;
const FLIPPER_THICKNESS = 0.09;
const FLIPPER_LENGTH = 1.2;
const FLIPPER_SPEED = 24;
// Radians from level: the rest pose slopes down to the drain, the raised one up from it.
const FLIPPER_REST = -0.5;
const FLIPPER_UP = 0.45;
const FLIPPER_BOUNCE = 0.6;
// A ball resting on a pin or a raised flipper gets a shove rather than sitting there for good.
const STUCK_SPEED = 0.35;
const STUCK_SECONDS = 1.2;
const STUCK_KICK = 2.5;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Where each flipper hinges, and the guides feeding it, for a board of these bounds. */
export function flipperLayout({ halfWidth, bottom }) {
  const pivotX = 1.6;
  const pivotY = bottom + 0.75;
  return {
    pivots: [{ x: -pivotX, y: pivotY, side: -1 }, { x: pivotX, y: pivotY, side: 1 }],
    guides: [-1, 1].map((side) => ({
      a: { x: side * halfWidth, y: pivotY + 1.35 },
      b: { x: side * pivotX, y: pivotY },
    })),
  };
}

/** A flipper's far end, from its signed angle above level. */
export function flipperTip({ x, y, side }, angle) {
  return { x: x - side * FLIPPER_LENGTH * Math.cos(angle), y: y + FLIPPER_LENGTH * Math.sin(angle) };
}

const closestOnSegment = (px, py, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = clamp(((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return { x: a.x + dx * t, y: a.y + dy * t };
};

/** A ball at rest, ready to be launched from `x` at the board's top. */
export function launchBall(x, y) {
  return { x, y, vx: 0, vy: -1, stuckFor: 0 };
}

/** Fresh flippers for a board: both down. */
export function createFlippers(layout) {
  return layout.pivots.map((pivot) => ({ ...pivot, angle: FLIPPER_REST, speed: 0 }));
}

const bounceOff = (ball, normal, bounce, surfaceX = 0, surfaceY = 0) => {
  const along = (ball.vx - surfaceX) * normal.x + (ball.vy - surfaceY) * normal.y;
  if (along >= 0) return 0;
  ball.vx -= (1 + bounce) * along * normal.x;
  ball.vy -= (1 + bounce) * along * normal.y;
  return -along;
};

const pushOut = (ball, from, reach) => {
  const dx = ball.x - from.x;
  const dy = ball.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= reach) return null;
  const normal = distance > 1e-6 ? { x: dx / distance, y: dy / distance } : { x: 0, y: 1 };
  ball.x = from.x + normal.x * reach;
  ball.y = from.y + normal.y * reach;
  return normal;
};

function moveFlipper(flipper, held, seconds) {
  const target = held ? FLIPPER_UP : FLIPPER_REST;
  const reach = FLIPPER_SPEED * seconds;
  const next = flipper.angle + clamp(target - flipper.angle, -reach, reach);
  flipper.speed = (next - flipper.angle) / seconds;
  flipper.angle = next;
}

function hitFlipper(ball, flipper) {
  const tip = flipperTip(flipper, flipper.angle);
  const point = closestOnSegment(ball.x, ball.y, flipper, tip);
  const normal = pushOut(ball, point, BALL_RADIUS + FLIPPER_THICKNESS);
  if (!normal) return;
  // The surface's own speed at the contact: what turns a raised flipper into a bat. Positive angle
  // speed lifts the tip on either side, so the sign follows which way the blade points.
  const armX = point.x - flipper.x;
  const armY = point.y - flipper.y;
  const omega = flipper.speed * flipper.side * -1;
  bounceOff(ball, normal, FLIPPER_BOUNCE, -omega * armY, omega * armX);
}

/**
 * Advances the board by `seconds`. `input` is { left, right }, held. Returns the hits since the
 * last call - { kind: 'pin' | 'bumper', index, x, y, speed } - and whether the ball drained.
 * `cooldowns` is a Map the caller keeps between calls, so a bumper kicks once per contact.
 */
export function stepBoard(ball, flippers, board, input, seconds, cooldowns = new Map()) {
  const hits = [];
  const limit = board.halfWidth - BALL_RADIUS;
  let left = seconds;
  while (left > 1e-9) {
    const dt = Math.min(SUBSTEP, left);
    left -= dt;
    for (const flipper of flippers) moveFlipper(flipper, flipper.side < 0 ? input.left : input.right, dt);
    ball.vy -= (board.gravity ?? GRAVITY) * dt;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > MAX_SPEED) {
      ball.vx *= MAX_SPEED / speed;
      ball.vy *= MAX_SPEED / speed;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    if (Math.abs(ball.x) > limit) {
      ball.x = Math.sign(ball.x) * limit;
      ball.vx = -ball.vx * WALL_BOUNCE;
    }
    if (ball.y > board.ceiling - BALL_RADIUS) {
      ball.y = board.ceiling - BALL_RADIUS;
      ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE;
    }
    for (const guide of board.guides) {
      const normal = pushOut(ball, closestOnSegment(ball.x, ball.y, guide.a, guide.b), BALL_RADIUS + 0.03);
      if (normal) bounceOff(ball, normal, WALL_BOUNCE);
    }
    board.pins.forEach((pin, index) => {
      const normal = pushOut(ball, pin, BALL_RADIUS + pin.radius);
      if (!normal) return;
      const impact = bounceOff(ball, normal, PIN_BOUNCE);
      if (impact > 0.5) hits.push({ kind: 'pin', index, x: pin.x, y: pin.y, speed: impact });
    });
    board.bumpers.forEach((bumper, index) => {
      const normal = pushOut(ball, bumper, BALL_RADIUS + bumper.radius);
      if (!normal) return;
      const impact = bounceOff(ball, normal, BUMPER_BOUNCE);
      if ((cooldowns.get(index) ?? 0) > 0) return;
      cooldowns.set(index, BUMPER_COOLDOWN);
      ball.vx += normal.x * BUMPER_KICK;
      ball.vy += normal.y * BUMPER_KICK;
      hits.push({ kind: 'bumper', index, x: bumper.x, y: bumper.y, speed: Math.max(impact, 3) });
    });
    for (const flipper of flippers) hitFlipper(ball, flipper);
    for (const [index, wait] of cooldowns) cooldowns.set(index, wait - dt);

    ball.stuckFor = Math.hypot(ball.vx, ball.vy) < STUCK_SPEED ? ball.stuckFor + dt : 0;
    if (ball.stuckFor > STUCK_SECONDS) {
      ball.stuckFor = 0;
      ball.vx += (ball.x > 0 ? -1 : 1) * STUCK_KICK;
      ball.vy += STUCK_KICK;
    }
    if (ball.y < board.bottom) return { hits, drained: true };
  }
  return { hits, drained: false };
}
