import { describe, expect, it } from 'vitest';
import { clearPinsAround, pinLayout, simulateDrop } from '../src/game/pachinko.js';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const dimensions = {
  halfWidth: 3.45, top: 6.6, bottom: 1.6, rows: 10, pinRadius: 0.06, coinRadius: 0.36,
};
const bumpers = [
  { x: -1.9, y: 5.3, radius: 0.32 },
  { x: 1.9, y: 5.3, radius: 0.32 },
  { x: 0, y: 3.9, radius: 0.36 },
];
const layout = pinLayout(dimensions);
const board = { ...dimensions, bumpers, pins: clearPinsAround(layout, bumpers, dimensions.coinRadius) };
const limit = board.halfWidth - board.coinRadius;

function assertPath(result, currentBoard = board) {
  const last = result.path.at(-1);
  expect(result.path[0].t).toBe(0);
  expect(last.y).toBe(currentBoard.bottom);
  expect(result.duration).toBe(last.t);
  expect(result.exitX).toBe(last.x);
  // maxTime (5) plus room for one last kick just before it: a perfectly centred coin on a bumper,
  // with no randomness to break the symmetry, can still be in the air when the escape starts.
  expect(result.duration).toBeLessThan(6.5);
  let minPinDistance = Infinity;
  let minBumperClearance = Infinity;
  let maxWallDistance = 0;
  let minTimeStep = Infinity;
  let allAnglesFinite = true;
  for (const [index, sample] of result.path.entries()) {
    allAnglesFinite &&= Number.isFinite(sample.angle);
    maxWallDistance = Math.max(maxWallDistance, Math.abs(sample.x));
    if (index > 0) minTimeStep = Math.min(minTimeStep, sample.t - result.path[index - 1].t);
    for (const bumper of currentBoard.bumpers ?? []) {
      minBumperClearance = Math.min(minBumperClearance,
        Math.hypot(sample.x - bumper.x, sample.y - bumper.y) - bumper.radius - currentBoard.coinRadius);
    }
    for (const pin of currentBoard.pins) {
      minPinDistance = Math.min(minPinDistance, Math.hypot(sample.x - pin.x, sample.y - pin.y));
    }
  }
  expect(minBumperClearance).toBeGreaterThanOrEqual(-1e-3);
  expect(allAnglesFinite).toBe(true);
  expect(minTimeStep).toBeGreaterThan(0);
  expect(maxWallDistance).toBeLessThanOrEqual(currentBoard.halfWidth - currentBoard.coinRadius + 1e-9);
  expect(minPinDistance).toBeGreaterThanOrEqual(currentBoard.coinRadius + currentBoard.pinRadius - 1e-3);
}

describe('pinLayout', () => {
  it('spreads ten staggered rows with passable gaps and wall clearance', () => {
    const ys = [...new Set(layout.map((pin) => pin.y))];
    expect(ys).toHaveLength(dimensions.rows);
    const rows = ys.map((y) => layout.filter((pin) => pin.y === y));
    for (const pin of rows[0]) {
      for (const next of rows[1]) {
        expect(Math.hypot(pin.x - next.x, pin.y - next.y))
          .toBeGreaterThanOrEqual(2 * (dimensions.coinRadius + dimensions.pinRadius) + 0.05 - 1e-9);
      }
    }
    const pitch = rows[0][1].x - rows[0][0].x;
    expect(layout).toHaveLength(rows[0].length * 5 + rows[1].length * 5);
    expect(Math.abs(rows[1][0].x - rows[0][0].x)).toBeCloseTo(pitch / 2);
    for (const [index, row] of rows.entries()) {
      expect(row.map((pin) => pin.x)).toEqual(rows[index % 2].map((pin) => pin.x));
      if (index > 1) expect(ys[index - 1] - ys[index]).toBeCloseTo(ys[0] - ys[1]);
      for (const [column, pin] of row.entries()) {
        expect(dimensions.halfWidth - Math.abs(pin.x)).toBeGreaterThanOrEqual(
          dimensions.coinRadius + dimensions.pinRadius + 0.05 - 1e-9,
        );
        if (column > 0) expect(pin.x - row[column - 1].x - 2 * dimensions.pinRadius)
          .toBeGreaterThanOrEqual(2 * dimensions.coinRadius + 0.12 - 1e-9);
      }
    }
  });
});

describe('clearPinsAround', () => {
  it('removes pins that would close the coin lane without mutating the layout', () => {
    expect(board.pins.length).toBeLessThan(layout.length);
    for (const pin of layout) {
      const blocked = bumpers.some((bumper) => Math.hypot(pin.x - bumper.x, pin.y - bumper.y)
        < bumper.radius + dimensions.pinRadius + 2 * dimensions.coinRadius + 0.05);
      expect(board.pins.includes(pin)).toBe(!blocked);
    }
    expect(clearPinsAround(layout, [], dimensions.coinRadius)).toEqual(layout);
    expect(layout).toEqual(pinLayout(dimensions));
  });
});

describe('simulateDrop', () => {
  it.each([['pin', 0.06], ['bumper', 0.32]])('sweeps a %s at coarse steps', (kind, radius) => {
    const obstacleBoard = { ...dimensions, pins: [], bumpers: [] };
    obstacleBoard[kind === 'pin' ? 'pins' : 'bumpers'] = [{ x: 0, y: 3, radius }];
    const result = simulateDrop({ x: 0, y: 6.6 }, obstacleBoard, mulberry32(12),
      { dt: 0.1, sampleEvery: 1, gravity: 120 });
    assertPath(result, obstacleBoard);
    expect(result.hits.some((hit) => hit.kind === kind)).toBe(true);
  });

  it.each([
    [4.7, {}], [6.6, {}],
    [4.7, { bumperRestitution: 1.5, bumperKick: 10 }],
    [6.6, { bumperRestitution: 1.5, bumperKick: 10 }],
  ])('kicks on bumper contact from y=%s with options %j', (y, options) => {
    const isolated = { ...dimensions, pins: [], bumpers: [{ x: 0, y: 3.9, radius: 0.36 }] };
    const result = simulateDrop({ x: 0, y }, isolated, () => 0.5,
      { ...options, dt: 1 / 1000, sampleEvery: 1 });
    const hit = result.hits.find((event) => event.kind === 'bumper');
    expect(hit).toBeDefined();
    const before = result.path.filter((sample) => sample.t < hit.t).slice(-2);
    const after = result.path.filter((sample) => sample.t > hit.t).slice(0, 2);
    const speed = ([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) / (b.t - a.t);
    // A slow arrival is kicked up to bumperKick, a fast one leaves a little slower than it came,
    // and nothing beats maxSpeed (9) - the cap is what keeps coins on the board.
    const expected = Math.min(9, Math.max(hit.speed * (options.bumperRestitution ?? 0.8),
      options.bumperKick ?? 3.5));
    expect(speed(after)).toBeCloseTo(expected, 1);
    if (speed(before) < expected) expect(speed(after)).toBeGreaterThan(speed(before));
    assertPath(result, isolated);
  });

  // The bug this guards: bumpers added energy on every touch, so a coin wedged against one was
  // pumped to ~68 units/s, thrown above the slot and off the tray at the hand-off.
  it('never climbs above where the coin came in or moves faster than maxSpeed', () => {
    const random = mulberry32(7);
    for (let drop = 0; drop < 300; drop += 1) {
      const { path } = simulateDrop({ x: 0, y: 7.1 }, board, random);
      for (let index = 1; index < path.length; index += 1) {
        const [a, b] = [path[index - 1], path[index]];
        expect(b.y).toBeLessThanOrEqual(7.1 + 1e-9);
        expect(Math.hypot(b.x - a.x, b.y - a.y) / (b.t - a.t)).toBeLessThanOrEqual(9 + 1e-6);
      }
    }
  });

  // The money bag's burst: thrown sideways and up from under the glass top.
  it('arcs a launched coin up to its ceiling, never past it, and still exits at the bottom', () => {
    const random = mulberry32(21);
    let rose = false;
    for (let drop = 0; drop < 100; drop += 1) {
      const side = drop % 2 ? 1 : -1;
      const start = { x: 0, y: 6.5, vx: side * 6, vy: 4, ceiling: 7.1 };
      const { path } = simulateDrop(start, board, random);
      rose ||= path.some((sample) => sample.y > start.y + 0.1);
      path.forEach((sample) => expect(sample.y).toBeLessThanOrEqual(7.1 + 1e-9));
      expect(path.at(-1).y).toBe(board.bottom);
    }
    expect(rose).toBe(true);
  });

  it('escapes a balanced bumper after maxTime', () => {
    const isolated = { ...dimensions, pins: [], bumpers: [{ x: 0, y: 3.9, radius: 0.36 }] };
    const result = simulateDrop({ x: 0, y: 4.7 }, isolated, () => 0.5, { maxTime: 0.5 });
    assertPath(result, isolated);
    expect(result.duration).toBeLessThan(2);
  });

  it('retains tangential pin speed and uses the default normal restitution', () => {
    const isolated = { ...dimensions, pins: [{ x: 0, y: 3 }], bumpers: [] };
    const result = simulateDrop({ x: 0.2, y: 4.8 }, isolated, () => 0.5,
      { dt: 1 / 2000, sampleEvery: 1 });
    const hit = result.hits.find((event) => event.kind === 'pin');
    const nx = hit.x / dimensions.pinRadius;
    const ny = (hit.y - 3) / dimensions.pinRadius;
    const before = result.path.filter((sample) => sample.t < hit.t).slice(-2);
    const after = result.path.filter((sample) => sample.t > hit.t).slice(0, 2);
    const velocity = ([a, b]) => ({ x: (b.x - a.x) / (b.t - a.t), y: (b.y - a.y) / (b.t - a.t) });
    const incoming = velocity(before);
    const outgoing = velocity(after);
    expect(outgoing.x * nx + outgoing.y * ny).toBeCloseTo(hit.speed * 0.45 + 0.04, 1);
    expect(-outgoing.x * ny + outgoing.y * nx).toBeCloseTo(-incoming.x * ny + incoming.y * nx, 1);
  });

  it('keeps contact spin during free flight even as horizontal velocity stays constant', () => {
    const isolated = { ...dimensions, pins: [{ x: 0, y: 3 }], bumpers: [] };
    const result = simulateDrop({ x: 0.2, y: 4.8 }, isolated, () => 0.75, { sampleEvery: 1 });
    const hit = result.hits.find((event) => event.kind === 'pin');
    const samples = result.path.filter((sample) => sample.t > hit.t).slice(0, 20);
    const rate = (a, b) => (b.angle - a.angle) / (b.t - a.t);
    expect(Math.abs(rate(samples[0], samples[1]))).toBeGreaterThan(0.1);
    expect(Math.abs(rate(samples.at(-2), samples.at(-1))))
      .toBeLessThan(Math.abs(rate(samples[0], samples[1])));
    const [a, b] = samples;
    expect(Math.abs(rate(a, b) + (b.x - a.x) / (b.t - a.t) / board.coinRadius)).toBeGreaterThan(0.1);
  });

  it('keeps 400 seeded drops clear and emits ordered, debounced impact events', () => {
    let bumperDrops = 0;
    const durations = [];
    let hitCount = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = mulberry32(seed);
      const x = (random() * 2 - 1) * limit;
      const result = simulateDrop({ x, y: dimensions.top }, board, random);
      assertPath(result);
      durations.push(result.duration);
      hitCount += result.hits.length;
      if (result.hits.some((hit) => hit.kind === 'bumper')) bumperDrops += 1;
      const lastImpact = new Map();
      let previousTime = -Infinity;
      for (const hit of result.hits) {
        expect(['pin', 'bumper', 'wall']).toContain(hit.kind);
        expect(hit.t).toBeGreaterThanOrEqual(previousTime);
        expect(hit.t).toBeLessThanOrEqual(result.duration);
        expect(hit.speed).toBeGreaterThan(0);
        expect(Number.isFinite(hit.x) && Number.isFinite(hit.y)).toBe(true);
        if (hit.kind === 'wall') {
          expect(hit.index).toBeNull();
          expect(Math.abs(hit.x)).toBeCloseTo(board.halfWidth);
        } else {
          const obstacles = hit.kind === 'pin' ? board.pins : board.bumpers;
          expect(Number.isInteger(hit.index) && hit.index >= 0 && hit.index < obstacles.length).toBe(true);
          const obstacle = obstacles[hit.index];
          expect(Math.hypot(hit.x - obstacle.x, hit.y - obstacle.y))
            .toBeCloseTo(hit.kind === 'pin' ? board.pinRadius : obstacle.radius);
        }
        const key = `${hit.kind}:${hit.index}:${hit.kind === 'wall' ? Math.sign(hit.x) : ''}`;
        if (lastImpact.has(key)) expect(hit.t - lastImpact.get(key)).toBeGreaterThanOrEqual(0.08 - 1e-10);
        lastImpact.set(key, hit.t);
        previousTime = hit.t;
      }
    }
    expect(bumperDrops).toBeGreaterThanOrEqual(100);
    durations.sort((a, b) => a - b);
    console.info('400 seeded drops:', {
      min: durations[0], median: (durations[199] + durations[200]) / 2,
      max: durations[399], meanHits: hitCount / 400, bumperDrops,
    });
  });

  it('spreads 300 drops from the same aim across the board', () => {
    const exits = Array.from({ length: 300 }, (_, seed) =>
      simulateDrop({ x: 0, y: dimensions.top }, board, mulberry32(seed + 1)).exitX);
    expect(Math.min(...exits)).toBeLessThan(-1.5);
    expect(Math.max(...exits)).toBeGreaterThan(1.5);
  });

  it('reproduces the entire path with the same seed without mutating inputs', () => {
    const start = Object.freeze({ x: 0, y: dimensions.top });
    const frozenBoard = Object.freeze({ ...board,
      pins: Object.freeze(board.pins.map((pin) => Object.freeze({ ...pin }))),
      bumpers: Object.freeze(board.bumpers.map((bumper) => Object.freeze({ ...bumper }))),
    });
    expect(simulateDrop(start, frozenBoard, mulberry32(42)))
      .toEqual(simulateDrop(start, frozenBoard, mulberry32(42)));
  });

  it('nudges a perfectly balanced coin off a pin after maxTime', () => {
    const balancedBoard = { ...board, bumpers: [], pins: [{ x: 0, y: 3 }] };
    const result = simulateDrop({ x: 0, y: 4.8 }, balancedBoard, () => 0.5, { maxTime: 0.5 });
    assertPath(result, balancedBoard);
    expect(result.duration).toBeLessThan(1.5);
  });

  it('supports boards without the optional bumpers field and detects swept pins', () => {
    const coarseBoard = { ...dimensions, pins: [{ x: 0, y: 3 }] };
    const result = simulateDrop({ x: 0, y: 4.8 }, coarseBoard, mulberry32(12), { dt: 0.1, sampleEvery: 1, gravity: 120 });
    assertPath(result, coarseBoard);
    expect(result.path.some((sample) => Math.abs(sample.x) > 0.1)).toBe(true);
  });

  it('samples at the configured cadence and integrates free fall and spin', () => {
    // Uncapped, so the fall is pure free fall all the way down.
    const result = simulateDrop({ x: 0, y: 4.8 }, { ...board, pins: [], bumpers: [] }, () => 0.75,
      { maxSpeed: Infinity });
    expect(result.path[1].t).toBeCloseTo(1 / 120);
    expect(result.path[2].t).toBeCloseTo(1 / 60);
    expect(result.path[1].x).toBeGreaterThan(0);
    expect(result.path[1].angle).toBeCloseTo(-result.path[1].x / board.coinRadius);
    expect(result.duration).toBeCloseTo(Math.sqrt(2 * (4.8 - 1.6) / 24), 2);
  });
});
