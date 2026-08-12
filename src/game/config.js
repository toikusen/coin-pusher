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
  edgeZ: -3.55,
  trayY: -1.4,
  lostY: -6,
  pusherSpeed: 1.9,
  payoutTilt: 1.2,
  // Interior half-width, measured to the inner face of the glass. Every part of the cabinet is
  // cut from this and physics.js fills it with as many seed columns as clear the walls, so this
  // is the one number to move when the machine should feel wider. The camera does not follow
  // it: widen past ~4 and setupScene has to pull back or the glass leaves the frame.
  playfieldHalfWidth: 3.55,
  // Keep the lower tier only a few coin diameters deeper than the blade's forward reach. Both
  // reference machines maintain a continuous force chain from blade to payout lip; a five-plus
  // coin dead span lets a sparse pile split into islands that no stroke can move.
  playfieldFrontZ: -3.6,
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
  // The visible scraper is intentionally low, but its collision guard reaches the top of the
  // side glass. A rail coin can bounce higher than the visible plate after hitting the pile;
  // without this guard it can vault the scraper and become stranded on the fixed rear deck.
  scraperGuardTopY: 2.15,
  // Must clear the scraper by a coin radius, or drops land behind it where nothing pushes
  // them forward, while still staying over the tray for the whole stroke.
  dropZoneZ: 0.95,
  // Launch rails. A coin enters on its edge from one side, rolls inwards, runs off the rail's
  // inner end and arcs down onto the tray. Aim is one axis doing two jobs: its sign picks the
  // rail, its magnitude is the launch power, and power is the only thing that moves the landing
  // spot: the rail decides which way the spread runs, the power how far along it.
  // The three numbers below are tied together, not independent. railExitX is set to
  // railSpeedMin * the fall time off the rail, so the weakest launch lands on the centre line
  // and drops as good as vertically - that is the resting state of this mechanic, and moving
  // railExitX alone slides it off centre. railSpeedMin also has a floor of its own: it is what
  // the whole roll runs at, and much under 2.5 the coin crawls in for longer than the auto-drop
  // interval. Widen railSpeedMax for more spread; beyond about 7 a coin lands on its edge with
  // enough speed left to roll clear across the tray into the far wall.
  railY: 2.05,
  railRise: 0.28,
  railExitX: 0.95,
  railSpeedMin: 2.8,
  railSpeedMax: 6.5,
  railDepth: 0.42,
  // Optional cabinet model at public/models/cabinet.glb. Absent by default and absent is fine -
  // the procedural cabinet stands in. The offsets are hand-tuning: no downloaded cabinet has its
  // playfield opening exactly where ours is.
  // Exporters disagree about which way is front; Silver Skis faces -X, so a quarter turn. Get the
  // yaw wrong and the fit is wrong with it - the width fit keys off the anchor part's X extent,
  // and at the wrong yaw that extent is the machine's depth, not its width.
  cabinetYaw: -Math.PI / 2,
  cabinetOffset: Object.freeze({ x: 0, y: 0, z: 0 }),
  // The model part to align to our playfield, matched like cabinetHide. This, not the model's
  // overall size, is the right anchor: a downloaded cabinet is a whole standing machine - legs,
  // base, marquee, about twice as tall as it is wide - while our procedural geometry is only the
  // playfield box. Fit by overall width and the model's own bed lands nowhere near ours. Fit by
  // its bed and everything else falls into place around it, including the parts that end up below
  // the floor, which the floor hides anyway.
  // Empty string falls back to fitting the whole model by width.
  cabinetFitPart: 'coin_area',
  // Fraction of the machine's width the fit part should span. Under 1 leaves our glass and bed
  // proud of the shell, which is usually what a too-boxy cabinet needs.
  cabinetWidthFit: 1,
  // Parts of the model that should light themselves. A marquee is a backlit sign: lit only by room
  // light it reads as a painted board, which is what makes a downloaded cabinet look switched off.
  cabinetGlow: Object.freeze(['uppwerbody_banner_frame']),
  // Parts of the model to drop, matched as substrings against a mesh's name and its parents'.
  // A downloaded pusher brings its own playfield, pusher arms and often a ground plane, and every
  // one of those fights the geometry that is actually wired to the physics. Names come from the
  // glTF nodes - the meshes themselves are all called "defaultMaterial", so matching only the mesh
  // name finds nothing. Load with DEV on and read the logged tree to extend this.
  cabinetHide: Object.freeze([
    'Plane',          // its own ground plane; we have a floor
    'coin_path',      // its lanes and lane glass
    'coin_area',      // its coin bed
    'middle_divider', // lane divider
    'moving_arms',    // its pusher
    // Sounds harmless, is not: a 7.2-wide plate lying across y -0.11..0.66, z -0.77..-0.23, which
    // is the middle of our lower bed. It is the model's own tier divider. The tray hides it at the
    // front of the stroke and uncovers it at full retreat, which is why it only showed up as a grey
    // slab appearing and disappearing under the pusher.
    'arcrylic_glass',
  ]),
});

// Mirrors the CSS design tokens in src/styles.css — keep the two in step.
// tests/palette.test.js fails if they drift.
export const PALETTE = Object.freeze({
  scene: 0x030710,
  fog: 0x050c16,
  mint: 0x00c8b4,
  mintSoft: 0x2ee6d2,
  gold: 0xf2c94c,
  goldSoft: 0xffe9a3,
  blue: 0x3b4fd8,
  purple: 0x7a37b8,
  felt: 0x0a2632,
  metal: 0x11202c,
  dark: 0x071320,
  white: 0xeef7fb,
  // Cabinet body ramp. The style sheet's machine is a near-black navy shell and neon is the
  // only saturated colour on it, so nothing here is allowed to approach mint: the moment the
  // body reads teal the coins and the backdrop stop separating from it.
  shell: 0x0e1624,
  shellRaised: 0x142235,
  shellDeep: 0x081020,
  glassTint: 0x1d5c66,
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
    // Keep the lower bed as a sparse single layer at startup. The remainder lives on the
    // moving tray and feeds the bed naturally once play begins; starting with ~100 coins made
    // the 48-slot lower bed two to three layers deep before the player could take a turn.
    seedCount: lowPower ? 24 : 26,
    // Leave room for player drops while bounding collision pairs, shadows, and draw calls.
    coinCap: lowPower ? 116 : 144,
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
