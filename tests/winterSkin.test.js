// The winter cabinet against the physics it is drawn over. The model carries no colliders: the game
// keeps its own (CoinPusher.buildMachine), so these pin each visible surface to the collider it has
// to sit on, measured from the GLB's real geometry in world space.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GAME, COIN_RADIUS } from '../src/game/config.js';
import { boardPins, drumAngleFor, PIN_BOARD } from '../src/game/CoinPusher.js';
import { exportedPusherZ, isBoardDecor, WINTER_NODES, winterPixelRatio } from '../src/game/winterSkin.js';

const buffer = readFileSync(new URL('../public/models/winter/coin_pusher.glb', import.meta.url));
const jsonLength = buffer.readUInt32LE(12);
const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
const bin = buffer.subarray(20 + jsonLength + 8);

const parentOf = new Map();
gltf.nodes.forEach((node, index) => (node.children ?? []).forEach((child) => parentOf.set(child, index)));
const indexOf = (name) => {
  const index = gltf.nodes.findIndex((node) => node.name === name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  return index;
};
const localMatrix = (index) => {
  const { translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1] } = gltf.nodes[index];
  return new THREE.Matrix4().compose(new THREE.Vector3(...translation), new THREE.Quaternion(...rotation), new THREE.Vector3(...scale));
};
const worldMatrix = (index) => (parentOf.has(index)
  ? worldMatrix(parentOf.get(index)).multiply(localMatrix(index))
  : localMatrix(index));
const read = (accessorIndex) => {
  const accessor = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[accessor.bufferView];
  const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[accessor.componentType];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  const start = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return new Type(bin.buffer.slice(start, start + accessor.count * size * Type.BYTES_PER_ELEMENT));
};

// The separate solids inside one (possibly merged) mesh, as boxes in `space`. Vertices are welded by
// position first: UV and normal seams split a solid's vertices, so index sharing alone undercounts.
function parts(name, space = new THREE.Matrix4()) {
  const index = indexOf(name);
  const toSpace = space.clone().multiply(worldMatrix(index));
  return gltf.meshes[gltf.nodes[index].mesh].primitives.flatMap((primitive) => {
    const position = read(primitive.attributes.POSITION);
    const triangles = read(primitive.indices);
    const count = position.length / 3;
    const welded = new Map();
    const root = Int32Array.from({ length: count }, (_, vertex) => {
      const key = [0, 1, 2].map((axis) => position[vertex * 3 + axis].toFixed(4)).join();
      if (!welded.has(key)) welded.set(key, vertex);
      return welded.get(key);
    });
    const find = (vertex) => {
      while (root[vertex] !== vertex) vertex = root[vertex] = root[root[vertex]];
      return vertex;
    };
    for (let corner = 0; corner < triangles.length; corner += 3) {
      const a = find(triangles[corner]);
      for (const other of [triangles[corner + 1], triangles[corner + 2]]) root[find(other)] = a;
    }
    const boxes = new Map();
    for (let vertex = 0; vertex < count; vertex += 1) {
      const key = find(vertex);
      if (!boxes.has(key)) boxes.set(key, new THREE.Box3());
      boxes.get(key).expandByPoint(new THREE.Vector3().fromArray(position, vertex * 3).applyMatrix4(toSpace));
    }
    return [...boxes.values()];
  });
}
const bounds = (name) => parts(name).reduce((all, box) => all.union(box), new THREE.Box3());
const centre = (box) => box.getCenter(new THREE.Vector3());
// The board's own frame at the export: pins, bumpers and slot as the game builds them, unreclined.
const boardSpace = () => worldMatrix(indexOf(WINTER_NODES.boardInner)).invert();
const EXPORT_DROP_ZONE_Z = 3.06;

describe('winter cabinet', () => {
  it('has every node the skin drives', () => {
    for (const name of Object.values(WINTER_NODES)) indexOf(name);
    expect(gltf.nodes[indexOf(WINTER_NODES.reels)].children).toHaveLength(3);
    expect(gltf.animations ?? []).toHaveLength(0);
  });

  it('puts the bed on the bed collider', () => {
    const bed = bounds('Box_#eef7fb');
    expect(bed.max.y).toBeCloseTo(0, 3);
    expect(bed.max.x).toBeCloseTo(GAME.playfieldHalfWidth + 0.075, 2);
    expect(bed.max.z).toBeCloseTo(GAME.playfieldBackZ, 2);
    // A trim 0.035 proud of the collider's front face, as the classic front trim stands.
    expect(bed.min.z).toBeGreaterThan(GAME.playfieldFrontZ - 0.05);
    expect(bed.min.z).toBeLessThanOrEqual(GAME.playfieldFrontZ);
  });

  it('stands the side glass on the side-wall colliders', () => {
    const [left, right] = parts('Box_#1d5c66').sort((a, b) => a.min.x - b.min.x);
    expect(left.max.x).toBeCloseTo(-GAME.playfieldHalfWidth, 3);
    expect(right.min.x).toBeCloseTo(GAME.playfieldHalfWidth, 3);
    // Lower than the collider (top 2.15) - coins cannot leave over the drawn edge either way.
    expect(right.max.y).toBeLessThan(GAME.scraperGuardTopY);
  });

  it('froze the pusher mid-stroke, tray and blade merged, at the tray collider height', () => {
    const [deck] = parts(WINTER_NODES.pusherMesh).filter((box) => box.getSize(new THREE.Vector3()).x > 7);
    const z = exportedPusherZ(deck.max.z, GAME);
    expect(z).toBeGreaterThan(GAME.pusherOriginZ - GAME.pusherAmplitude);
    expect(z).toBeLessThan(GAME.pusherOriginZ + GAME.pusherAmplitude);
    expect(deck.max.y).toBeCloseTo(GAME.upperTrayY + GAME.upperTrayHeight / 2, 2);
    // The blade's face: 0.07 (its half depth) in front of the tray's front edge.
    expect(deck.min.z).toBeCloseTo(z - GAME.pusherDepth / 2 - 0.07, 2);
    expect(deck.min.y).toBeCloseTo(0, 1);
  });

  it('measures the pusher side rails, which have no collider (open question)', () => {
    const rails = parts(WINTER_NODES.pusherMesh).filter((box) => box.getSize(new THREE.Vector3()).x < 1);
    expect(rails).toHaveLength(2);
    const inner = Math.min(...rails.map((box) => Math.min(Math.abs(box.min.x), Math.abs(box.max.x))));
    // A tray coin's centre can reach the glass less a radius; the rails stand inside that.
    expect(inner).toBeCloseTo(3.668, 3);
    expect(inner).toBeLessThan(GAME.playfieldHalfWidth - COIN_RADIUS);
  });

  it('exported the scraper at 4.04, which the skin moves onto today\'s scraperZ', () => {
    const scraper = bounds(WINTER_NODES.scraper);
    expect(centre(scraper).z).toBeCloseTo(4.04, 2);
    expect(scraper.getSize(new THREE.Vector3()).z).toBeCloseTo(0.16, 3);
  });

  it('pivots the board where the game does, at the export\'s drop zone', () => {
    const rig = gltf.nodes[indexOf(WINTER_NODES.boardRig)];
    expect(rig.translation[1]).toBeCloseTo(PIN_BOARD.bottom - 0.1, 4);
    expect(rig.translation[2]).toBeCloseTo(EXPORT_DROP_ZONE_Z - 0.1, 4);
    gltf.nodes[indexOf(WINTER_NODES.boardInner)].translation.forEach((value, axis) => expect(value + rig.translation[axis]).toBeCloseTo(0, 5));
  });

  it('draws one pin per simulated pin, 49 merged into one mesh', () => {
    const drawn = parts('Mesh_81', boardSpace()).map(centre);
    const simulated = boardPins();
    expect(drawn).toHaveLength(simulated.length);
    for (const pin of simulated) {
      const nearest = Math.min(...drawn.map((point) => Math.hypot(point.x - pin.x, point.y - pin.y)));
      expect(nearest, `pin ${pin.x},${pin.y}`).toBeLessThan(0.01);
    }
  });

  it('draws the bumpers where pachinko.js bounces coins off them', () => {
    const space = boardSpace();
    const drawn = ['Node_92', 'Node_99', 'Node_106'].map((name) => new THREE.Vector3().setFromMatrixPosition(space.clone().multiply(worldMatrix(indexOf(name)))));
    PIN_BOARD.bumpers.forEach((bumper, index) => {
      expect(drawn[index].x).toBeCloseTo(bumper.x, 3);
      expect(drawn[index].y).toBeCloseTo(bumper.y, 3);
    });
  });

  it('rests its reel drums on the idle face', () => {
    for (const child of gltf.nodes[indexOf(WINTER_NODES.reels)].children) {
      const angle = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...gltf.nodes[child].rotation)).x;
      expect(THREE.MathUtils.euclideanModulo(angle, Math.PI * 2)).toBeCloseTo(drumAngleFor(GAME.slotIdleSymbol), 4);
    }
  });

  it('has a second UV set on every lightmapped mesh', () => {
    const baked = gltf.nodes.filter((node) => node.extras?.lightmap_static);
    expect(baked.length).toBeGreaterThan(50);
    for (const node of baked) {
      for (const primitive of gltf.meshes[node.mesh].primitives) expect(primitive.attributes.TEXCOORD_1, node.name).toBeDefined();
    }
  });

  it('reclines only what hangs off the board head', () => {
    expect(isBoardDecor(bounds('Cube.001'))).toBe(true);
    expect(isBoardDecor(bounds('Box_#eef7fb'))).toBe(false);
    expect(isBoardDecor(new THREE.Box3())).toBe(false);
  });
});

describe('winterPixelRatio', () => {
  it('caps phones at 1.5x and 1.5 million pixels, and leaves desktops alone', () => {
    expect(winterPixelRatio(1.75, 400, 800, true)).toBe(1.5);
    expect(winterPixelRatio(1.75, 1000, 1000, true)).toBeCloseTo(Math.sqrt(1.5), 5);
    expect(winterPixelRatio(1.25, 400, 800, true)).toBe(1.25);
    expect(winterPixelRatio(1.75, 1000, 1000, false)).toBe(1.75);
  });
});

describe('exportedPusherZ', () => {
  it('reads the tray position back from its rear edge', () => {
    expect(exportedPusherZ(8, { pusherRearExtension: 2.5, pusherDepth: 4 })).toBe(3.5);
  });
});
