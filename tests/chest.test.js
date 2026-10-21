import { describe, expect, it } from 'vitest';
import { nodeBoxes, overallBounds, readGlb } from './glb.js';
import { GAME } from '../src/game/config.js';

// Two interchangeable chests: chest.glb from tools/build_chest.py, and chest_tripo.glb, a Tripo
// generation fitted onto the same box by tools/fit_tripo.py. fitProp() rescales either to
// GAME.chestWidth and its bounding box becomes the physics body, so the proportions below are
// gameplay, not looks:
// physics.test.js assumes 0.74 deep for every 1 wide, and the payout times in config.js were
// tuned on a box 0.84 tall for every 1 wide.
describe.each(['chest.glb', 'chest_tripo.glb'])('%s', (file) => {
  const gltf = readGlb(`public/models/${file}`);
  const bounds = overallBounds(nodeBoxes(gltf));
  const size = [0, 1, 2].map((axis) => bounds.max[axis] - bounds.min[axis]);

  it('is authored at chestWidth, so the fit is a no-op', () => {
    expect(size[0]).toBeCloseTo(GAME.chestWidth, 3);
  });

  it('keeps the body the scraper and the tuning were built around', () => {
    expect(size[2] / size[0]).toBeCloseTo(0.737, 2);
    expect(size[1] / size[0]).toBeCloseTo(0.838, 2);
  });

  it('stands on y = 0 and is centred', () => {
    expect(bounds.min[1]).toBeCloseTo(0, 3);
    expect(bounds.min[0] + bounds.max[0]).toBeCloseTo(0, 3);
  });

  it.runIf(file === 'chest.glb')('ships no textures and lights only the padlock', () => {
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.materials.map((material) => material.name).sort())
      .toEqual(['chest_wood', 'neon_teal_soft', 'trim_gold_matte']);
  });

  // fit_tripo.py copies the prompted mint into an emissive map so the padlock lights like the
  // machine's own neon.
  it.runIf(file === 'chest_tripo.glb')('lights its padlock from an emissive map', () => {
    expect(gltf.materials[0].emissiveTexture).toBeDefined();
  });
});
