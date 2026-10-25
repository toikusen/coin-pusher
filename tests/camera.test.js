import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  boardPins, boardReclineFor, closedFor, dropXAt, refillPose, FLAT_CAMERA, FOLD_CAMERA, OPEN_CAMERA, foldFor, fovForAspect, PIN_BOARD, pathAt,
} from '../src/game/CoinPusher.js';
import { GAME } from '../src/game/config.js';

// The Duo's canvas, from the top of the display with the fold 475.5 pt down (669 x 812,
// html[data-fold]), and where the fold falls in it in NDC.
const STOOD_VIEW = { aspect: 669 / 812, foldNdc: 1 - (2 * 475.5) / 812 };
// poseCamera's view offset, as a shift in NDC: on a foldable it carries the sill onto the fold at
// every angle. Framing checks have to see what it sees.
const sillShift = (camera) =>
  STOOD_VIEW.foldNdc - new THREE.Vector3(0, PIN_BOARD.bottom - 0.1, GAME.dropZoneZ - 0.1).project(camera).y;
const lerp = (from, to, t) => from.map((value, index) => value + (to[index] - value) * t);
// The foldable's camera at a hinge angle, as poseCamera blends it.
function foldCameraAt(degrees) {
  const t = foldFor(degrees);
  const camera = new THREE.PerspectiveCamera(OPEN_CAMERA.fov + (FOLD_CAMERA.fov - OPEN_CAMERA.fov) * t, STOOD_VIEW.aspect, 0.1, 100);
  camera.position.set(...lerp(OPEN_CAMERA.position, FOLD_CAMERA.position, t));
  camera.lookAt(...lerp(OPEN_CAMERA.target, FOLD_CAMERA.target, t));
  camera.updateMatrixWorld();
  return camera;
}

// The game camera: setupScene's position and target, with the fov the resize handler picks.
function cameraFor(aspect) {
  const camera = new THREE.PerspectiveCamera(fovForAspect(aspect), aspect, 0.1, 100);
  camera.position.set(...FLAT_CAMERA.position);
  camera.lookAt(...FLAT_CAMERA.target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

describe('camera framing', () => {
  it('keeps the tuned 71 degrees on a field wide enough not to need more', () => {
    expect(fovForAspect(0.87)).toBe(71);
    expect(fovForAspect(1.6)).toBe(71);
  });

  // The bug this guards: a taller field cut the lower bed's edges off both sides. The front lip's
  // corners are the widest point of the bed on screen - it is the part nearest the camera.
  it('keeps the lower bed\'s front corners in frame at any aspect', () => {
    for (const aspect of [1.6, 1.05, 0.9, 0.72, 0.6, 0.5]) {
      const camera = cameraFor(aspect);
      for (const x of [-4.075, 4.075]) {
        const ndc = new THREE.Vector3(x, 0, GAME.playfieldFrontZ).project(camera);
        expect(Math.abs(ndc.x), `corner x at aspect ${aspect}`).toBeLessThanOrEqual(1.001);
        expect(Math.abs(ndc.y), `corner y at aspect ${aspect}`).toBeLessThan(1);
      }
    }
  });

  it('falls back to the tuned fov before the canvas has a size', () => {
    expect(fovForAspect(0)).toBe(71);
    expect(fovForAspect(Number.NaN)).toBe(71);
  });
});


describe('fold view framing', () => {
  // The Duo's inner display stood up: the HUD is off the canvas and the fold is above its middle.
  const camera = new THREE.PerspectiveCamera(FOLD_CAMERA.fov, STOOD_VIEW.aspect, 0.1, 100);
  camera.position.set(...FOLD_CAMERA.position);
  camera.lookAt(...FOLD_CAMERA.target);
  camera.updateMatrixWorld();

  // The sill is put on the fold at run time by poseCamera's view offset (foldShiftFor), not by the
  // pose - see 'fold alignment on other layouts'.
  // The slot's crown is checked at every hinge angle, recline and fold shift included, in
  // 'hinge blend' below.

  it('keeps the whole lip on the flat half', () => {
    for (const x of [-4.08, 4.08]) {
      const corner = new THREE.Vector3(x, 0, GAME.playfieldFrontZ).project(camera);
      corner.y += sillShift(camera, 1);
      expect(Math.abs(corner.x)).toBeLessThan(1);
      expect(corner.y).toBeGreaterThan(-1);
    }
  });
});

describe('hinge', () => {
  it('maps the hinge angle onto how stood up the machine is', () => {
    expect(foldFor(180)).toBe(0);
    expect(foldFor(135)).toBeCloseTo(0.5, 8);
    expect(foldFor(90)).toBe(1);
    // Tighter than a right angle stays stood up; garbage reads as flat.
    expect(foldFor(40)).toBe(1);
    expect(foldFor(Number.NaN)).toBe(0);
  });

  it('keeps the flat pose\'s lip near the bottom on a phone and on desktop', () => {
    for (const [aspect, floor] of [[669 / 768, -0.86], [1.05, -0.86]]) {
      const camera = new THREE.PerspectiveCamera(fovForAspect(aspect), aspect, 0.1, 100);
      camera.position.set(...FLAT_CAMERA.position);
      camera.lookAt(...FLAT_CAMERA.target);
      camera.updateMatrixWorld();
      const lip = new THREE.Vector3(4.08, 0, GAME.playfieldFrontZ).project(camera);
      expect(lip.y, `aspect ${aspect}`).toBeGreaterThan(-1);
      expect(lip.y, `aspect ${aspect}`).toBeLessThan(floor + 0.1);
    }
  });
});

describe('drop playback', () => {
  const path = [{ t: 0, x: 0, y: 5, angle: 0 }, { t: 0.1, x: 1, y: 4, angle: 2 }, { t: 0.3, x: 1, y: 2, angle: 2 }];

  it('interpolates between samples and holds the ends', () => {
    expect(pathAt(path, 0.05)).toMatchObject({ x: 0.5, y: 4.5, angle: 1 });
    expect(pathAt(path, 0.2)).toMatchObject({ x: 1, y: 3 });
    expect(pathAt(path, -1)).toBe(path[0]);
    expect(pathAt(path, 9)).toBe(path[2]);
  });
});

describe('pin board spread', () => {
  // The bugs this guards: every coin dropped from the centre, so the two top bumpers 1.6 off the
  // drop line were hit by ~2.5% of coins, and pins run to the sill left a comb of dead spots.
  it('feeds every part of the sill and all three bumpers from the sweeping shuttle', async () => {
    const { simulateDrop } = await import('../src/game/pachinko.js');
    const board = { ...PIN_BOARD, pins: boardPins() };
    let seed = 99;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const drops = Array.from({ length: 1500 }, (_, index) =>
      simulateDrop({ x: dropXAt(index * GAME.autoInterval), y: PIN_BOARD.top }, board, random));
    const bins = Array(14).fill(0);
    for (const { exitX } of drops) {
      bins[Math.min(13, Math.floor((exitX + PIN_BOARD.halfWidth) / (2 * PIN_BOARD.halfWidth) * 14))] += 1;
    }
    // An even split is ~7.1% each; 3.5 allows the seed's noise and catches a dead spot.
    for (const count of bins) expect(count / drops.length).toBeGreaterThan(0.035);
    PIN_BOARD.bumpers.forEach((_, index) => {
      const share = drops.filter(({ hits }) => hits.some((hit) => hit.kind === 'bumper' && hit.index === index)).length / drops.length;
      expect(share).toBeGreaterThan(0.2);
    });
  });

  it('sweeps the shuttle edge to edge as a triangle wave', () => {
    expect(dropXAt(0)).toBeCloseTo(0);
    const xs = Array.from({ length: 3100 }, (_, index) => dropXAt(index / 1000));
    expect(Math.max(...xs)).toBeCloseTo(2.8, 2);
    expect(Math.min(...xs)).toBeCloseTo(-2.8, 2);
    expect(Math.max(...xs.slice(1).map((x, index) => Math.abs(x - xs[index])))).toBeLessThan(0.004);
  });
});

describe('shuttle refill', () => {
  // The coin in the cell is the one that drops, so it must be gone at the drop and back, seated
  // at full size, before the next auto drop - or auto-play shows an empty cell dropping coins.
  it('empties the cell on a drop and seats the next coin before the next auto drop', () => {
    expect(refillPose(Infinity)).toMatchObject({ visible: true, lift: 0, scale: 1, flash: 0 });
    expect(refillPose(0).visible).toBe(false);
    expect(refillPose(0.29).visible).toBe(false);
    const minting = refillPose(0.31);
    expect(minting.visible).toBe(true);
    expect(minting.lift).toBeGreaterThan(0);
    expect(minting.flash).toBeGreaterThan(0);
    expect(refillPose(GAME.autoInterval)).toMatchObject({ visible: true, lift: 0, scale: 1 });
  });
});

describe('hinge blend', () => {
  // The bug this guards: both poses framed the machine, but the straight-line blend between them
  // did not - at a 102 degree hinge the bed's lip sat under the controls. Every hinge angle the
  // game can be asked for has to keep the lip and the slot's crown in frame.
  it('keeps the lip and the slot\'s crown in frame at every hinge angle', () => {
    for (let degrees = 180; degrees >= 90; degrees -= 5) {
      const camera = foldCameraAt(degrees);
      const shift = sillShift(camera);
      for (const x of [-4.08, 4.08]) {
        const lip = new THREE.Vector3(x, 0, GAME.playfieldFrontZ).project(camera);
        lip.y += shift;
        expect(Math.abs(lip.x), `lip x at ${degrees}`).toBeLessThanOrEqual(1);
        expect(lip.y, `lip y at ${degrees}`).toBeGreaterThan(-0.97);
      }
      // The crown reclines with the board, about the sill.
      const pivot = new THREE.Vector3(0, PIN_BOARD.bottom - 0.1, GAME.dropZoneZ - 0.1);
      const crown = new THREE.Vector3(GAME.slotWidth * GAME.slotScale / 2, GAME.slotY + 1.6, GAME.slotZ - 0.58)
        .sub(pivot).applyAxisAngle(new THREE.Vector3(1, 0, 0), boardReclineFor(camera.getWorldDirection(new THREE.Vector3()))).add(pivot);
      expect(crown.clone().project(camera).y + shift, `crown at ${degrees}`).toBeLessThan(0.96);
      expect(Math.abs(crown.project(camera).x), `crown x at ${degrees}`).toBeLessThan(1);
    }
  });

  // The request this guards: folding should stand the board up, not zoom it - at 150 degrees, the
  // angle people play at, as much as at either end.
  it('holds the board\'s size from flat to stood up', () => {
    const pivot = new THREE.Vector3(0, PIN_BOARD.bottom - 0.1, GAME.dropZoneZ - 0.1);
    const widths = [];
    for (let degrees = 180; degrees >= 90; degrees -= 5) {
      const camera = foldCameraAt(degrees);
      const recline = boardReclineFor(camera.getWorldDirection(new THREE.Vector3()));
      const x = (side) => new THREE.Vector3(side * PIN_BOARD.halfWidth, PIN_BOARD.top, GAME.dropZoneZ)
        .sub(pivot).applyAxisAngle(new THREE.Vector3(1, 0, 0), recline).add(pivot).project(camera).x;
      widths.push(Math.abs(x(1) - x(-1)));
    }
    expect(Math.max(...widths) / Math.min(...widths)).toBeLessThan(1.03);
  });
});

describe('hinge easing', () => {
  it('eases into both ends of the fold', () => {
    // A straight ramp would give 1/18 at 175; the smoothstep stays well under it near the ends.
    expect(foldFor(175)).toBeLessThan(1 / 18 / 2);
    expect(1 - foldFor(95)).toBeLessThan(1 / 18 / 2);
    expect(foldFor(160)).toBeLessThan(foldFor(150));
  });
});

describe('fold alignment on other layouts', () => {
  it('slides the frame by exactly the gap between the sill and the fold', async () => {
    const { foldShiftFor } = await import('../src/game/CoinPusher.js');
    const height = 768;
    // Sill already on the fold: no shift.
    expect(foldShiftFor(384, height, 0)).toBeCloseTo(0, 6);
    // Fold 10 px further down the canvas than the sill: the offset is the 10 px between them.
    expect(Math.abs(foldShiftFor(394, height, 0))).toBeCloseTo(10, 6);
    expect(foldShiftFor(394, height, 0)).toBeCloseTo(-foldShiftFor(374, height, 0), 6);
  });
});

describe('pop-up board', () => {
  // The request this guards: the board should lie parallel to the upper half of the screen, not
  // be keystoned by a camera looking down at it, nor merely aimed at the camera.
  it('lays the board parallel to the screen at every hinge angle', () => {
    const pivot = new THREE.Vector3(0, PIN_BOARD.bottom - 0.1, GAME.dropZoneZ - 0.1);
    for (let degrees = 180; degrees >= 90; degrees -= 10) {
      const camera = foldCameraAt(degrees);
      const recline = boardReclineFor(camera.getWorldDirection(new THREE.Vector3()));
      const corner = (x, y) => new THREE.Vector3(x, y, GAME.dropZoneZ)
        .sub(pivot).applyAxisAngle(new THREE.Vector3(1, 0, 0), recline).add(pivot).project(camera);
      const half = PIN_BOARD.halfWidth;
      const topWidth = corner(-half, PIN_BOARD.top).x - corner(half, PIN_BOARD.top).x;
      const footWidth = corner(-half, PIN_BOARD.bottom).x - corner(half, PIN_BOARD.bottom).x;
      // Parallel to the screen: no keystone at all, not merely a small one.
      expect(topWidth / footWidth, `keystone at ${degrees}`).toBeCloseTo(1, 6);
    }
  });
});

describe('nearly shut', () => {
  it('pauses under 60 degrees and resumes over 65, holding in between', () => {
    expect(closedFor(false, 50)).toBe(true);
    expect(closedFor(true, 62)).toBe(true);
    expect(closedFor(false, 62)).toBe(false);
    expect(closedFor(true, 70)).toBe(false);
    expect(closedFor(true, Number.NaN)).toBe(false);
  });
});

describe('adaptive quality', () => {
  it('steps down only after two seconds of slow frames, and a fast frame resets it', async () => {
    const { adaptiveStepFor } = await import('../src/game/CoinPusher.js');
    let state = { slowFor: 0, stepDown: false };
    let steps = 0;
    for (let i = 0; i < 59; i += 1) { state = adaptiveStepFor(state.slowFor, 1 / 30); steps += state.stepDown; }
    expect(steps).toBe(0);
    state = adaptiveStepFor(state.slowFor, 1 / 30);
    expect(state.stepDown).toBe(true);
    expect(adaptiveStepFor(1.9, 1 / 60)).toEqual({ slowFor: 0, stepDown: false });
  });
});

describe('reel drums', () => {
  it('lands each drum exactly on its face, a whole number of turns on, and keeps rolling forward', async () => {
    const { drumAngleAt, drumAngleFor } = await import('../src/game/CoinPusher.js');
    const turn = Math.PI * 2;
    for (const [from, to] of [['?', '7'], ['7', '7'], ['bag', 'gild'], ['gild', 'quake']]) {
      const spin = { start: drumAngleFor(from), target: drumAngleFor(to), lockAt: 1.9 };
      const end = drumAngleAt({ ...spin, elapsed: 1.9 });
      const laps = (end - drumAngleFor(to)) / turn;
      expect(Math.abs(laps - Math.round(laps))).toBeLessThan(1e-9);
      expect(drumAngleAt({ ...spin, elapsed: 5 })).toBe(end);
      // Free-running part only goes one way.
      expect(drumAngleAt({ ...spin, elapsed: 1 })).toBeGreaterThan(drumAngleAt({ ...spin, elapsed: 0.5 }));
      expect(end).toBeGreaterThan(drumAngleAt({ ...spin, elapsed: 1.4 }));
    }
  });

  it('shows a different angle for every face', async () => {
    const { drumAngleFor } = await import('../src/game/CoinPusher.js');
    const angles = ['7', 'bag', 'quake', 'gild', '?'].map(drumAngleFor);
    expect(new Set(angles).size).toBe(5);
  });
});

describe('nextMaxSubSteps', () => {
  it('drops to one step on a slow step and only recovers with clear room', async () => {
    const { nextMaxSubSteps } = await import('../src/game/CoinPusher.js');
    expect(nextMaxSubSteps(3, 12, 3)).toBe(1);
    expect(nextMaxSubSteps(1, 8, 3)).toBe(1);
    expect(nextMaxSubSteps(1, 4, 3)).toBe(3);
    expect(nextMaxSubSteps(3, 8, 3)).toBe(3);
  });
});

describe('pathCursor', () => {
  it('resumes pathAt\'s lookup without changing what it returns', async () => {
    const { pathAt, pathCursor } = await import('../src/game/CoinPusher.js');
    const path = Array.from({ length: 50 }, (_, i) => ({ t: i * 0.02, x: Math.sin(i), y: -i * 0.1, angle: i }));
    let cursor = 0;
    for (let t = -0.01; t < 1.1; t += 0.013) {
      cursor = pathCursor(path, t, cursor);
      expect(pathAt(path, t, cursor)).toEqual(pathAt(path, t));
    }
  });
});


describe('power-on', () => {
  it('fires once opening past 165 degrees and re-arms only back past 172', async () => {
    const { standUpFor } = await import('../src/game/CoinPusher.js');
    expect(standUpFor(true, foldFor(175))).toEqual({ fire: false, armed: true });
    expect(standUpFor(true, foldFor(150))).toEqual({ fire: true, armed: false });
    expect(standUpFor(false, foldFor(150))).toEqual({ fire: false, armed: false });
    expect(standUpFor(false, foldFor(168))).toEqual({ fire: false, armed: false });
    expect(standUpFor(false, foldFor(176))).toEqual({ fire: false, armed: true });
  });

  it('races the lamps front to back twice, then stops', async () => {
    const { powerOnLampLit } = await import('../src/game/CoinPusher.js');
    const bays = Array.from({ length: 12 }, (_, step) => powerOnLampLit(step * 0.07 + 0.01));
    expect(bays).toEqual([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]);
    expect(powerOnLampLit(12 * 0.07 + 0.01)).toBe(0);
    expect(powerOnLampLit(-1)).toBe(0);
    expect(powerOnLampLit(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
