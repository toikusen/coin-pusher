const STORAGE_KEY = 'coin-pusher-progress-v1';

const defaults = Object.freeze({
  bestScore: 0,
  soundEnabled: true,
  hasSeenOnboarding: false,
  hdriHorizontal: 0,
  hdriVertical: 0,
  // Sparse patch of physics knobs the player changed; validated in main.js before use.
  tuning: {},
  // Same deal for the machine's Z layout; machineGeometryFor() clamps whatever comes back.
  geometry: {},
});

export function loadProgress() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  } catch {
    return { ...defaults };
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaults, ...progress }));
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
}
