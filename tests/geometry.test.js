import { afterEach, describe, expect, it } from 'vitest';
import * as config from '../src/game/config.js';
import { COIN_RADIUS, LOWER_SEED_COUNT, seedPosition } from '../src/game/physics.js';

describe('machine geometry tuning', () => {
  it('derives live playfield edges from the five player-facing controls', () => {
    expect(config.machineGeometryFor).toBeTypeOf('function');

    const geometry = config.machineGeometryFor({
      scraperZ: 3.8,
      upperCenterZ: 2,
      upperLength: 6.6,
      lowerCenterZ: -0.2,
      lowerLength: 8,
    });

    expect(geometry.scraperZ).toBe(3.8);
    expect(geometry.upperCenterZ).toBe(2);
    // scraperZ 3.8 less the drop point's clearance gap and a coin radius.
    expect(geometry.dropZoneZ).toBeCloseTo(3.8 - config.GAME.dropZoneScraperGap - config.COIN_RADIUS, 8);
    expect(geometry.lowerFrontZ).toBeCloseTo(-4.2, 8);
    expect(geometry.lowerBackZ).toBeCloseTo(3.8, 8);
    expect(geometry.edgeZ).toBeCloseTo(-4.15, 8);
  });

  it('keeps the moving upper deck under the scraper at full extension', () => {
    const geometry = config.machineGeometryFor({
      scraperZ: 4.2,
      upperCenterZ: 1.4,
      upperLength: 4.8,
    });
    const frontMostBackEdge = geometry.upperCenterZ - config.GAME.pusherAmplitude
      - config.GAME.pusherDepth / 2 + geometry.upperLength;

    // 1e-9: machineGeometryFor raises upperLength to exactly this bound, which floats miss by an ulp.
    expect(frontMostBackEdge).toBeGreaterThanOrEqual(geometry.scraperZ + 0.08 - 1e-9);
  });

  it('ignores non-finite saved values', () => {
    const geometry = config.machineGeometryFor({
      scraperZ: Number.NaN,
      upperCenterZ: Infinity,
      lowerLength: -Infinity,
    });

    expect(geometry.scraperZ).toBe(config.MACHINE_GEOMETRY_DEFAULTS.scraperZ);
    expect(geometry.upperCenterZ).toBe(config.MACHINE_GEOMETRY_DEFAULTS.upperCenterZ);
    expect(geometry.lowerLength).toBe(config.MACHINE_GEOMETRY_DEFAULTS.lowerLength);
  });

  // The seeder derives its lower band from both ends of the machine, and the sliders can drive
  // those ends together until the band is shorter than the pile. That must stack, never overlap
  // or fall off the bed - a NaN or an out-of-bounds coin here is a coin dropped through the floor.
  describe('seeded pile at the ends of the slider ranges', () => {
    afterEach(() => config.applyMachineGeometry(config.MACHINE_GEOMETRY_DEFAULTS));

    for (const [label, corner] of Object.entries({
      'shortest bed, pusher furthest forward': { lowerLength: 7.6, lowerCenterZ: 0.45, upperCenterZ: 1.2 },
      'longest bed, pusher furthest back': { lowerLength: 9.5, lowerCenterZ: -0.45, upperCenterZ: 2.4 },
    })) {
      it(`stays on the bed with the ${label}`, () => {
        config.applyMachineGeometry(corner);
        const pile = Array.from({ length: LOWER_SEED_COUNT }, (_, index) => seedPosition(index, 7));

        for (const coin of pile) {
          expect(Number.isFinite(coin.x) && Number.isFinite(coin.y) && Number.isFinite(coin.z)).toBe(true);
          expect(coin.z - COIN_RADIUS).toBeGreaterThan(config.GAME.playfieldFrontZ);
          expect(coin.z).toBeLessThan(config.GAME.pusherOriginZ - config.GAME.pusherAmplitude);
        }
        // Unique slots: two coins sharing one seed both x and z would spawn interpenetrating.
        const slots = new Set(pile.map((coin) => `${coin.x.toFixed(3)}/${coin.y.toFixed(3)}/${coin.z.toFixed(3)}`));
        expect(slots.size).toBe(LOWER_SEED_COUNT);
      });
    }
  });
});
