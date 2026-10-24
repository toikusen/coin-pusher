import { describe, expect, it } from 'vitest';
import { bulbLevel, PIN_COIN_PLANE, pinProfile } from '../src/game/themes/nocturne.js';
import { BOARD_THEMES, boardThemeFor, DEFAULT_BOARD_THEME } from '../src/game/themes/index.js';

describe('board themes', () => {
  it('falls back to the default theme for an unknown id', () => {
    expect(boardThemeFor('nope')).toBe(BOARD_THEMES[DEFAULT_BOARD_THEME]);
    expect(typeof boardThemeFor(DEFAULT_BOARD_THEME).build).toBe('function');
  });
});

describe('nocturne pins', () => {
  // The pachinko sim bounces coins off a pin of exactly pinRadius: where the coins' plane crosses
  // the pin it must be that wide - only the head, in front of the coins, may flare past it.
  it('is exactly the collision width where the coins pass it', () => {
    const profile = pinProfile(0.06);
    const shaft = profile.filter(([, y]) => y > 0 && y <= PIN_COIN_PLANE * 0.75 + 0.06);
    expect(Math.max(...shaft.map(([r]) => r))).toBeCloseTo(0.06, 9);
    expect(profile[0]).toEqual([0, 0]);
    expect(profile.at(-1)[0]).toBe(0);
  });
});

describe('nocturne marquee', () => {
  it('lights one bulb per shoulder at a time and walks along them', () => {
    const lit = (time) => [0, 1, 2, 3, 4, 5].filter((i) => bulbLevel(i, time) > 0.5);
    expect(lit(0)).toEqual([0]);
    expect(lit(0.5)).toEqual([1]);
    expect(lit(0.45 * 6 + 0.01)).toEqual([0]);
  });
});

describe('fence lamps', () => {
  it('walks one bay at a time from the player end to the back, then wraps', async () => {
    const { fenceLampLit } = await import('../src/game/CoinPusher.js');
    expect(fenceLampLit(0)).toBe(1);
    expect(fenceLampLit(0.45 * 5 + 0.01)).toBe(6);
    expect(fenceLampLit(0.45 * 6 + 0.01)).toBe(1);
  });
});

describe('reel artwork trim', () => {
  it('boxes the visible pixels and keeps the whole image when nothing shows', async () => {
    const { alphaBox } = await import('../src/game/themes/nocturneReels.js');
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (const [x, y] of [[1, 1], [2, 3]]) data[(y * 4 + x) * 4 + 3] = 255;
    expect(alphaBox(data, 4, 4)).toEqual({ x: 1, y: 1, w: 2, h: 3 });
    expect(alphaBox(new Uint8ClampedArray(64), 4, 4)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });
});
