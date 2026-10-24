import { beforeAll, describe, expect, it } from 'vitest';
import { frictionFor, initPhysics, PhysicsWorld } from '../src/game/world.js';

const tuning = { groundFriction: 0.14, coinFriction: 0.3, pusherFriction: 1 };

describe('friction pairs', () => {
  // Rapier keeps one coefficient per collider; Multiply has to give back every pair the machine
  // used to set by hand.
  it('reproduces all six pairs under the Multiply rule', () => {
    const f = (m) => frictionFor(m, tuning, 8);
    expect(f('coin') * f('ground')).toBeCloseTo(0.14, 9);
    expect(f('coin') * f('coin')).toBeCloseTo(0.3, 9);
    expect(f('coin') * f('pusher')).toBeCloseTo(1, 9);
    expect(f('chest') * f('ground')).toBeCloseTo(0.14 * 8, 9);
    expect(f('chest') * f('coin')).toBeCloseTo(0.3 * 8, 9);
    expect(f('chest') * f('pusher')).toBeCloseTo(8, 9);
  });
});

describe('physics world', () => {
  beforeAll(() => initPhysics());

  const world = () => new PhysicsWorld({
    gravity: { x: 0, y: -24, z: 0 }, fixedStep: 1 / 60, iterations: 4, tuning, chestScale: 8,
  });
  const coin = (w) => w.addCoin({ radius: 0.36, thickness: 0.1, mass: 0.05, linearDamping: 0.12, angularDamping: 0.58 });

  it('settles a stack of coins on a box, three high, without sinking', () => {
    const w = world();
    w.addStaticBox({ x: 4, y: 0.25, z: 4 }, { x: 0, y: -0.25, z: 0 });
    const stack = [0, 1, 2].map((layer) => {
      const c = coin(w);
      c.setEnabled(true);
      c.setPose({ x: 0, y: 0.06 + layer * 0.12, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
      return c;
    });
    for (let i = 0; i < 180; i += 1) w.stepOnce();
    stack.forEach((c, layer) => expect(c.position.y).toBeCloseTo(0.05 + layer * 0.1, 1));
    w.free();
  });

  it('runs the owed fixed steps and caps a stall', () => {
    const w = world();
    expect(w.step(1 / 60 * 2.5)).toBeCloseTo(0.5, 6);
    expect(w.stepNumber).toBe(2);
    w.step(10);
    expect(w.stepNumber).toBe(2 + w.maxSubSteps);
    w.free();
  });

  it('drives a kinematic body to its target and reports role contacts', () => {
    const w = world();
    w.addStaticBox({ x: 4, y: 0.25, z: 4 }, { x: 0, y: -0.25, z: 0 });
    const wall = w.addStaticBox({ x: 0.1, y: 1, z: 4 }, { x: 1, y: 1, z: 0 }, { role: 'side-wall' });
    const pusher = w.addKinematicBoxes([{ halfExtents: { x: 0.5, y: 0.2, z: 0.5 }, offset: { x: 0, y: 0, z: 0 } }], { x: -2, y: 0.2, z: 0 });
    w.beforeStep.push((n) => pusher.rb.setNextKinematicTranslation({ x: -2 + n * 0.01, y: 0.2, z: 0 }));
    const c = coin(w);
    c.setEnabled(true);
    c.setPose({ x: 0.5, y: 0.06, z: 0 });
    c.setVelocity({ x: 6, y: 0, z: 0 });
    const hits = [];
    w.onContact = (a, b) => hits.push([a.role, b.role]);
    for (let i = 0; i < 60; i += 1) w.stepOnce();
    expect(pusher.position.x).toBeCloseTo(-2 + 60 * 0.01, 6);
    expect(hits.some(([a, b]) => a === 'side-wall' || b === 'side-wall')).toBe(true);
    w.free();
  });
});
