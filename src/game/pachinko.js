const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

/**
 * Create staggered pin centres in world units (x across, y up).
 * Rows span top to bottom with coin clearance at both ends. Horizontal gaps
 * admit a coin plus 0.12 units; side lanes admit a coin plus 0.05 units.
 * @param {{halfWidth: number, top: number, bottom: number, rows: number,
 * pinRadius: number, coinRadius: number}} dimensions
 * @returns {Array<{x: number, y: number, radius: number}>}
 */
export function pinLayout({ halfWidth, top, bottom, rows, pinRadius, coinRadius }) {
  if (rows <= 0) return [];
  const reach = halfWidth - (2 * coinRadius + pinRadius + 0.05);
  if (reach < 0) return [];
  const inset = coinRadius + pinRadius + 0.05;
  const upper = Math.max((top + bottom) / 2, top - inset);
  const lower = Math.min((top + bottom) / 2, bottom + inset);
  const rowGap = rows > 1 ? (upper - lower) / (rows - 1) : Infinity;
  // Adjacent staggered rows must also leave a traversable diagonal channel.
  const diagonalClearance = 2 * (coinRadius + pinRadius) + 0.05;
  const diagonalPitch = 2 * Math.sqrt(Math.max(0, diagonalClearance ** 2 - rowGap ** 2));
  const minPitch = Math.max(2 * pinRadius + 2 * coinRadius + 0.12, diagonalPitch);
  const intervals = Math.floor(2 * reach / minPitch);
  const pitch = intervals > 0 ? 2 * reach / intervals : minPitch;
  return Array.from({ length: rows }, (_, row) => {
    const count = intervals + 1 - ((row + 1) % 2);
    const y = rows === 1 ? (top + bottom) / 2 : upper + (lower - upper) * row / (rows - 1);
    return Array.from({ length: Math.max(1, count) }, (_, column) => ({
      x: count > 1 ? (column - (count - 1) / 2) * pitch : 0,
      y,
      radius: pinRadius,
    }));
  }).flat();
}

/**
 * Leave enough room for a coin between each bumper and the nearest pins.
 * Pins carry their radius (as produced by pinLayout); inputs are not mutated.
 * @param {Array<{x: number, y: number, radius: number}>} pins
 * @param {Array<{x: number, y: number, radius: number}>} bumpers
 * @param {number} coinRadius
 * @returns {Array<{x: number, y: number, radius: number}>}
 */
export function clearPinsAround(pins, bumpers, coinRadius) {
  return pins.filter((pin) => bumpers.every((bumper) =>
    Math.hypot(pin.x - bumper.x, pin.y - bumper.y)
      >= bumper.radius + pin.radius + 2 * coinRadius + 0.05));
}

/**
 * Simulate one circular coin using swept circle collisions to prevent tunnelling.
 * Pins retain tangential speed with a seeded kick; bumpers also boost normal speed.
 * Contact sets rolling spin, which decays slowly in free flight.
 * After maxTime a persistent sideways nudge clears balanced coins into a side lane.
 * @param {{x: number, y: number, vx?: number, vy?: number, ceiling?: number}} start Initial coin
 * centre, clear of obstacles. vx/vy launch it (default: a tiny random drift from rest); ceiling is
 * the glass top (default start.y), so a coin thrown upwards has room to arc.
 * @param {{pins: Array<{x: number, y: number}>, pinRadius: number,
 * bumpers?: Array<{x: number, y: number, radius: number}>,
 * coinRadius: number, halfWidth: number, bottom: number}} board
 * @param {() => number} [random=Math.random] Random source returning values in [0, 1).
 * @param {{gravity?: number, restitution?: number, bumperRestitution?: number,
 * bumperKick?: number, bumperCooldown?: number, maxSpeed?: number, dt?: number,
 * sampleEvery?: number, maxTime?: number}} [options={}]
 * Defaults: gravity 24, restitution 0.45, bumperRestitution 0.8, bumperKick 3.5,
 * bumperCooldown 0.3, maxSpeed 9, dt 1/240, sampleEvery 2, maxTime 5.
 * The board has a glass top at start.ceiling: nothing climbs above it.
 * @returns {{path: Array<{t: number, x: number, y: number, angle: number}>,
 * hits: Array<{t: number, kind: 'pin'|'bumper'|'wall', index: number|null,
 * x: number, y: number, speed: number}>, exitX: number, duration: number}}
 * Final sample is exactly at board.bottom. Hits give surface contact coordinates
 * and incoming normal speed, debounced per obstacle (each wall separately) by 0.08s.
 */
export function simulateDrop(start, board, random = Math.random, options = {}) {
  // A bumper that adds energy on every touch pumps a coin wedged against it to absurd speeds, which
  // is what threw coins off the board: so a kick never beats the coin's own speed by much, one
  // bumper kicks at most once per cooldown, and nothing ever moves faster than maxSpeed.
  const { gravity = 24, restitution = 0.45, bumperRestitution = 0.8, bumperKick = 3.5,
    bumperCooldown = 0.3, maxSpeed = 9, dt = 1 / 240, sampleEvery = 2, maxTime = 5 } = options;
  if (!(dt > 0) || !(gravity > 0) || !(sampleEvery >= 1) || !(board.coinRadius > 0)) {
    throw new RangeError('Positive dt, gravity, coinRadius and sampleEvery >= 1 are required');
  }
  const limit = board.halfWidth - board.coinRadius;
  const obstacles = [
    ...board.pins.map((pin, index) => ({ ...pin, radius: board.pinRadius, kind: 'pin', index })),
    ...(board.bumpers ?? []).map((bumper, index) => ({ ...bumper, kind: 'bumper', index })),
  ];
  let x = clamp(start.x, limit);
  let y = Math.max(start.y, board.bottom);
  let vx = start.vx ?? (random() - 0.5) * 0.16;
  let vy = start.vy ?? 0;
  let angle = 0;
  let spin = -vx / board.coinRadius;
  let t = 0;
  let step = 0;
  let escapeDirection = 0;
  const path = [{ t, x, y, angle }];
  const hits = [];
  const lastImpacts = new Map();
  const lastKicks = new Map();
  const ceiling = Math.max(start.ceiling ?? start.y, board.bottom);
  const capSpeed = () => {
    const speed = Math.hypot(vx, vy);
    if (speed <= maxSpeed) return;
    vx *= maxSpeed / speed;
    vy *= maxSpeed / speed;
  };
  const result = () => ({ path, hits, exitX: clamp(x, limit), duration: t });
  if (y === board.bottom) return result();

  while (y > board.bottom) {
    if (t >= maxTime && escapeDirection === 0) escapeDirection = x < 0 ? -1 : 1;
    // A coin balanced on a pin or bouncing on a bumper's crown gets a steady sideways lean. The
    // speed cap keeps it from turning into the shove that used to throw coins off the tray.
    if (escapeDirection !== 0) vx += escapeDirection * 60 * dt;
    vy -= gravity * dt;
    capSpeed();
    let remaining = dt;
    let elapsed = 0;

    for (let contact = 0; contact < 16 && remaining > 1e-10; contact += 1) {
      let hitTime = remaining;
      let hit = null;
      if (vy < 0) {
        const bottomTime = (board.bottom - y) / vy;
        if (bottomTime >= 0 && bottomTime <= hitTime) {
          hitTime = bottomTime;
          hit = { kind: 'bottom' };
        }
      }
      if (vx !== 0) {
        const nx = vx > 0 ? -1 : 1;
        const wallTime = (-(nx * limit) - x) / vx;
        if (wallTime >= -1e-10 && wallTime <= hitTime) {
          hitTime = Math.max(0, wallTime);
          hit = { kind: 'wall', index: null, nx, ny: 0 };
        }
      }
      const speedSquared = vx * vx + vy * vy;
      for (const obstacle of obstacles) {
        const radius = board.coinRadius + obstacle.radius;
        const dx = x - obstacle.x;
        const dy = y - obstacle.y;
        const approach = dx * vx + dy * vy;
        if (approach >= -1e-10 || speedSquared === 0) continue;
        const c = dx * dx + dy * dy - radius * radius;
        const discriminant = approach * approach - speedSquared * c;
        if (discriminant < 0) continue;
        const obstacleTime = Math.max(0, (-approach - Math.sqrt(discriminant)) / speedSquared);
        if (obstacleTime > hitTime) continue;
        const hx = dx + vx * obstacleTime;
        const hy = dy + vy * obstacleTime;
        const distance = Math.hypot(hx, hy);
        hitTime = obstacleTime;
        hit = { ...obstacle, nx: hx / distance, ny: hy / distance };
      }

      x += vx * hitTime;
      y += vy * hitTime;
      const spinDecay = Math.exp(-0.35 * hitTime);
      angle += spin * (1 - spinDecay) / 0.35;
      spin *= spinDecay;
      elapsed += hitTime;
      remaining -= hitTime;
      if (!hit) break;
      if (hit.kind === 'bottom') {
        y = board.bottom;
        x = clamp(x, limit);
        t += elapsed;
        path.push({ t, x, y, angle });
        return result();
      }
      const { nx, ny, kind, index } = hit;
      const normalSpeed = vx * nx + vy * ny;
      const impactTime = t + elapsed;
      const key = `${kind}:${kind === 'wall' ? nx : index}`;
      if (impactTime - (lastImpacts.get(key) ?? -Infinity) >= 0.08) {
        hits.push({ t: impactTime, kind, index,
          x: x - nx * board.coinRadius, y: y - ny * board.coinRadius,
          speed: -normalSpeed });
        lastImpacts.set(key, impactTime);
      }
      if (kind === 'wall') {
        x = -nx * limit;
        vx = -vx * restitution;
        spin = vy * nx / board.coinRadius;
        continue;
      }
      const radius = board.coinRadius + hit.radius;
      x = hit.x + nx * (radius + 1e-9);
      y = hit.y + ny * (radius + 1e-9);
      // No kicks once escaping: the point by then is to let the coin fall.
      const kicks = kind === 'bumper' && escapeDirection === 0
        && impactTime - (lastKicks.get(index) ?? -Infinity) >= bumperCooldown;
      if (kicks) lastKicks.set(index, impactTime);
      const tangentSpeed = -vx * ny + vy * nx + (random() - 0.5) * (kicks ? 3 : 4.4);
      const outgoing = kicks
        ? Math.max(-normalSpeed * bumperRestitution, bumperKick)
        : -normalSpeed * restitution + 0.04;
      // Match rolling speed at contact; free flight retains this angular momentum.
      spin = tangentSpeed / board.coinRadius;
      vx = outgoing * nx - tangentSpeed * ny;
      vy = outgoing * ny + tangentSpeed * nx;
      capSpeed();
    }
    if (y > ceiling) {
      y = ceiling;
      vy = -Math.abs(vy) * restitution;
    }
    t += dt;
    step += 1;
    if (step % sampleEvery === 0) path.push({ t, x: clamp(x, limit), y, angle });
  }
  return result();
}
