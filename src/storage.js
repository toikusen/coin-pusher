const STORAGE_KEY = 'coin-pusher-progress-v1';
// Bumped when a saved geometry can no longer be trusted. Version 1 saves (no field at all) wrote
// the resolved defaults on every boot, freezing whatever MACHINE_GEOMETRY_DEFAULTS were on the
// first launch - so every later change to the machine's layout never reached a returning player.
const GEOMETRY_VERSION = 2;

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
  // The mission chain (game/missions.js); loadMissionState() cleans whatever comes back.
  mission: null,
});

export function loadProgress() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const saved = value && typeof value === 'object' ? value : {};
    const progress = { ...defaults, ...saved };
    if (saved.geometryVersion !== GEOMETRY_VERSION) progress.geometry = {};
    return progress;
  } catch {
    return { ...defaults };
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...defaults, ...progress, geometryVersion: GEOMETRY_VERSION }));
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
}
