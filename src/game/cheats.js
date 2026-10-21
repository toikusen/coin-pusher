// Dev cheats for the bonus stage. Everything here is off unless asked for, and nothing needs a
// rebuild: the query string sets it up on load, the console handle changes it live.
//
//   ?slot=7      every spin locks on 777
//   ?slot=bag    every spin locks on three money bags
//   ?slot=miss   every spin misses outright, no two faces alike
//   ?chest=3     drop three chests as soon as the machine is ready
//
//   cheats.slot = 'bag'   from the console, takes effect on the next spin
//   cheats.drop(1)        drop a chest now - it still has to ride the machine
//   cheats.spin()         skip the ride and spin the reels now
//
// ponytail: a plain mutable object, not a settings UI. It is a debug hatch for two knobs, and the
// query string plus the console already cover both. Upgrade path: a panel if a tester needs one.
const params = typeof location === 'undefined'
  ? new URLSearchParams()
  : new URLSearchParams(location.search);

export const CHEATS = {
  // null, a symbol from GAME.slotOutcomes, or 'miss'.
  slot: params.get('slot'),
  // How many chests to drop on boot.
  chest: Number(params.get('chest')) || 0,
  // Wired up in main.js, where the game instance and the prize handlers live.
  drop: () => {},
  spin: () => {},
};
