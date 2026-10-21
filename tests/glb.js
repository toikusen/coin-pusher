// Shared GLB reader for the model tests. Not named *.test.js so vitest does not collect it.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

export function readGlb(path) {
  const buffer = readFileSync(path);
  expect(buffer.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  return JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'));
}

// One AABB per node, in whatever space the build script authored. Every build script applies its
// transforms before export, so a node carrying one means the model changed shape and the bounds
// below stopped meaning what they say - fail loudly rather than silently measure the wrong thing.
export function nodeBoxes(gltf) {
  return gltf.nodes.map((node) => {
    expect(node.translation ?? null, `${node.name} carries a translation`).toBe(null);
    expect(node.rotation ?? null, `${node.name} carries a rotation`).toBe(null);
    expect(node.scale ?? null, `${node.name} carries a scale`).toBe(null);
    expect(node.children ?? null, `${node.name} has children`).toBe(null);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], accessor.min[axis]);
        max[axis] = Math.max(max[axis], accessor.max[axis]);
      }
    }
    return { name: node.name, min, max };
  });
}

export const overallBounds = (boxes) => ({
  min: [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis]))),
  max: [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis]))),
});
