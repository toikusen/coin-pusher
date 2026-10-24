import { afterEach, describe, expect, it } from 'vitest';
import { loadProgress, saveProgress } from '../src/storage.js';

const KEY = 'coin-pusher-progress-v1';
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};

describe('saved progress', () => {
  afterEach(() => store.clear());

  // The bug this guards: version 1 wrote the resolved default geometry on every boot, so a
  // returning player kept the machine layout from their first launch forever.
  it('drops a geometry saved before the version field, keeping everything else', () => {
    store.set(KEY, JSON.stringify({ bestScore: 1196, geometry: { lowerCenterZ: -0.17, lowerLength: 9.06 } }));
    const progress = loadProgress();
    expect(progress.geometry).toEqual({});
    expect(progress.bestScore).toBe(1196);
  });

  it('keeps a geometry the player set after the fix', () => {
    saveProgress({ ...loadProgress(), geometry: { scraperZ: 4.2 } });
    expect(loadProgress().geometry).toEqual({ scraperZ: 4.2 });
  });
});
