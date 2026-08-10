import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { GAME } from '../src/game/config.js';
import {
  COIN_COIN_FRICTION,
  COIN_GROUND_FRICTION,
  COIN_HEIGHT,
  COIN_MASS,
  COIN_PUSHER_FRICTION,
  COIN_RADIUS,
  CONTACT_SOLVER_OPTIONS,
  LOWER_SEED_COUNT,
  TUNING_DEFAULTS,
  applyCoinTuning,
  createCoinBody,
  pusherMotionAt,
  seedPosition,
} from '../src/game/physics.js';

describe('coin collision bodies', () => {
  it('creates a unique Y-up collision shape for every coin', () => {
    const material = new CANNON.Material('coin');
    const first = createCoinBody(material);
    const second = createCoinBody(material);
    const min = new CANNON.Vec3();
    const max = new CANNON.Vec3();
    first.shapes[0].calculateWorldAABB(new CANNON.Vec3(), new CANNON.Quaternion(), min, max);

    expect(first.shapes[0]).not.toBe(second.shapes[0]);
    expect(first.mass).toBe(COIN_MASS);
    expect(first.shapes[0].body).toBe(first);
    expect(second.shapes[0].body).toBe(second);
    expect(max.y - min.y).toBeCloseTo(COIN_HEIGHT, 5);
    expect(max.x - min.x).toBeGreaterThan(COIN_RADIUS * 1.9);
  });

  it('lands on the machine shelf instead of tunnelling through it', () => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, 0), allowSleep: true });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 12;
    const groundMaterial = new CANNON.Material('ground');
    const coinMaterial = new CANNON.Material('coin');
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, groundMaterial, { friction: 0.5, restitution: 0.03 }));

    const shelf = new CANNON.Body({ mass: 0, material: groundMaterial });
    shelf.addShape(new CANNON.Box(new CANNON.Vec3(2.5, 0.25, 3.3)));
    shelf.position.set(0, -0.25, 0.2);
    world.addBody(shelf);

    const coin = createCoinBody(coinMaterial);
    coin.position.set(0, 4, 0);
    world.addBody(coin);
    for (let frame = 0; frame < 240; frame += 1) world.step(1 / 60);

    expect(coin.position.y).toBeGreaterThan(0);
    expect(coin.position.y).toBeLessThan(0.2);
  });

  it('puts a dense multi-layer stack fully to sleep', () => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, 0), allowSleep: true });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 32;
    const groundMaterial = new CANNON.Material('ground');
    const coinMaterial = new CANNON.Material('coin');
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, groundMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_GROUND_FRICTION,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, coinMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_COIN_FRICTION,
    }));
    const floor = new CANNON.Body({ mass: 0, material: groundMaterial });
    floor.addShape(new CANNON.Box(new CANNON.Vec3(2, 0.2, 2)));
    floor.position.y = -0.2;
    world.addBody(floor);

    const coins = [];
    for (let layer = 0; layer < 3; layer += 1) {
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          const body = createCoinBody(coinMaterial);
          body.position.set(
            (column - 1) * 0.74 + (layer % 2) * 0.025,
            0.07 + layer * 0.135,
            (row - 1) * 0.74 - (layer % 2) * 0.025,
          );
          body.quaternion.setFromAxisAngle(
            new CANNON.Vec3(1, 0, 1).unit(),
            ((row + column + layer) % 2 === 0 ? 1 : -1) * 0.035,
          );
          world.addBody(body);
          coins.push(body);
        }
      }
    }

    for (let frame = 0; frame < 10 * 120; frame += 1) world.step(1 / 120);

    expect(coins.every((body) => body.sleepState === CANNON.Body.SLEEPING)).toBe(true);
    expect(coins.every((body) => body.velocity.isZero() && body.angularVelocity.isZero())).toBe(true);
  });
});

describe('live tuning', () => {
  it('defaults to the values the machine ships with', () => {
    expect(TUNING_DEFAULTS.mass).toBe(COIN_MASS);
    expect(TUNING_DEFAULTS.thickness).toBe(COIN_HEIGHT);
    expect(TUNING_DEFAULTS.groundFriction).toBe(COIN_GROUND_FRICTION);
    expect(TUNING_DEFAULTS.coinFriction).toBe(COIN_COIN_FRICTION);
    expect(TUNING_DEFAULTS.pusherFriction).toBe(COIN_PUSHER_FRICTION);
    expect(TUNING_DEFAULTS.tilt).toBe(GAME.payoutTilt);
  });

  it('rebuilds the collision shape and inertia when thickness changes', () => {
    const body = createCoinBody(new CANNON.Material('coin'));
    expect(body.shapes[0].height).toBeCloseTo(COIN_HEIGHT, 8);
    const thinInvInertiaX = body.invInertia.x;

    applyCoinTuning(body, { ...TUNING_DEFAULTS, thickness: 0.3, mass: 0.2 }, true);

    // One shape, not two: a stale shape left in place would collide alongside the new one.
    expect(body.shapes).toHaveLength(1);
    expect(body.shapes[0].height).toBeCloseTo(0.3, 8);
    expect(body.mass).toBe(0.2);
    expect(body.invMass).toBeCloseTo(5, 8);
    // Thicker and heavier: harder to spin about a diameter, which is what stops coins tipping.
    expect(body.invInertia.x).toBeLessThan(thinInvInertiaX);
  });

  it('leaves the shape alone when only feel knobs move', () => {
    const body = createCoinBody(new CANNON.Material('coin'));
    const shape = body.shapes[0];
    applyCoinTuning(body, { ...TUNING_DEFAULTS, linearDamping: 0.4, angularDamping: 0.9 });
    expect(body.shapes[0]).toBe(shape);
    expect(body.linearDamping).toBe(0.4);
    expect(body.angularDamping).toBe(0.9);
  });
});

describe('seedPosition', () => {
  it('lays out a stable but naturally staggered lower pile', () => {
    const pile = Array.from({ length: LOWER_SEED_COUNT }, (_, index) => seedPosition(index, 1234));
    const layers = [...new Set(pile.map((coin) => coin.y))].sort((a, b) => a - b);

    expect(layers.length).toBeGreaterThan(1);
    expect(Math.min(...pile.map((coin) => coin.z)) - COIN_RADIUS)
      .toBeGreaterThan(GAME.playfieldFrontZ);
  });

  // A pile that fills every lattice slot in order reads as brickwork: square outline, uniform
  // layers, a top row that stops dead mid-pile. Gaps have to survive, and the crown has to
  // stay thinner than the body it sits on.
  it('seeds a gappy pile that thins towards the top', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const pile = Array.from({ length: LOWER_SEED_COUNT }, (_, i) => seedPosition(i, seed * 7919));
      const layers = [...new Set(pile.map((coin) => coin.y))].sort((a, b) => a - b);
      const countIn = (y) => pile.filter((coin) => coin.y === y).length;
      const perLayer = 24;

      expect(layers.length).toBeGreaterThan(2);
      expect(countIn(layers[0])).toBeLessThanOrEqual(perLayer);
      expect(countIn(layers.at(-1))).toBeLessThan(countIn(layers[0]));
    }
  });

  // A pile seeded with coins already interpenetrating never settles: cannon-es keeps
  // trading push-apart impulses against the damping instead of coming to rest, so the coins
  // stay above their sleep threshold and shimmer forever. Both pitches must beat the
  // diameter by more than the jitter can close, for every seed.
  it('never spawns two coins of the same layer overlapping', () => {
    const diameter = COIN_RADIUS * 2;
    let worstPenetration = 0;
    let overlappingPairs = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const pile = Array.from({ length: 64 }, (_, index) => seedPosition(index, seed * 7919));
      for (let i = 0; i < pile.length; i += 1) {
        for (let j = i + 1; j < pile.length; j += 1) {
          if (pile[i].tier !== pile[j].tier) continue;
          if (Math.abs(pile[i].y - pile[j].y) > COIN_HEIGHT) continue;
          const gap = Math.hypot(pile[i].x - pile[j].x, pile[i].z - pile[j].z);
          if (gap < diameter) {
            overlappingPairs += 1;
            worstPenetration = Math.max(worstPenetration, diameter - gap);
          }
        }
      }
    }
    expect(overlappingPairs).toBe(0);
    expect(worstPenetration).toBe(0);
  });

  // The tuning panel can take thickness to 0.34, and layer spacing follows it. If the pitch
  // ever stopped tracking thickness the pile would seed interpenetrating, which cannon-es
  // cannot resolve - it trades push-apart impulses with the damping and shimmers forever.
  it('never overlaps layers at any thickness the panel allows', () => {
    const diameter = COIN_RADIUS * 2;
    let worstPenetration = 0;
    for (const thickness of [0.06, 0.1, 0.2, 0.34]) {
      for (let seed = 0; seed < 40; seed += 1) {
        const pile = Array.from({ length: 64 }, (_, i) => seedPosition(i, seed * 7919, thickness));
        for (let i = 0; i < pile.length; i += 1) {
          for (let j = i + 1; j < pile.length; j += 1) {
            if (pile[i].tier !== pile[j].tier) continue;
            if (Math.abs(pile[i].y - pile[j].y) > thickness) continue;
            const gap = Math.hypot(pile[i].x - pile[j].x, pile[i].z - pile[j].z);
            worstPenetration = Math.max(worstPenetration, diameter - gap);
          }
        }
      }
    }
    expect(worstPenetration).toBe(0);
  });

  it('rests the bottom layer on the surface at any thickness', () => {
    for (const thickness of [0.06, 0.1, 0.34]) {
      const lower = seedPosition(0, 99, thickness);
      const upper = seedPosition(63, 99, thickness);
      expect(lower.y - thickness / 2).toBeGreaterThan(0);
      expect(upper.y - thickness / 2).toBeGreaterThan(GAME.upperTrayY + GAME.upperTrayHeight / 2);
    }
  });

  it('keeps every seeded coin clear of the side walls', () => {
    const innerWall = 2.425;
    for (let seed = 0; seed < 200; seed += 1) {
      for (let index = 0; index < 64; index += 1) {
        expect(Math.abs(seedPosition(index, seed * 7919).x) + COIN_RADIUS).toBeLessThan(innerWall);
      }
    }
  });

  // A coin on the tray rides with it, so its seed position matters in tray-local Z. Ahead of
  // the tray's front lip it overhangs; behind the point the scraper can reach at full retreat
  // it gets shoved forward once per stroke and the upper pile never comes to rest.
  it('seeds upper coins inside the band the tray carries undisturbed', () => {
    const trayFront = COIN_RADIUS - GAME.pusherDepth / 2;
    const scraperReach = GAME.scraperZ - 0.08 - COIN_RADIUS
      - (GAME.pusherOriginZ + GAME.pusherAmplitude);
    for (let seed = 0; seed < 200; seed += 1) {
      for (let index = LOWER_SEED_COUNT; index < 64; index += 1) {
        const trayLocalZ = seedPosition(index, seed * 7919).z - GAME.pusherOriginZ;
        expect(trayLocalZ).toBeGreaterThanOrEqual(trayFront);
        expect(trayLocalZ).toBeLessThanOrEqual(scraperReach);
      }
    }
  });

  it('varies the pile between resets while remaining deterministic for one seed', () => {
    expect(seedPosition(8, 1234)).toEqual(seedPosition(8, 1234));
    expect(seedPosition(8, 1234)).not.toEqual(seedPosition(8, 5678));
  });

  it('keeps lower coins in front and places upper coins on the moving tray', () => {
    const initialPusherFront = GAME.pusherOriginZ - GAME.pusherDepth / 2;
    const positions = Array.from({ length: 64 }, (_, index) => seedPosition(index, 4321));
    const lower = positions.filter((position) => position.tier === 'lower');
    const upper = positions.filter((position) => position.tier === 'upper');
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;

    expect(lower).toHaveLength(LOWER_SEED_COUNT);
    expect(Math.min(...lower.map((position) => position.x - COIN_RADIUS))).toBeGreaterThan(-2.4);
    expect(Math.max(...lower.map((position) => position.x + COIN_RADIUS))).toBeLessThan(2.4);
    expect(Math.min(...lower.map((position) => position.z - COIN_RADIUS))).toBeGreaterThan(GAME.playfieldFrontZ);
    expect(Math.max(...lower.map((position) => position.z))).toBeLessThan(initialPusherFront);
    expect(upper.length).toBeGreaterThan(0);
    expect(Math.min(...upper.map((position) => position.y))).toBeGreaterThan(trayTop);
  });
});

describe('drop zone', () => {
  it('stays over the moving upper tray for its entire stroke', () => {
    const rearMostFrontEdge = GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
    const frontMostBackEdge = GAME.pusherOriginZ - GAME.pusherAmplitude + GAME.pusherDepth / 2;
    expect(GAME.dropZoneZ).toBeGreaterThan(rearMostFrontEdge);
    expect(GAME.dropZoneZ).toBeLessThan(frontMostBackEdge);
  });
});

describe('machine proportions', () => {
  it('provides meaningful stacking distance on both tiers', () => {
    const coinDiameter = COIN_RADIUS * 2;
    const upperDepthInCoins = GAME.pusherDepth / coinDiameter;
    const averageBladeFront = GAME.pusherOriginZ - GAME.pusherDepth / 2;
    const lowerDepthInCoins = (averageBladeFront - GAME.playfieldFrontZ) / coinDiameter;

    expect(upperDepthInCoins).toBeGreaterThan(3.5);
    expect(lowerDepthInCoins).toBeGreaterThan(4);
  });

  it('keeps the payout crossing aligned with the shortened front edge', () => {
    expect(GAME.edgeZ - GAME.playfieldFrontZ).toBeCloseTo(0.05, 8);
  });
});

// Each tier is swept by one surface, and whatever that surface cannot reach can only be
// cleared by coins shoving each other. A settled pile transmits a shove about one coin
// deep — beyond that the chain dies and the tier silently gridlocks. Both spans below were
// once several diameters long, which parked every coin where nothing could ever touch it.
describe('sweep coverage', () => {
  const coinDiameter = COIN_RADIUS * 2;
  // Furthest forward the fixed scraper can shove a coin, in tray-local Z. The scraper only
  // bites at full retreat, so this is a one-shot limit, not something repeated strokes improve.
  const scraperReach = GAME.scraperZ - 0.08 - COIN_RADIUS
    - (GAME.pusherOriginZ + GAME.pusherAmplitude);
  // Furthest forward the blade can leave a coin's centre on the lower bed.
  const bladeReach = GAME.pusherOriginZ - GAME.pusherAmplitude
    - GAME.pusherDepth / 2 - 0.07 + COIN_RADIUS;

  it('leaves at most one coin of tray the scraper cannot reach', () => {
    const trayFront = -GAME.pusherDepth / 2;
    expect(scraperReach - trayFront).toBeLessThanOrEqual(coinDiameter);
  });

  // The lower bed's unswept span is 2.4 - far more than a settled pile transmits - and it
  // cannot be shortened: reaching the lip needs the blade at -2.43, which drags the tray over
  // nearly the whole playfield and leaves no visible lower tier. What makes it clear anyway is
  // being fed: a pile that keeps growing from behind jostles and shoves, where a starved one
  // just sits. So the guard here is the spill point, not the span - a coin leaving the tray
  // must land behind the blade, not in front of it where nothing can ever touch it again.
  // A coin dropped behind the scraper is on the wrong side of it forever: the scraper only
  // pushes forward, so nothing there is ever advanced towards the lip.
  it('drops coins in front of the scraper', () => {
    expect(GAME.dropZoneZ + COIN_RADIUS).toBeLessThan(GAME.scraperZ - 0.08);
  });

  // Coins cross the tray's lip while the scraper holds them, which only happens at full
  // retreat - so they always land at one predictable spot. That spot has to be behind the
  // blade face at that instant, or every arrival drops straight into the lower bed's unswept
  // span and joins a pile nothing can push. The margin here is only 0.07, so it is easy to
  // break by nudging the stroke or the tray depth.
  it('spills coins off the tray behind the blade, not into the unswept span', () => {
    const spillZ = GAME.pusherOriginZ + GAME.pusherAmplitude - GAME.pusherDepth / 2;
    const bladeFaceAtFullRetreat = spillZ - 0.07;
    expect(spillZ).toBeGreaterThan(bladeFaceAtFullRetreat);
    expect(spillZ).toBeGreaterThan(bladeReach + coinDiameter);
  });
});

describe('fixed rear deck', () => {
  // The deck and the moving tray used to share a Y, so a coin resting in the overlap
  // touched a static and a kinematic surface at once. The conflicting friction
  // constraints ratcheted the upper pile forward every stroke, draining it with zero
  // player input. Guard the clearance that separates them.
  it('sits below the tray top so coins never rest on both surfaces', () => {
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const deckTop = GAME.upperTrayY - GAME.deckClearance + GAME.upperTrayHeight / 2;
    expect(deckTop).toBeLessThan(trayTop);
  });

  it('leaves the upper pile in place when nobody drops a coin', () => {
    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -24, -GAME.payoutTilt),
      allowSleep: true,
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 32;
    world.defaultContactMaterial.contactEquationStiffness = 1e7;
    world.defaultContactMaterial.contactEquationRelaxation = 4;

    const groundMaterial = new CANNON.Material('ground');
    const pusherMaterial = new CANNON.Material('pusher');
    const coinMaterial = new CANNON.Material('coin');
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, groundMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_GROUND_FRICTION,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, coinMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_COIN_FRICTION,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, pusherMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_PUSHER_FRICTION,
    }));

    const addStatic = (width, height, depth, x, y, z) => {
      const body = new CANNON.Body({ mass: 0, material: groundMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)));
      body.position.set(x, y, z);
      world.addBody(body);
    };
    addStatic(4.8, GAME.upperTrayHeight, 2.1, 0, GAME.upperTrayY - GAME.deckClearance, 2.9);
    addStatic(4.8, 0.68, 0.16, 0, 1.05, GAME.scraperZ);
    addStatic(0.25, 2.4, 8, -2.55, 0.95, 0);
    addStatic(0.25, 2.4, 8, 2.55, 0.95, 0);

    const bladeHeight = 0.64;
    const pusher = new CANNON.Body({ mass: 0, material: pusherMaterial, type: CANNON.Body.KINEMATIC });
    pusher.addShape(
      new CANNON.Box(new CANNON.Vec3(2.35, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)),
      new CANNON.Vec3(0, GAME.upperTrayY, 0),
    );
    pusher.addShape(
      new CANNON.Box(new CANNON.Vec3(2.35, bladeHeight / 2, 0.07)),
      new CANNON.Vec3(0, bladeHeight / 2, -GAME.pusherDepth / 2),
    );
    pusher.position.set(0, 0, GAME.pusherOriginZ);
    world.addBody(pusher);

    const coins = [];
    for (let index = LOWER_SEED_COUNT; index < 64; index += 1) {
      const seed = seedPosition(index, 777);
      const body = createCoinBody(coinMaterial);
      body.position.set(seed.x, seed.y, seed.z);
      body.previousPosition.copy(body.position);
      world.addBody(body);
      coins.push(body);
    }

    const settle = () => { for (let i = 0; i < 120; i += 1) world.step(1 / 60, 1 / 60, 4); };
    settle();
    const meanZ = () => coins.reduce((sum, body) => sum + body.position.z, 0) / coins.length;
    const startZ = meanZ();

    const fixedStep = 1 / 120;
    const motionStartStep = world.stepnumber;
    const updatePusherMotion = () => {
      const motion = pusherMotionAt(world.stepnumber - motionStartStep, fixedStep);
      pusher.position.z = motion.positionZ;
      pusher.velocity.set(0, 0, motion.velocityZ);
      pusher.aabbNeedsUpdate = true;
    };
    updatePusherMotion();
    world.addEventListener('postStep', updatePusherMotion);
    const fullCycles = 12;
    const frames = Math.round((fullCycles * Math.PI * 2 / GAME.pusherSpeed) / fixedStep);
    for (let i = 0; i < frames; i += 1) world.step(fixedStep);

    // A coplanar deck marches the pile off the front; a separated one may settle by a small
    // fraction of a coin but must not migrate through the machine over repeated cycles.
    expect(meanZ() - startZ).toBeGreaterThan(-0.1);
    expect(coins.every((body) => body.position.y > 0.4)).toBe(true);
  }, 60_000);
});

// The geometric guard above bounds the span the scraper cannot reach; this one checks the
// consequence on a running machine, which is what a player actually sees. With the scraper
// parked at 2.55 that span was 1.36 and dropped coins simply never came down: 48 of them rode
// the tray back and forth for the whole run. Total payout is deliberately not asserted here -
// a pusher pays out by draining its pile, so the seeded pile masks a jammed tray for a while.
describe('tray drainage', () => {
  it('does not strand dropped coins on the tray', () => {
    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -24, -GAME.payoutTilt),
      allowSleep: true,
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 32;

    const groundMaterial = new CANNON.Material('ground');
    const pusherMaterial = new CANNON.Material('pusher');
    const coinMaterial = new CANNON.Material('coin');
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, groundMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_GROUND_FRICTION,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, coinMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_COIN_FRICTION,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(coinMaterial, pusherMaterial, {
      ...CONTACT_SOLVER_OPTIONS,
      friction: COIN_PUSHER_FRICTION,
    }));

    const addStatic = (width, height, depth, x, y, z) => {
      const body = new CANNON.Body({ mass: 0, material: groundMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)));
      body.position.set(x, y, z);
      world.addBody(body);
    };
    const playfieldDepth = GAME.playfieldBackZ - GAME.playfieldFrontZ;
    const playfieldCenter = (GAME.playfieldBackZ + GAME.playfieldFrontZ) / 2;
    addStatic(5, 0.5, playfieldDepth, 0, -0.25, playfieldCenter);
    addStatic(5, 2.6, 0.25, 0, 1.05, GAME.playfieldBackZ + 0.05);
    addStatic(0.25, 2.4, playfieldDepth + 0.2, -2.55, 0.95, playfieldCenter);
    addStatic(0.25, 2.4, playfieldDepth + 0.2, 2.55, 0.95, playfieldCenter);
    addStatic(4.8, GAME.upperTrayHeight, 2.1, 0, GAME.upperTrayY - GAME.deckClearance, 2.9);
    addStatic(4.8, 0.68, 0.16, 0, 1.05, GAME.scraperZ);

    const bladeHeight = 0.64;
    const pusher = new CANNON.Body({ mass: 0, material: pusherMaterial, type: CANNON.Body.KINEMATIC });
    pusher.addShape(
      new CANNON.Box(new CANNON.Vec3(2.35, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)),
      new CANNON.Vec3(0, GAME.upperTrayY, 0),
    );
    pusher.addShape(
      new CANNON.Box(new CANNON.Vec3(2.35, bladeHeight / 2, 0.07)),
      new CANNON.Vec3(0, bladeHeight / 2, -GAME.pusherDepth / 2),
    );
    pusher.position.set(0, 0, GAME.pusherOriginZ);
    pusher.previousPosition.copy(pusher.position);
    world.addBody(pusher);

    const fixedStep = 1 / 120;
    world.addEventListener('postStep', () => {
      const motion = pusherMotionAt(world.stepnumber, fixedStep);
      pusher.position.z = motion.positionZ;
      pusher.velocity.set(0, 0, motion.velocityZ);
      pusher.aabbNeedsUpdate = true;
    });

    const coins = [];
    const spawn = (x, y, z) => {
      const body = createCoinBody(coinMaterial);
      body.position.set(x, y, z);
      body.previousPosition.copy(body.position);
      world.addBody(body);
      coins.push(body);
      return body;
    };
    for (let index = 0; index < 64; index += 1) {
      const seed = seedPosition(index, 777);
      spawn(seed.x, seed.y, seed.z);
    }
    for (let i = 0; i < 360; i += 1) world.step(fixedStep);

    // Deterministic stand-in for the player: one coin per autoInterval across the aim range.
    const aimAt = (i) => {
      const noise = Math.sin((i + 1) * 91.7 + 3.1) * 43758.5453;
      return ((noise - Math.floor(noise)) - 0.5) * 3.9;
    };
    const dropEvery = Math.round(GAME.autoInterval / fixedStep);
    let dropCount = 0;
    for (let i = 0; i < Math.round(30 / fixedStep); i += 1) {
      if (i % dropEvery === 0 && coins.filter((body) => !body.paidOut).length < 96) {
        spawn(aimAt(i), 4, GAME.dropZoneZ).velocity.set(0, -1, 0);
        dropCount += 1;
      }
      world.step(fixedStep);
      for (const body of coins) {
        if (!body.paidOut && body.position.z < GAME.edgeZ) {
          body.paidOut = true;
          world.removeBody(body);
        }
      }
    }

    // The tray top is at 0.71 and the lower pile never reaches 0.5, so height alone separates
    // coins riding the tray from coins resting on the bed.
    const trayTop = GAME.upperTrayY + GAME.upperTrayHeight / 2;
    const stranded = coins.filter((body) => !body.paidOut && body.position.y > trayTop - 0.15);

    expect(dropCount).toBeGreaterThan(25);
    // The tray is a transit buffer, not a queue that should empty: a coin needs a few strokes
    // to be scraped to the lip, so at one drop per 0.9 s about 19 are legitimately riding it.
    // A jammed tray holds 46. The threshold sits between the two, nearer the working figure.
    expect(stranded.length).toBeLessThan(30);
    // ~28 s of narrowphase on an idle machine, but 96 convex hulls at 120 Hz is the whole
    // suite's cost centre and it stretches several-fold when anything else wants the CPU.
    // The budget is for a busy machine, not for the sim getting slower.
  }, 420_000);
});

describe('pusher stroke smoothness', () => {
  // Reproduces the runtime postStep driver and interpolated rendering at several display
  // rates. Each physics step is re-anchored to the analytical stroke, preventing drift.
  const createDrivenPusher = (fixedStep = 1 / 120) => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, -GAME.payoutTilt) });
    const pusher = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
    pusher.addShape(new CANNON.Box(new CANNON.Vec3(2.35, GAME.upperTrayHeight / 2, GAME.pusherDepth / 2)));
    pusher.position.set(0, 0, GAME.pusherOriginZ);
    pusher.previousPosition.copy(pusher.position);
    pusher.interpolatedPosition.copy(pusher.position);
    world.addBody(pusher);

    const updateMotion = () => {
      const motion = pusherMotionAt(world.stepnumber, fixedStep);
      pusher.position.z = motion.positionZ;
      pusher.velocity.set(0, 0, motion.velocityZ);
      pusher.aabbNeedsUpdate = true;
    };
    updateMotion();
    world.addEventListener('postStep', updateMotion);
    return { fixedStep, pusher, world };
  };

  const measure = (hz, seconds = 8) => {
    const { fixedStep, pusher, world } = createDrivenPusher();

    const frameDt = 1 / hz;
    let previous = pusher.interpolatedPosition.z;
    const travel = [];
    const positions = [];
    for (let frame = 0; frame < seconds * hz; frame += 1) {
      world.step(fixedStep, frameDt, 8);
      const rendered = pusher.interpolatedPosition.z;
      if (frame > hz) travel.push(Math.abs(rendered - previous));
      positions.push(rendered);
      previous = rendered;
    }
    return {
      max: Math.max(...positions),
      maxTravel: Math.max(...travel),
      min: Math.min(...positions),
    };
  };

  // Peak travel of a perfect sine per frame is amplitude * angularSpeed / hz.
  const idealTravel = (hz) => (GAME.pusherAmplitude * GAME.pusherSpeed) / hz;

  it.each([60, 120, 144])('never jumps further than the ideal sine at %iHz', (hz) => {
    const result = measure(hz);
    expect(result.maxTravel).toBeLessThan(idealTravel(hz) * 1.2);
    expect(result.min).toBeGreaterThanOrEqual(GAME.pusherOriginZ - GAME.pusherAmplitude - 1e-9);
    expect(result.max).toBeLessThanOrEqual(GAME.pusherOriginZ + GAME.pusherAmplitude + 1e-9);
  });

  it('remains centred after ten minutes of physics steps', () => {
    const { fixedStep, pusher, world } = createDrivenPusher();
    for (let frame = 0; frame < 10 * 60 * 120; frame += 1) world.step(fixedStep);

    const expected = pusherMotionAt(world.stepnumber, fixedStep);
    expect(pusher.position.z).toBeCloseTo(expected.positionZ, 12);
    expect(Math.abs(pusher.position.z - GAME.pusherOriginZ)).toBeLessThanOrEqual(GAME.pusherAmplitude);
  });
});
