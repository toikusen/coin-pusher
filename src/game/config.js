// Not frozen: the geometry panel writes the seven Z keys below back into it through
// applyMachineGeometry(), and every consumer reads GAME at call time so a live machine follows.
// Everything else here is a constant - change it in this file, not at runtime.
export const GAME = {
  startingCredits: 50,
  missionTarget: 25,
  premiumChance: 0.16,
  premiumValue: 3,
  regularValue: 1,
  comboWindow: 1.4,
  comboThreshold: 5,
  comboBonus: 3,
  autoInterval: 0.9,
  // Tied to playfieldFrontZ by exactly 0.05 - "keeps the payout crossing aligned with the
  // shortened front edge" asserts it, so the two always move together.
  edgeZ: -4.65,
  trayY: -1.4,
  lostY: -6,
  pusherSpeed: 1.9,
  payoutTilt: 1.2,
  // Interior half-width, measured to the inner face of the glass. Every part of the cabinet is
  // cut from this and physics.js fills it with as many seed columns as clear the walls, so this
  // is the one number to move when the machine should feel wider. The camera does not follow it,
  // and 4 is close to the end of the road at the current framing: the top of the front glass lands
  // at 0.81 of the frame's half-width on a square-ish window, and because fov is vertical that
  // share grows as the window gets narrower - a portrait window clips the glass corners a little
  // past here. Widen further and setupScene has to pull back with it.
  playfieldHalfWidth: 4,
  // Keep the lower tier only a few coin diameters deeper than the blade's forward reach. Both
  // reference machines maintain a continuous force chain from blade to payout lip; a five-plus
  // coin dead span lets a sparse pile split into islands that no stroke can move. This is why the
  // lower bed cannot simply be lengthened: its visible length IS that span, and at 3.44 diameters
  // it sits 0.04 off the guard in tests/physics.test.js. The 0.25 it gained came from pushing the
  // blade 0.25 further forward instead - see pusherAmplitude - which keeps the span where it was.
  // -3.85 -> -4.20 is not slack being spent: the 0.04 is still there. The blade's forward extreme
  // moved the same 0.35 (pusherAmplitude 1.3 -> 1.65), so the span is still 2.48 against its 2.52
  // ceiling and the bed is 0.35 nearer the player. The visible bed gains twice that - see
  // pusherAmplitude - because the tray's lip at full retreat travels the other way by 0.35.
  // -4.20 -> -4.70 is the "make the chest work for it" step, and it is the only one of these that
  // does spend the slack. 0.35 of it is free: the blade's forward extreme moved the same 0.35
  // (pusherAmplitude 1.65 -> 2.0, with pusherOriginZ taking 0.3 of the stroke back towards the rear
  // so the growth is split between the two ends of the machine rather than all of it arriving in
  // the player's lap). The last 0.15 is bought, and the dead span goes 2.28 -> 2.43 against 2.52.
  // What bought it: the longer stroke throws the upper seed's top layer onto the lower pile harder
  // during the load settle, and the pile's front row creeps 0.71 instead of 0.63 - past the 0.69 it
  // had before the lip. The 0.15 is that creep's headroom, and physics.js's LOWER_FRONT_GAP moved
  // with it by the same amount so the seeded pile sits exactly where it did relative to the blade.
  // Measured with dbg over five pile seeds: worst front coin ends at -4.52, i.e. 0.13 clear.
  playfieldFrontZ: -4.70,
  // 4 -> 4.36 keeps the cabinet wall behind the scraper after the upper strip gains half a coin.
  playfieldBackZ: 4.36,
  // These three place the moving assembly, and none of them is the knob for how much tray the
  // player can see. The scraper is a full-width wall, so the only part of the tray coins ever use
  // is the strip in front of it, and that strip is scraperZ - 0.08 - (origin + amplitude -
  // pusherDepth/2) - move any of these and the scraper has to move with it or the strip changes.
  // Two things are load-bearing here, both learned the hard way:
  //  - amplitude is the payout. 0.84 - a 7% shorter stroke - halved it ("pays out under sustained
  //    play" returned 5 against a floor of 10), because the lower pile advances per stroke and a
  //    short stroke drops that under what friction takes back on the return.
  //  - the blade's forward extreme is origin - amplitude - pusherDepth/2 and the lower bed's dead
  //    span is measured from it, with only 0.04 of slack (tests/physics.test.js "sweep coverage").
  //    Pulling the assembly back at all spends that, and past it the lower bed has to come too:
  //    playfieldFrontZ, edgeZ and the chute.
  // Amplitude is not the cycle time. physics.js drives the tray as origin + amplitude * sin(t *
  // pusherSpeed), so the period is 2*pi/pusherSpeed - 3.31s - whatever the amplitude is. What a
  // longer stroke buys is peak blade speed, amplitude * pusherSpeed, and that is why it reads as
  // payout: the blade shoves harder, not more often.
  // These two got here in two steps, and both were forced by the dead span:
  //  - amplitude 0.9 -> 1.15 to lengthen the lower bed. It is the only lever that does that without
  //    widening the span, because the blade reaches 0.25 further forward and playfieldFrontZ follows
  //    it. The visible bed gains twice the move: the tray's own front lip retreats by it as well.
  //  - then origin 1.25 -> 1.4 with amplitude 1.15 -> 1.3, to sit the tray further back. Moving
  //    origin alone is what the guard forbids - it retreats the blade and the span grows one for one
  //    with only 0.04 to spend - so the amplitude matches it and the forward extreme, origin minus
  //    amplitude, stays exactly where it was. Only the retreat moves, and by twice the step.
  // Together that is a blade sweeping 2.6 at 2.47 peak against the original 1.8 at 1.71. The tray's
  // visible strip would have been the casualty (it is measured from origin + amplitude), so scraperZ
  // and dropZoneZ moved back by the full 0.3 to hold it, and pusherRearExtension grew to keep the
  // deck covered at the forward extreme. Payout only moves the safe way through all of this.
  // To give the player more tray, move scraperZ back on its own - see there.
  // Third step, and the one that finally lengthened the lower bed: amplitude 1.3 -> 1.65 with origin
  // standing still. Both extremes move 0.35 outwards, which is the point - the forward one lets
  // playfieldFrontZ follow it towards the player, the rear one retreats the tray's lip, and the
  // visible bed picks up both: 5.15 -> 5.85, or 7.2 -> 8.1 coin diameters.
  // It is not free, and this is the one to undo first if the machine feels loose. Peak blade speed
  // is amplitude * pusherSpeed, so it went 2.47 -> 3.14 and the machine pays out more freely; the
  // floor guard only checks the machine is not stingy, so nothing catches that. Two knock-ons had
  // to move with it or a guard would have failed: pusherRearExtension 1.15 -> 1.85 to keep the deck
  // covered at the forward extreme, and scraperZ 2.56 -> 2.91 (with dropZoneZ) so the tray's visible
  // strip did not pay for the bed - the strip is measured from origin + amplitude.
  // Fourth step, and the one the bonus chest asked for: the chest was dropping onto a bed it could
  // be shoved off in a couple of strokes. The lower bed's length has a hard ceiling of 2 * amplitude
  // + 0.07 + 7 coin radii - the dead-span guard ties playfieldFrontZ to the blade's forward extreme,
  // so every extra centimetre of bed is two of amplitude and nothing else buys it. 1.65 -> 2.0 is
  // +0.7 of bed, and playfieldFrontZ spends 0.15 of its own slack on top: 5.65 -> 6.50, or 7.9 ->
  // 9.0 coin diameters. Measured with chest-tmp.mjs over two pile seeds, a dropped chest now takes
  // 133s / 127s to reach the lip against 70s / 107s before, and still always pays. chestMass is the
  // knob if that reads as too long a wait - it is what decides how much pile it takes to budge it.
  // origin 1.4 -> 1.7 only decides where the growth lands. Standing still would have put the whole
  // 0.7 in front of the machine, with the chute and the launcher's muzzle following it towards the
  // camera; +0.3 splits it, so the payout lip comes 0.5 nearer the player and the tray's retreat
  // takes 0.35 towards the back panel. Nothing else in the machine notices the split - span, seed
  // rows and the visible tray strip are all unchanged.
  // The bill is the same one the third step paid: peak blade speed is amplitude * pusherSpeed, now
  // 3.14 -> 3.80, and the machine pays coins out more freely for it. pusherSpeed is the knob to trim
  // if it reads loose - it is the only one that touches speed without touching any of the geometry.
  // 1.7/2.0 -> 1.88/2.18 keeps the forward extreme at -0.3 while moving the retreat extreme
  // 0.36 deeper. The full stroke gains the same half-coin distance the upper coins now travel.
  pusherOriginZ: 1.88,
  pusherAmplitude: 2.18,
  // 2.8 -> 3.2, paired with pusherRearExtension 1.85 -> 1.65 so the tray's rear edge does not move
  // at all: depth/2 + rearExtension is unchanged, and the whole 0.4 goes into the front lip, which
  // travels 0.2 towards the player. That is what buys dropZoneZ its room - the lip at full retreat
  // is the wall the landing point sits behind.
  // Deepening from the front is the cheap direction: the blade reaches 0.2 further forward too, so
  // the lower dead span drops 2.48 -> 2.28 against its 2.52 ceiling, and the tray's visible strip
  // grows 1.18 -> 1.38. What it costs is 0.2 of the lower bed (5.85 -> 5.65, still 7.8 diameters)
  // and some payout, because a coin now rides the tray longer before it can spill.
  // The ceiling here is the scraper, not the guards above: the unswept tray span is measured from
  // -pusherDepth/2. The former 1.5-diameter limit came from a stale simulation that omitted the
  // moving rear extension; the runtime-matching payout check now guards the two-diameter limit.
  // 3.2 -> 3.8, paired with the +0.35 of amplitude that is not absorbed by origin: depth grows by
  // twice what the stroke's extremes moved, so the tray's front lip and its unswept strip both stay
  // exactly where they were and the whole 0.6 goes into tray the player can stack on (4.4 -> 5.3
  // coin diameters). The scraper moves 0.35 with the stroke, so the 0.06 of gridlock headroom below
  // is untouched.
  pusherDepth: 3.8,
  // Extra deck behind the functional pusher depth. It extends only towards the cabinet rear,
  // so the blade position, stroke and payout tuning stay unchanged. At the forward extreme the
  // old rear edge stopped 0.51 before the scraper and exposed a conspicuous patch of fixed deck.
  // This carries the moving surface just under the scraper; the excess at full retreat disappears
  // beneath the back panel.
  // Not a free number: it must reach the scraper's back edge from the tray's forward extreme,
  // scraperZ + 0.08 - (origin - amplitude + pusherDepth/2), which the longer stroke and the moved
  // scraper together pushed to 1.14 ("machine proportions" guards it). 0.6 would now uncover the
  // deck at the forward extreme. The tail this leaves at full retreat runs past the back panel and
  // is hidden by it - the panel spans the tray's whole height, so nothing shows from the front.
  // 1.15 -> 1.85: the longer stroke pulled the forward extreme 0.35 forward and the scraper moved
  // 0.35 back, so the reach it has to cover grew by both. 1.84 was the exact requirement.
  // 1.85 -> 1.65 gives back exactly the 0.2 pusherDepth just gained, because the requirement is on
  // depth/2 + this: the tray's rear edge stays put and only its front lip moves. Lengthening the
  // tail instead would have pushed it further past the back panel for nothing.
  // 1.65 -> 1.75: the requirement is on depth/2 + this, and the deeper tray gave back 0.3 of it
  // while the scraper moving 0.35 back took 0.35. 1.74 was the exact requirement.
  // 1.75 -> 1.81 follows scraperZ's last 0.06 one for one, which is what this always has to do:
  // the reach is measured to the plate's back edge, so a plate further back is deck to cover.
  // 1.81 -> 2.17 follows the scraper's 0.36 move so the moving deck still covers it at full reach.
  // 2.17 -> 2.53 follows the scraper alone, exposing half a coin more usable upper tray.
  pusherRearExtension: 2.53,
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
  // rode back and forth forever instead of spilling to the lower bed. 1.6 over-corrected the
  // other way: a scraped coin ended 0.05 from overhanging, so the upper tier drained on the
  // next nudge.
  // This is also the only knob that adds visible tray without moving the assembly: the strip
  // the player sees in front of the scraper is span + COIN_RADIUS, so back is deeper, one for
  // one, and everything else - origin, amplitude, pusherDepth - only trades depth against the
  // blade or the stroke. 1.8 gave 1.35 coin rows of strip and that read as a single row at full
  // retreat, which is what this moved for. Measured by walking it up against the payout guard:
  //   1.90 -> 1.49 rows, pays out       1.98 -> 1.60 rows, pays out
  //   2.08 -> 1.74 rows, payout 7       2.26 -> 1.99 rows, payout 9   (old floor was 10)
  // 2.26 is a deliberate trade, made explicitly: a second visible row of coins on the tray in
  // exchange for roughly a fifth of the payout rate. Both guards moved with it and both record
  // the trade - tests/physics.test.js "sweep coverage" and the payout floor. Anything past here
  // is untested and 1.8-2.0 is the range to come back to if the machine feels stingy.
  // 2.26 -> 2.56 is not another step along that walk. The tray was moved 0.3 further back (see
  // pusherOriginZ) and the strip is measured from origin + amplitude, so standing still here would
  // have cost the whole 0.3 of it. Moving with the tray by exactly the same 0.3 leaves the span,
  // the row count and the payout where they were - the numbers above still read against 2.26.
  // 2.56 -> 2.91 is the same kind of move as 2.26 -> 2.56: the tray's retreat extreme went back by
  // 0.35 with the longer stroke, so standing still here would have handed the whole 0.35 of visible
  // strip to the lower bed. Tracking it leaves the span, the row count and the payout numbers above
  // reading exactly as they did.
  // 2.91 -> 3.26 tracks the tray's retreat extreme again, for the same reason as every step before
  // it: the strip is measured from origin + amplitude, so standing still would have handed all 0.35
  // of it to the lower bed. The span, the row count and the payout numbers above still read.
  // 3.26 -> 3.32 used the last headroom under the former 1.5-diameter limit and made two coin rows
  // visible. The way to move the plate without adding visible tray is to take the whole moving
  // assembly back with it (pusherOriginZ and pusherAmplitude together, then this by twice their
  // step), which leaves the span alone but grows the bed and the stroke.
  // 3.32 -> 3.68 follows the retreat extreme by 0.36; the unswept span stays at its tested limit.
  // 3.68 -> 4.04 adds half a coin of visible upper travel. With the test pusher corrected to include
  // its real rear extension, the two-diameter unswept span still clears the end-to-end payout floor.
  scraperZ: 4.04,
  // The visible scraper plate stands 1.2 tall off the tray, and its collision guard reaches
  // higher still, to the top of the side glass. A rail coin can bounce higher than the visible plate after hitting the pile;
  // without this guard it can vault the scraper and become stranded on the fixed rear deck.
  scraperGuardTopY: 2.15,
  // Must clear the scraper by a coin radius, or drops land behind it where nothing pushes
  // them forward, while still staying over the tray for the whole stroke. The rails hang off
  // this, so it is also where the launch track sits. It tracks scraperZ rather than being a
  // depth of its own - the strip is what a drop has to land in the middle of. 0.95 was only
  // 0.2 behind the lip at full retreat, a drop landing on the row about to spill; 1.5 is 0.75
  // back, mid-strip, so a fresh coin gets swept at least once before it can reach the edge.
  // 1.5 -> 1.8 -> 2.15 tracked scraperZ. 2.15 -> 2.05 -> 1.85 stopped tracking it on purpose: the
  // landing read as being against the scraper, because the steeper arc and the close camera put a
  // full-height plate right behind the touchdown. The gap from the coin's back edge to the scraper
  // face went 0.32 -> 0.42 -> 0.62 across those two steps.
  // The wall is the tray, not the scraper: at full retreat the lip is at origin + amplitude -
  // pusherDepth/2, and a coin centre closer than that plus its radius hangs over the lip and tips
  // onto the lower bed instead of being swept. 2.05 was hard against that wall, which is why the
  // second step had to move the lip - see pusherDepth. 1.85 leaves the usual 0.04, and "drop zone"
  // guards it with the coin's radius rather than its centre.
  // It is also the launcher's landing point now - see launcherTargetFor.
  // 1.85 -> 2.20 with the tray's lip, which is the wall it is measured against. Still 0.04 clear.
  // 2.20 -> 2.56 follows the retreating tray and keeps the same landing clearance at both ends.
  dropZoneZ: 2.56,
  // How much clear tray the landing keeps between the coin's back edge and the scraper's face.
  // What sets the landing point is now this gap, not the tray's front lip: the lip bound only ever
  // said "far enough back not to spill on arrival", which put every drop 0.04 from the spill line -
  // one row from the edge, where a fresh coin barely meets the pile before it is scraped off. Deep
  // is where a drop does work: the further back it lands the more strokes it spends shoving the
  // rows in front of it. Not the same trade as widening the unswept span, which does cost payout -
  // the span is untouched here, and the end-to-end run in tests/physics.test.js returns the same 11
  // of 35 at 0.62 as it does at the old 1.12.
  // 0.62 rather than the 0.08 the collision guard needs, because a landing hard against a
  // full-height plate reads as bouncing off it. It is the same gap the drop point was tuned to
  // when it last sat near the scraper (see the 0.32 -> 0.42 -> 0.62 walk above), now approached
  // from the other side.
  dropZoneScraperGap: 0.62,
  // Front launcher. The player moves this along a rail below the payout lip; every shot keeps
  // its X and is guided to a point expressed in the pusher's local space. Keeping the target
  // local is the guarantee: the pusher can move through its whole stroke while the coin is in
  // flight and the endpoint still rides with it.
  // Tracks playfieldHalfWidth less the 0.55 that keeps a launched coin off the glass.
  launcherTravelHalfWidth: 3.45,
  // Pulled 0.62 towards the player and lifted 0.35 for the first-person camera: at the old
  // -5.28/-0.6 the gun sat below the frame's bottom edge and behind the cabinet's front panel.
  // The muzzle pair moves with it - muzzleZ keeps its 0.7 lead over launcherZ, which is the plane
  // build_launcher.py ends the barrel on, and muzzleY takes the same 0.35, so the guide arc still
  // starts at the barrel rather than under it.
  // How far the barrel may swing off straight. The launcher's travel is capped by what the window
  // frames (updateLauncherReach), but the landing spread is not - so on a narrow window the two
  // pull apart and the barrel turns to cover the difference. A cap because the geometry does not
  // stop: at an extreme aspect the aim-at-target angle keeps opening, and past about 20 the barrel
  // is broadside to the camera and reads as pointing at the player rather than into the machine.
  launcherFanDegrees: 18,
  launcherZ: -5.9,
  launcherMuzzleY: 0.06,
  launcherMuzzleZ: -5.2,
  launcherMountY: -0.25,
  // The landing point is dropZoneZ - fixed in world space, no constant of its own. A tray-local
  // target rode the stroke, so the guide arc visibly swung 2 * pusherAmplitude back and forth
  // every 3.31s; dropZoneZ is already guarded to sit over the tray for the whole stroke and in
  // front of the scraper, which is everything a tray-local target was buying.
  // Where the scripted arc hands the coin to physics: the coin's resting centre on the upper
  // tray, upperTrayY + upperTrayHeight/2 + COIN_HEIGHT/2. It cannot reference those from inside
  // this literal, so "launcher handoff" in tests/physics.test.js holds it to the derivation.
  // 1.24 -> 0.76: the old value ended the arc 0.48 above the tray. Both the coin's forward motion
  // and the guide line stopped dead in mid-air there and the coin then free-fell the rest, which
  // read as a bounce off the scraper standing behind it at that exact height.
  launcherLandingY: 0.76,
  launcherFlightTime: 0.56,
  // Peak of the scripted flight, on top of the muzzle-to-landing lerp, so the apex is roughly
  // 0.95 + this. 1.5 -> 2.6 for a visibly steeper launch; the ceiling is the cabinet's window
  // opening, and at 2.6 the coin tops out at 3.55 near z -0.95, which is still inside it. Much
  // past 3 and the coin clips through the machine's top frame on its way over.
  // This is now the guide line's arc height too. It used to draw with a hardcoded 0.72, so the
  // dashed preview showed less than half the arc the coin actually flew.
  launcherArcHeight: 2.6,
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
  // Optional cabinet shell at public/models/cabinet.glb, built by tools/build_cabinet.py.
  // Absent is fine - the procedural cabinet stands in. It needs no keys here: the build script
  // authors the model at the world origin the mount expects, so there is no yaw, no offset, no
  // fit part and nothing to hide. See docs/superpowers/specs/2026-09-08-cabinet-shell-design.md.
  // Bonus chest. Every chestScoreStep points a chest drops into the machine; it is scored exactly
  // like a coin - only when it has been swept off the upper tray, shoved across the lower bed and
  // dropped over the payout lip does the slot machine spin at all, and the spin can still miss
  // (slotOutcomes). chestReward is the 777 prize, not what a chest is worth on average - at even
  // odds that is about 29 points, roughly 60% on top of the 50 that earned the chest.
  // The chest is a real rigid body throughout: it lands at the back of the upper tray, hard against
  // the scraper (physics.js chestDropZ) at a random X, and from there it collides, tumbles and
  // rides the pile like anything else. It has no hold timer - it stays in the world until it falls.
  // Every threshold gets its own chest and several share the machine, so the drop X is random
  // rather than fixed - two chests spawned inside each other shove one another out of the tray.
  chestScoreStep: 50,
  // 0.8 of chestScoreStep, and read against what the other two prizes are actually worth: a coin
  // averages 1.32 points (premiumChance 0.16 at premiumValue 3), so the money bag's 40 coins come
  // to about 55 once they are all pushed off, and a measured quake shook 14 coins over the lip for
  // 21. At 10 the jackpot was the weakest of the three despite being the headline, after a chest
  // that spends over two minutes crossing the machine. 40 puts it between them: less raw score
  // than a fully pushed bag, but instant and certain, where the bag and the quake both hand back
  // coins the player still has to work. It cannot run away with the game either - chestsDue is
  // deliberately blind to this, so a jackpot never pays for the next chest (see rules.js).
  chestReward: 40,
  // A bit over one and a half coin diameters. The ceiling is the scraper, not taste: the model is
  // 0.74 deep for every 1 wide and the tray's unswept strip is about 1.5 diameters, so past ~1.45
  // the chest is too deep to be cleared and parks on the tray until its hold runs out.
  chestWidth: 1.15,
  // About eighteen coins. Mass is what decides whether the chest lands like a prize or a wrecking
  // ball, and now that the chest has to travel the whole machine to pay, it is also the only knob
  // for how hard it is to shove: past the blade's forward extreme (-1.85) nothing touches the chest
  // directly, so from there to the lip it moves only through the coin chain, and the heavier it is
  // the more pile it takes to budge it. There is a real ceiling. Measured with chest-tmp.mjs, time
  // from drop to payout over two pile seeds:
  //   0.25 -> 77s / never (rode the pile top and parked 0.33 short of the lip)
  //   0.90 -> 70s / 107s   (both drain; it plows into the pile instead of riding it)
  //   1.80 -> 103s / never (too heavy for the chain, parked 0.7 short)
  // 0.9 is the heaviest tested value that still always pays. Go higher and the chest starts to
  // become a permanent obstacle, which also blocks every later chest - one at a time is the rule.
  chestMass: 0.9,
  // How much stickier the chest is than a coin, applied to all three coin frictions. Two separate
  // jobs in one number, and neither is mass: on the payout tilt (gravity z is -payoutTilt, a
  // permanent forward slope) whether a body slides is friction against slope, mass cancels out -
  // which is why a heavier chest still slid straight off the lower bed. And the chest starts far
  // behind on grip: syncFrictionGravity divides the world's friction budget by a coin's 20 rim
  // contacts, while a box rests on 4, so on the coin material it keeps roughly a fifth of the
  // intended coefficient. About 5 of this is undoing that discount; the rest is the "hard to shove"
  // the chest is supposed to feel like.
  chestFrictionScale: 8,
  // The chest's own damping, not the coin tuning's. Friction stops it sliding, but the drop off the
  // tray's lip lands it with a tumble, and a high-friction box converts a slide into a roll - which
  // is how a chest that grips the bed still ran straight out to the lip. Matching high linear and
  // angular damping kills both parts of that landing momentum: at 0.9 either is down to a tenth of
  // its speed within a second, so the chest thuds and stops instead of running the bed out.
  chestLinearDamping: 0.9,
  chestAngularDamping: 0.9,
  // Released from just under the slot machine. Higher and the cabinet's top frame hides the first
  // half of the fall; lower and it appears already on top of the tray.
  chestStartY: 3.4,
  // Slot machine, mounted at the top of the machine. Deliberately NOT on the cabinet model's own
  // crown: that sits at y 9.1 and the camera, framed on the bed, tops out around y 5.8 at the front
  // - anything on the real crown is off screen. This hangs it just under the cabinet's top band
  // instead, which is the highest point of the machine the player can actually see.
  slotWidth: 2.24,
  slotY: 4.55,
  slotZ: -4,
  // tools/build_slot.py authors the machine facing -Z, which is where the player stands, so
  // there is nothing to turn. Kept as a key rather than dropped: a swapped-in model that faces
  // the other way is one number away from working again.
  slotYaw: 0,
  slotSpinSeconds: 1.9,
  // Dead time between two queued chests' spins. Chests pay one at a time (CoinPusher.spinSlot), and
  // without a gap the reels would take off again on the same frame the last result landed - the win
  // glow and the HUD line both need a beat to be read. Only ever waited when a chest is queued.
  slotHoldSeconds: 1.2,
  // Material name on the model's reel pane - one recessed window, carrying nothing but this
  // material so the loader can measure it and lay the canvas readout over it. Found nowhere else
  // on the model, and nowhere on the other two. No match means no readout and the machine stays
  // pure decoration; the win still announces itself in the HUD.
  slotReelMaterial: 'reel_glass',
  // Reel symbols and the chance each one lands as a three of a kind - rolled in rules.js
  // rollSlotResult. These do not have to add up to 1: whatever is left over is a miss, three
  // faces that do not line up and pay nothing. Adding an event is one entry here plus one handler
  // in main.js CHEST_PRIZES - nothing inside the slot itself is per-symbol.
  // Four prizes at 0.18, and the 0.28 left over is the miss. They stay per-outcome numbers rather
  // than a computed 1/n because the odds have been the main balancing knob here - this is a
  // starting point, not a rule. tests/rules.test.js fails if the prizes ever add up to 1, which is
  // the case where the miss silently disappears.
  // Expected value: the average prize is worth about 34 (40 jackpot, ~55 pushed-off bag, ~21
  // measured quake, ~20 gild on a steady-state pile), so a chest pays about 0.72 * 34 = 24.
  // label is what the cheat panel and the HUD call it - the symbol itself is a drawing key.
  slotOutcomes: [
    { symbol: '7', chance: 0.18, label: '777' },
    { symbol: 'bag', chance: 0.18, label: '錢袋' },
    { symbol: 'quake', chance: 0.18, label: '地震' },
    { symbol: 'gild', chance: 0.18, label: '鍍金' },
  ],
  // What the reels show with nothing in play. Deliberately not a prize symbol: an idle machine
  // must not sit there displaying a win it has not paid. Once a chest drops, the reels cycle
  // through the slotOutcomes symbols and nothing else, so every frame of the spin is a live
  // possibility rather than filler. tests/rules.test.js holds the two apart.
  slotIdleSymbol: '?',
  // Money-bag payout: coins rain over the upper tray from just under the slot machine. They are
  // real coins, not score - the prize is a loaded tray, which pays itself out through the normal
  // push-and-drop loop. Metered one every coinRainInterval rather than spawned in one frame:
  // forty bodies created inside each other is a solver explosion, and a stream reads better.
  coinRainCount: 40,
  coinRainInterval: 0.05,
  coinRainY: 3.9,
  // The same margin a dropped chest gets (playfieldHalfWidth less a chest width): far enough
  // inside the glass and the hidden corner posts that nothing lands on a wall.
  coinRainHalfWidth: 2.85,
  // Spread around dropZoneZ, which is already guarded to sit over the upper tray for the whole
  // pusher stroke - so every rained coin lands somewhere the scraper will eventually sweep.
  coinRainDepth: 0.8,
  // Earthquake payout: the cabinet shakes and the pile walks towards the payout lip. The kick is
  // an acceleration applied every frame for quakeSeconds, not one impulse: a single shove throws
  // the top layer over the glass and leaves the bottom one untouched, while a sustained rattle
  // breaks the friction chain and walks the whole pile forward, which is the point of the event.
  // Read against the world's own numbers - gravity is 24 and the permanent payout tilt is 1.2, so
  // quakeForward is a few times the tilt and every axis stays well under gravity.
  quakeSeconds: 1.5,
  quakeForward: 6,
  quakeJitter: 9,
  // Just enough to unstick a coin from the table; more and the pile hops instead of sliding.
  quakeLift: 2.5,
  // Camera travel in world units, at a 9.4 standoff. 0.11 was measured as about a third of a
  // degree - real but easy to miss; 0.18 reads as a shaking cabinet without turning into nausea.
  // Skipped entirely under reducedMotion - the physics still runs.
  quakeCameraShake: 0.18,
  // Gild payout: this share of the plain coins already on the machine turn premium, 1 point each
  // becoming premiumValue. The only prize that multiplies what the player has built instead of
  // adding to it - so it pays nothing on an empty machine, rewards a hoarded pile, and like the
  // bag and the quake it only cashes out as those coins are pushed off.
  // The ratio, not a coin count, because its worth has to track the pile. Measured in the real
  // machine, not the headless sandbox: the sandbox drains the bed far slower than the game does
  // and sits on 70-100 coins where the game holds a fraction of that. Forcing gild spins from the
  // cheat panel during auto-play, two runs gilded 6 coins at 0.3 and 7 at 0.5 - so the machine
  // carries 14-20 plain coins in steady state, and a gild is worth about ratio * 17 * 2 points
  // once they are pushed off. 0.6 puts that near +20, level with the measured quake and the
  // weakest of the other three prizes (40 jackpot, ~55 bag, ~21 quake); 0.3 paid +12, which is
  // half a quake for a headline event. Auto-play is the floor, not the average: it drains the bed
  // as fast as it fills it, and on a hoarded pile of 40 plain coins the same 0.6 pays +48. That
  // curve is the point of the event - it is the one prize worth more to a player who has built
  // something, so it must not be flattened into a fixed coin count.
  gildRatio: 0.6,
};

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
    // Ceiling on how much physics one frame may run, not a quality knob. world.step() replays
    // missed time as extra fixed steps, so a frame that already came in late replays several at
    // once - at 8 that is a 100 ms+ hitch on a crowded pile, which is what the stutter looks
    // like. cannon-es drops the leftover accumulator afterwards, so a lower cap costs a little
    // slow motion on a struggling device instead of the hitch.
    physicsMaxSubSteps: lowPower ? 2 : 3,
  });
}

// Lives here, not in physics.js, because the geometry derivations below need it and physics.js
// already imports this file - the other direction would be a cycle. physics.js re-exports it.
export const COIN_RADIUS = 0.36;

// The five geometry knobs the panel exposes, in the units the player sees: where the scraper
// stands, and the centre/length of each deck. Everything else about the machine's Z layout is
// derived from them below, so a slider can never leave two parts disagreeing about an edge.
//
// The stroke itself is deliberately not among them. pusherAmplitude and pusherDepth carry the
// payout calibration recorded above, so `upperLength` grows the tray's rear tail only: the blade
// stays exactly one half-depth in front of the centre, and the sweep is untouched.
export const MACHINE_GEOMETRY_DEFAULTS = Object.freeze({
  scraperZ: 4.04,
  upperCenterZ: 1.88,
  upperLength: 6.33, // pusherDepth + pusherRearExtension
  lowerCenterZ: -0.17,
  lowerLength: 9.06,
});

// Slider bounds. Picked so no part can leave the cabinet at any combination:
//  - the blade's forward extreme (centre - amplitude - depth/2, at worst -2.88) stays on the bed,
//    whose front edge is at worst -3.35;
//  - the bed's front lip stays behind the launcher muzzle at -5.2. That one is a derivation, not
//    a range: lowerLength is cut to whatever the chosen centre leaves in front of the muzzle, so
//    a machine pushed back can be much longer than one sitting forward without the payout lip
//    ever arriving on top of the gun;
//  - the scraper is clamped to the bed's back edge below, so it never stands outside the panel.
// The scraper's ceiling is deliberately past the point where the machine still plays well. Its
// hard stop is the bed's back edge, which the derivation below applies whatever the slider says,
// so the way to move it further back than that is to lengthen the lower deck or push its centre
// back - and the ranges here are sized so that combination reaches the top of the scraper's own
// range rather than stopping short of it. The cabinet model is no longer what caps lowerLength -
// loadCabinet stretches it along Z with the bed - so what is left is the muzzle derivation above:
// 13 is only reachable with the centre pushed most of the way back, and a bed sitting forward
// still stops at 9.5. What a very long bed costs is the dead span between the blade's forward
// extreme and the payout lip, which the note on playfieldFrontZ measures in coin diameters: past
// about five the pile splits into islands no stroke can reach, and 13 is close to that. What it costs on the way there is the unswept strip: a tray coin can only be shoved as
// far as scraperZ - 0.08 - COIN_RADIUS, and the tray's lip at full retreat sits at upperCenterZ +
// amplitude - pusherDepth/2, so the span nothing sweeps is exactly scraperZ - upperCenterZ - 0.72,
// one coin diameter per 0.72 of it. At the defaults that is two diameters, which is what the
// "sweep coverage" guard in tests/physics.test.js calls the limit; past it the tray starts to
// gridlock, coins riding back and forth instead of spilling. Moving the upper deck's centre back
// by the same step keeps the span where it was, which is what makes the top of this range usable.
// upperLength's ceiling is raised with it for one reason: the deck has to reach under the scraper
// wherever it stands, and the slider should be able to show the length that takes.
export const MACHINE_GEOMETRY_LIMITS = Object.freeze({
  scraperZ: Object.freeze([2.9, 6]),
  upperCenterZ: Object.freeze([1.2, 2.4]),
  upperLength: Object.freeze([5.6, 9]),
  lowerCenterZ: Object.freeze([-0.45, 1.2]),
  lowerLength: Object.freeze([7.6, 13]),
});

const clampGeometry = (key, value) => {
  const [min, max] = MACHINE_GEOMETRY_LIMITS[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : MACHINE_GEOMETRY_DEFAULTS[key];
};

// Pure: takes a possibly partial, possibly hostile patch (it comes back from localStorage) and
// returns the whole live Z layout. Two derivations are not free choices:
//  - the moving deck must still reach under the scraper at its forward extreme, or the retreating
//    tray opens a slot straight down to the lower bed. upperLength is raised to meet it.
//  - the landing point sits a coin's radius behind the tray's lip at full retreat, which is what
//    dropZoneZ has always been - see the note on it above.
export function machineGeometryFor(saved = {}) {
  const scraperZ = clampGeometry('scraperZ', saved.scraperZ);
  const upperCenterZ = clampGeometry('upperCenterZ', saved.upperCenterZ);
  const lowerCenterZ = clampGeometry('lowerCenterZ', saved.lowerCenterZ);
  // Keep the payout lip behind the launcher's muzzle, whatever pair of values arrives here.
  const lowerLength = Math.min(
    clampGeometry('lowerLength', saved.lowerLength),
    2 * (lowerCenterZ - GAME.launcherMuzzleZ),
  );
  const lowerFrontZ = lowerCenterZ - lowerLength / 2;
  const lowerBackZ = lowerCenterZ + lowerLength / 2;
  const bladeZ = upperCenterZ - GAME.pusherAmplitude - GAME.pusherDepth / 2;
  const upperLength = Math.max(
    clampGeometry('upperLength', saved.upperLength),
    Math.min(scraperZ, lowerBackZ) + 0.08 - bladeZ,
  );

  return {
    scraperZ: Math.min(scraperZ, lowerBackZ),
    upperCenterZ,
    upperLength,
    lowerCenterZ,
    lowerLength,
    lowerFrontZ,
    lowerBackZ,
    edgeZ: lowerFrontZ + 0.05,
    // As far back as the gap allows, then bounded on both sides: never behind the scraper's reach,
    // where a coin is on the strip the blade cannot touch and sits until something knocks it loose,
    // and never in front of the tray's lip at full retreat, where it tips onto the lower bed on
    // arrival instead of being swept. The gap sits inside the reach bound at any tuning, so only a
    // very short tray can make the lip bound bite.
    dropZoneZ: Math.min(
      Math.min(scraperZ, lowerBackZ) - 0.08 - COIN_RADIUS,
      Math.max(
        upperCenterZ + GAME.pusherAmplitude - GAME.pusherDepth / 2 + COIN_RADIUS + 0.04,
        Math.min(scraperZ, lowerBackZ) - GAME.dropZoneScraperGap - COIN_RADIUS,
      ),
    ),
    pusherRearExtension: upperLength - GAME.pusherDepth,
  };
}

// Write a geometry back onto GAME, which is where the rest of the game reads its Z layout from.
export function applyMachineGeometry(saved) {
  const geometry = machineGeometryFor(saved);
  GAME.scraperZ = geometry.scraperZ;
  GAME.dropZoneZ = geometry.dropZoneZ;
  GAME.pusherOriginZ = geometry.upperCenterZ;
  GAME.pusherRearExtension = geometry.pusherRearExtension;
  GAME.playfieldFrontZ = geometry.lowerFrontZ;
  GAME.playfieldBackZ = geometry.lowerBackZ;
  GAME.edgeZ = geometry.edgeZ;
  return geometry;
}
