import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../src/game/config.js';

// PALETTE and the CSS custom properties are two hand-maintained copies of the same design
// tokens, and nothing at runtime touches both, so a drift is invisible until someone notices
// the 3D scene and the UI are a slightly different teal. This is the only thing that catches it.
// blue and purple are scene-only accent lights; the interface deliberately carries neither.
const CSS_TOKEN_FOR = {
  mint: '--mint-500',
  mintSoft: '--mint-400',
  gold: '--gold-400',
  goldSoft: '--gold-200',
  white: '--text-strong',
  scene: '--ink-950',
};

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('palette tokens', () => {
  it.each(Object.entries(CSS_TOKEN_FOR))('%s matches %s in styles.css', (key, token) => {
    const declared = css.match(new RegExp(`${token}:\\s*#([0-9a-f]{6})`, 'i'));
    expect(declared, `${token} is not declared in styles.css`).not.toBeNull();
    expect(PALETTE[key].toString(16).padStart(6, '0')).toBe(declared[1].toLowerCase());
  });
});
