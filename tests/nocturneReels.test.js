// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../src/game/config.js';
import { drawNocturneReels, SYMBOL_IDS } from '../src/game/themes/nocturneReels.js';

function recordingContext(width = 768, height = 256) {
  const calls = [];
  const stack = [];
  let nextClip = 0;
  const context = { canvas: { width, height }, calls, globalAlpha: 1, clipId: 0 };
  const properties = [
    'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'lineJoin', 'lineCap',
    'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'globalCompositeOperation', 'clipId',
  ];
  for (const method of [
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'arc', 'ellipse',
    'bezierCurveTo', 'quadraticCurveTo', 'translate', 'scale', 'clearRect',
  ]) context[method] = (...args) => calls.push([method, ...args]);
  for (const method of ['fill', 'stroke', 'fillRect', 'strokeRect']) {
    context[method] = (...args) => calls.push([method, ...args, {
      fill: context.fillStyle?.stops ?? context.fillStyle,
      stroke: context.strokeStyle?.stops ?? context.strokeStyle,
      alpha: context.globalAlpha, lineWidth: context.lineWidth, clipId: context.clipId,
      shadowColor: context.shadowColor, shadowBlur: context.shadowBlur,
    }]);
  }
  context.clip = () => { context.clipId = ++nextClip; calls.push(['clip', context.clipId]); };
  context.save = () => { stack.push(properties.map((key) => context[key])); calls.push(['save']); };
  context.restore = () => {
    if (!stack.length) throw new Error('Unbalanced restore');
    const values = stack.pop();
    properties.forEach((key, index) => { context[key] = values[index]; });
    calls.push(['restore']);
  };
  for (const method of ['createLinearGradient', 'createRadialGradient']) {
    context[method] = (...args) => {
      const gradient = { stops: [], addColorStop(offset, color) { this.stops.push([offset, color]); } };
      calls.push([method, ...args, gradient.stops]);
      return gradient;
    };
  }
  context.stackDepth = () => stack.length;
  return context;
}

const render = (options = {}, width, height) => {
  const context = recordingContext(width, height);
  drawNocturneReels(context, {
    symbols: ['7', 'bag', 'quake'], win: false, spinning: false, time: 0.27, palette: PALETTE,
    ...options,
  });
  return context;
};
const painted = (context, clipId) => context.calls.filter((call) => call.at(-1)?.clipId === clipId);

describe('drawNocturneReels', () => {
  it('exports every payable symbol and the idle mark', () => {
    expect(SYMBOL_IDS).toEqual(['7', 'bag', 'quake', 'gild', '?']);
  });

  it('draws every three-reel combination under idle, win and spin states', () => {
    for (const first of SYMBOL_IDS) for (const second of SYMBOL_IDS) for (const third of SYMBOL_IDS) {
      for (const win of [false, true]) for (const spinning of [false, true, [false, true, false]]) {
        const context = render({ symbols: [first, second, third], win, spinning });
        expect(context.calls.some(([method]) => method === 'stroke')).toBe(true);
        expect(context.stackDepth()).toBe(0);
        const numbers = context.calls.flat(Infinity).filter((value) => typeof value === 'number');
        expect(numbers.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it.each([[768, 240], [768, 256], [768, 295], [360, 120]])('fits a %i by %i canvas', (width, height) => {
    const context = render({}, width, height);
    const clips = context.calls.filter(([method]) => method === 'clip');
    expect(clips).toHaveLength(3);
    const bounds = context.calls.filter(([method]) => method === 'rect');
    for (const [, x, y, w, h] of bounds) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(width);
      expect(y + h).toBeLessThanOrEqual(height);
    }
  });

  it.each(SYMBOL_IDS)('is deterministic for %s without mutating inputs', (symbol) => {
    const symbols = Object.freeze([symbol, symbol, symbol]);
    const spinning = Object.freeze([false, true, true]);
    const options = Object.freeze({ symbols, spinning, win: true, time: 1.23, palette: PALETTE });
    expect(render(options).calls).toEqual(render(options).calls);
  });

  it('gives every symbol its own drawn silhouette', () => {
    const faces = SYMBOL_IDS.map((symbol) => render({ symbols: [symbol, symbol, symbol] }).calls);
    for (let index = 0; index < faces.length; index += 1) {
      for (let other = index + 1; other < faces.length; other += 1) expect(faces[index]).not.toEqual(faces[other]);
    }
  });

  it('keeps locked reels crisp and independent of the spin clock', () => {
    const options = { symbols: ['7', 'bag', 'gild'], spinning: [false, true, false] };
    const first = render({ ...options, time: 0.11 });
    const second = render({ ...options, time: 0.39 });
    expect(painted(first, 1)).toEqual(painted(second, 1));
    expect(painted(first, 3)).toEqual(painted(second, 3));
    // Translation is recorded separately, so compare each reel's complete clipped command stream.
    const reelCalls = (context, index) => {
      const start = context.calls.findIndex(([method, id]) => method === 'clip' && id === index);
      const end = context.calls.findIndex(([method, id], position) => position > start && method === 'clip' && id === index + 1);
      return context.calls.slice(start, end < 0 ? undefined : end);
    };
    expect(reelCalls(first, 1)).toEqual(reelCalls(second, 1));
    expect(reelCalls(first, 3)).toEqual(reelCalls(second, 3));
    expect(reelCalls(first, 2)).not.toEqual(reelCalls(second, 2));
    const stopped = render({ ...options, spinning: false });
    expect(painted(first, 1)).toEqual(painted(stopped, 1));
    expect(painted(first, 3)).toEqual(painted(stopped, 3));
    expect(painted(first, 2).length).toBeGreaterThan(painted(stopped, 2).length);
  });

  it('treats boolean spinning as all reels, and false arrays as stopped', () => {
    expect(render({ spinning: true }).calls).toEqual(render({ spinning: [true, true, true] }).calls);
    expect(render({ spinning: false }).calls).toEqual(render({ spinning: [false, false, false] }).calls);
    expect(render({ spinning: false, time: 0 }).calls).toEqual(render({ spinning: false, time: 99 }).calls);
  });

  it('adds gold glow and sunbursts to all three windows on a win', () => {
    const gold = ['#f2c94c', '#ffe9a3'];
    const goldPaintCount = (context) => context.calls.filter((call) => {
      const style = call.at(-1);
      if (!style || typeof style !== 'object') return false;
      const color = call[0] === 'stroke' || call[0] === 'strokeRect' ? style.stroke : style.fill;
      return gold.includes(color) || (Array.isArray(color) && color.some(([, value]) => gold.includes(value)));
    }).length;
    const normal = render({ symbols: ['7', '7', '7'] });
    const win = render({ symbols: ['7', '7', '7'], win: true });
    expect(goldPaintCount(win)).toBeGreaterThan(goldPaintCount(normal));
    for (const reel of [1, 2, 3]) expect(painted(win, reel).length).toBeGreaterThan(painted(normal, reel).length);
    expect(win.calls.some((call) => call.at(-1)?.shadowColor === '#f2c94c' && call.at(-1).shadowBlur > 0)).toBe(true);
  });

  it('uses supplied palette colors and supports omitted optional inputs', () => {
    const palette = { shell: 0x101122, shellRaised: 0x223344, gold: 0xab8923, goldSoft: 0xfedc98, mint: 0x12ab98, purple: 0x663399 };
    const context = render({ symbols: ['7', 'quake', 'gild'], palette });
    const output = JSON.stringify(context.calls);
    for (const value of Object.values(palette)) expect(output).toContain(`#${value.toString(16)}`);
    const defaults = recordingContext();
    expect(() => drawNocturneReels(defaults, { symbols: ['?', '?', '?'] })).not.toThrow();
  });

  it('restores caller paint state after drawing', () => {
    const context = recordingContext();
    Object.assign(context, { fillStyle: '#abcdef', globalAlpha: 0.6, shadowBlur: 3, shadowColor: '#ff0000', globalCompositeOperation: 'multiply' });
    drawNocturneReels(context, { symbols: ['bag', 'quake', 'gild'], win: true, spinning: true });
    expect(context).toMatchObject({ fillStyle: '#abcdef', globalAlpha: 0.6, shadowBlur: 3, shadowColor: '#ff0000', globalCompositeOperation: 'multiply' });
    expect(context.stackDepth()).toBe(0);
  });
});
