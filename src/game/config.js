export const GAME = Object.freeze({
  startingCredits: 50,
  missionTarget: 25,
  premiumChance: 0.16,
  premiumValue: 3,
  regularValue: 1,
  comboWindow: 1.4,
  comboThreshold: 5,
  comboBonus: 3,
  autoInterval: 0.9,
  edgeZ: -3.15,
  trayY: -1.4,
  lostY: -6,
  pusherSpeed: 1.9,
  payoutTilt: 1.2,
  playfieldFrontZ: -3.2,
  playfieldBackZ: 4,
  pusherOriginZ: 1.25,
  pusherAmplitude: 0.9,
  pusherDepth: 2.8,
  upperTrayY: 0.62,
  upperTrayHeight: 0.18,
  // The fixed rear deck must sit strictly below the moving tray's top face. If the two
  // are coplanar a coin touches both at once, and the conflicting static/kinematic
  // friction constraints ratchet it forward a little every stroke. Tune, don't zero.
  deckClearance: 0.01,
  // The scraper only bites at full retreat, so where it sits fixes, in one shot, how far
  // forward a tray coin can ever be shoved: scraperZ - 0.08 - COIN_RADIUS - (origin +
  // amplitude), in tray-local Z. Anything between that point and the tray's front lip at
  // -pusherDepth/2 is swept by nothing and can only be cleared by coins shoving each other.
  // At 2.55 that span was 1.36 — nearly two coin diameters — and the tray gridlocked: coins
  // rode back and forth forever instead of spilling to the lower bed. Keep it under one
  // diameter (tests/physics.test.js "sweep coverage").
  // 1.6 over-corrected the other way: a scraped coin ended 0.05 from overhanging, so the
  // upper tier drained on the next nudge. 1.8 leaves 0.25 (span 0.61 of a 0.72 diameter).
  scraperZ: 1.8,
  // Must clear the scraper by a coin radius, or drops land behind it where nothing pushes
  // them forward, while still staying over the tray for the whole stroke.
  dropZoneZ: 0.95,
});

// Mirrors the CSS design tokens in src/styles.css — keep the two in step.
export const PALETTE = Object.freeze({
  scene: 0x040a12,
  fog: 0x050c16,
  mint: 0x00c8b4,
  mintSoft: 0x2ee6d2,
  gold: 0xf2c94c,
  goldSoft: 0xffe9a3,
  blue: 0x3b4fd8,
  purple: 0x7a37b8,
  felt: 0x0a3a42,
  metal: 0x11202c,
  dark: 0x071320,
  white: 0xeef7fb,
});

export function getQualityProfile() {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const memory = navigator.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const lowPower = reducedMotion || memory <= 4 || cores <= 4;

  return Object.freeze({
    lowPower,
    reducedMotion,
    pixelRatio: Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 1.75),
    shadows: !lowPower,
    seedCount: lowPower ? 48 : 64,
    // Leave room for player drops while bounding collision pairs, shadows, and draw calls.
    coinCap: lowPower ? 72 : 96,
    sparkCount: reducedMotion ? 0 : lowPower ? 32 : 56,
    // Flat coins tip on tiny impulse errors: a coin's moment about a diameter is only
    // ~0.006, so a 0.001 N.s solver residual at the rim spins it several degrees a second.
    // Under-iterating shows up as the pile visibly shivering in place rather than drifting.
    // Averaged over pile seeds the original convergence knee was around 28. The normal
    // profile keeps a little headroom for dense, moving stacks; the low-power path still
    // gets the full stable baseline instead of dropping below it.
    solverIterations: lowPower ? 28 : 32,
    // Thin, stacked cylinders are much more stable at 120 Hz. Keep the 60 Hz path on
    // constrained devices, where doubling every narrowphase pass is too expensive.
    physicsStep: lowPower ? 1 / 60 : 1 / 120,
    physicsMaxSubSteps: lowPower ? 4 : 8,
  });
}
