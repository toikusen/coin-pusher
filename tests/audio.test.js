import { describe, expect, it } from 'vitest';
import { GameAudio } from '../src/audio.js';

// A context that only records what would have been played.
const fakeContext = () => {
  const started = [];
  return {
    started,
    state: 'running',
    currentTime: 0,
    createBufferSource: () => ({ playbackRate: {}, connect: (node) => node, start: (at) => started.push(at) }),
    createGain: () => ({ gain: {}, connect: (node) => node }),
    destination: {},
  };
};

// ensureContext() only checks that the browser has one; the fake above is what gets used.
globalThis.window ??= { AudioContext: class {} };

const audioWith = (buffers) => {
  const audio = new GameAudio(true);
  const context = fakeContext();
  audio.context = context;
  audio.loading = true;
  audio.buffers = buffers;
  return { audio, context };
};

describe('GameAudio samples', () => {
  it('reports a missing sample so the caller can synthesise instead', () => {
    const { audio, context } = audioWith({});
    expect(audio.play('payout')).toBe(false);
    expect(context.started).toHaveLength(0);
  });

  it('plays a loaded sample, at most once per 60 ms however often it is asked', () => {
    const { audio, context } = audioWith({ payout: {} });
    expect(audio.play('payout')).toBe(true);
    expect(audio.play('payout')).toBe(true);
    expect(context.started).toHaveLength(1);
    context.currentTime = 0.07;
    audio.play('payout');
    expect(context.started).toHaveLength(2);
  });
});
