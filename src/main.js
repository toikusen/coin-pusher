import './styles.css';
import { CoinPusher } from './game/CoinPusher.js';
import {
  GAME,
  MACHINE_GEOMETRY_DEFAULTS,
  applyMachineGeometry,
  getQualityProfile,
} from './game/config.js';
import { TUNING_DEFAULTS } from './game/physics.js';
import { CHEATS } from './game/cheats.js';
import { calculateReward, chestsDue } from './game/rules.js';
import { loadMissionState, localDay, rewardText, step } from './game/missions.js';
import { GameAudio } from './audio.js';
import { tapHaptic, thudHaptic, winHaptic } from './haptics.js';
import { hasHinge, watchHinge } from './hinge.js';
import { loadProgress, saveProgress } from './storage.js';
import { collectUI, GameUI, GEOMETRY_CONTROLS, RESET_CONFIRM_MS, resetConfirmed, TUNING_CONTROLS } from './ui.js';

const elements = collectUI();
const ui = new GameUI(elements);
const quality = getQualityProfile();
// The app shell reports the hinge (src/hinge.js). In a browser there is none to read, so
// ?hinge=<degrees> stands in for it: 180 lies the machine flat, 90 stands it up. The foldable
// layout (html[data-fold]) waits for a real reading, so a phone without a hinge keeps its own.
const hingeParam = new URLSearchParams(location.search).get('hinge');
const useFoldLayout = () => { document.documentElement.dataset.fold = ''; };
if (hingeParam !== null) useFoldLayout();
// The tuning panel is a developer tool: hidden in the markup so release builds never flash it.
if (import.meta.env.DEV) document.querySelector('.tune-dock').style.display = '';
const progress = loadProgress();
progress.hdriHorizontal = Number.isFinite(progress.hdriHorizontal)
  ? Math.min(180, Math.max(-180, progress.hdriHorizontal))
  : 0;
progress.hdriVertical = Number.isFinite(progress.hdriVertical)
  ? Math.min(90, Math.max(-90, progress.hdriVertical))
  : 0;

// Saved tuning comes back from localStorage, so it is untrusted: keep only known keys whose
// value is a finite number inside the range its own slider allows. A hand-edited or stale
// entry would otherwise reach cannon-es as NaN and quietly break every contact in the world.
function sanitiseTuning(saved) {
  if (!saved || typeof saved !== 'object') return {};
  const clean = {};
  for (const { id, key } of TUNING_CONTROLS) {
    // Require an actual number: Number(null) and Number('') are 0, which would silently pass
    // as a legitimate setting rather than being rejected.
    const value = saved[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const input = elements[id];
    clean[key] = Math.min(Number(input.max), Math.max(Number(input.min), value));
  }
  return clean;
}
progress.tuning = sanitiseTuning(progress.tuning);
// Before anything reads GAME's Z layout: machineGeometryFor() rejects and clamps on its own, so a
// hand-edited entry can only produce a machine that still holds together, and CoinPusher builds
// itself from whatever this leaves behind.
applyMachineGeometry(progress.geometry);
progress.geometry = pickGeometry(progress.geometry);
// Store only the knobs the player actually moved, never the derived edges or the defaults: saving
// the resolved defaults on every boot froze them, so a change to MACHINE_GEOMETRY_DEFAULTS never
// reached anyone who had played before.
function pickGeometry(geometry) {
  return Object.fromEntries(GEOMETRY_CONTROLS
    .map(({ key }) => [key, geometry[key]])
    .filter(([, value]) => Number.isFinite(value)));
}

const audio = new GameAudio(progress.soundEnabled);

const state = {
  ready: false,
  score: 0,
  credits: GAME.startingCredits,
  bestScore: progress.bestScore,
  combo: 0,
  lastScoreAt: -Infinity,
  auto: false,
};
let missions = loadMissionState(progress.mission, localDay());
const MISSION_REWARD_DELAY_MS = 1200;
// How long after a reward lands the next mission ignores payouts. The rained coins knock a burst off
// the lip, and counting it finished a 90-point mission in 11 s and a combo of 8 outright.
const MISSION_SETTLE_MS = 6000;
let missionPausedUntil = 0;
ui.setMission(missions);

let game = null;
let autoTimer = 0;

function persist() {
  saveProgress({
    bestScore: state.bestScore,
    soundEnabled: audio.enabled,
    hasSeenOnboarding: progress.hasSeenOnboarding,
    hdriHorizontal: progress.hdriHorizontal,
    hdriVertical: progress.hdriVertical,
    tuning: progress.tuning,
    geometry: progress.geometry,
    mission: missions,
  });
}

function renderState() {
  ui.update(state);
  ui.setAuto(state.auto);
  ui.setSound(audio.enabled);
}

function stopAuto() {
  state.auto = false;
  window.clearInterval(autoTimer);
  autoTimer = 0;
  ui.setAuto(false);
}

function attemptDrop() {
  if (!state.ready || !game) return;
  // Phone nearly shut: the machine is paused, so a press (or the auto timer) quietly does nothing
  // rather than charging a coin or sounding the jammed-slot error.
  if (game.closed) return;
  audio.ensureContext();
  if (state.credits <= 0) {
    stopAuto();
    audio.error();
    ui.announce('硬幣用完了，等待機台上的硬幣掉落，或重新開始。');
    return;
  }
  if (!game.drop()) {
    audio.error();
    ui.announce('投幣槽忙碌中，請稍後再試。');
    return;
  }
  state.credits -= 1;
  trackMission({ type: 'drop' });
  audio.drop();
  tapHaptic();
  renderState();
}

function toggleAuto() {
  if (!state.ready) return;
  if (state.auto) {
    stopAuto();
    ui.announce('已關閉自動投幣');
    return;
  }
  if (state.credits <= 0) {
    ui.announce('硬幣不足，無法開啟自動投幣');
    return;
  }
  state.auto = true;
  ui.setAuto(true);
  ui.announce('已開啟自動投幣');
  attemptDrop();
  autoTimer = window.setInterval(() => {
    // Held while the game is settling a new pile or its physics has fallen behind (CoinPusher
    // `busy`): dropping at wall-clock rate then would feed the pile faster than it moves.
    if (!document.hidden && !elements.onboarding.open && !game?.busy) attemptDrop();
  }, GAME.autoInterval * 1000);
}

// The game reports one frame's worth of coins per payout, and an avalanche spills over many
// frames. Collect them for a moment so one avalanche reads as one payout: one sound, one
// announcement, one save - instead of a burst of each in the same tenth of a second.
const PAYOUT_BATCH_MS = 140;
let payout = null;

function handleScore(coins, elapsed) {
  // Snapshot what the reward depends on: coin objects are pooled and reused, so holding the
  // objects across the batch window would let a recycled coin change what it paid.
  const dropped = coins.map((coin) => ({ isPremium: coin.isPremium }));
  if (payout) {
    payout.coins.push(...dropped);
    payout.elapsed = elapsed;
    return;
  }
  payout = { coins: dropped, elapsed, timer: window.setTimeout(flushPayout, PAYOUT_BATCH_MS) };
}

function clearPayout() {
  if (!payout) return;
  window.clearTimeout(payout.timer);
  payout = null;
}

// Paid when the chest's slot machine locks on 7s. It is score only, not credits: the chest is a
// prize for pushing coins off, and paying it in coins would let the player farm the loop.
function awardJackpot() {
  const reward = GAME.chestReward;
  state.score += reward;
  state.bestScore = Math.max(state.bestScore, state.score);
  ui.reward({ total: reward, combo: state.combo, premium: true, bonus: 0, jackpot: '寶箱 777 JACKPOT' });
  ui.announce(`寶箱 777！獲得 ${reward} 分`);
  audio.jackpot();
  winHaptic();
  if (state.bestScore > progress.bestScore) {
    progress.bestScore = state.bestScore;
    persist();
  }
  renderState();
}

// Money bags. Neither score nor credits: it rains real coins onto the tray, so the prize still has
// to be pushed off and goes through the normal payout loop rather than around it.
function awardCoinRain() {
  const coins = game?.rainCoins(GAME.coinRainCount) ?? 0;
  ui.reward({ total: coins, combo: state.combo, premium: true, bonus: 0, jackpot: `錢袋 BONUS ×${coins} 硬幣` });
  ui.announce(`錢袋大獎！${coins} 枚硬幣從天而降`);
  audio.jackpot();
  audio.coinRain();
  winHaptic();
}

// Seismographs. Like the money bag, the prize is a changed pile rather than points: the shake
// walks coins over the lip and they pay through the normal payout loop.
function awardQuake() {
  game?.shakeTable(GAME.quakeSeconds);
  // A banner, not the reward panel: the prize is not a number, and the coins it shakes over the
  // lip raise their own '+N' a second later. A '+0' popup on a jackpot reads as a bug.
  ui.notice('地震大獎！');
  ui.announce('地震大獎！檯面劇烈震動，硬幣被震落');
  audio.jackpot();
  winHaptic();
}

// Gilded coins. The only prize that multiplies what the player has already built instead of adding
// to it: a share of the plain coins on the machine turn premium, so it rewards a hoarded pile, and
// like the bag and the quake it only cashes out once those coins are pushed off. On a machine with
// nothing to gild it pays a money bag instead.
function awardGild() {
  const coins = game?.gildCoins(GAME.gildRatio) ?? 0;
  // Every chest pays, so a gild on a machine with nothing to gild becomes a money bag instead.
  if (coins === 0) {
    awardCoinRain();
    return;
  }
  // Same convention as the money bag: the popup counts coins, not points. The points arrive later,
  // as those coins are pushed off and pay premiumValue instead of regularValue.
  ui.reward({ total: coins, combo: state.combo, premium: true, bonus: 0, jackpot: `鍍金 BONUS ×${coins} 枚` });
  ui.announce(`鍍金大獎！檯面上 ${coins} 枚硬幣變成 ${GAME.premiumValue} 分`);
  audio.jackpot();
  winHaptic();
}

// Mission rewards are the chest prizes' machine events at a smaller size. A gild with nothing on
// the bed to gild becomes a few rained coins, as awardGild does.
const MISSION_REWARDS = {
  rain: (amount) => game?.rainCoins(amount),
  quake: (amount) => game?.shakeTable(amount),
  gild: (amount) => { if (!game?.gildCoins(amount)) game?.rainCoins(5); },
};

// Feeds one game event to the mission chain. A finish is saved at once, so a relaunch can neither
// lose the level nor pay it twice; the reward follows a beat later so it does not land on top of
// the chest prize or payout popup that finished the mission. Payouts in the settle window after a
// reward are the reward's own coins, so they do not count towards the next mission.
function trackMission(event) {
  if (event.type === 'payout' && performance.now() < missionPausedUntil) return;
  const result = step(missions, event, localDay());
  missions = result.state;
  if (result.finished) {
    persist();
    missionPausedUntil = performance.now() + MISSION_REWARD_DELAY_MS + MISSION_SETTLE_MS;
    const [reward, daily] = result.rewards;
    window.setTimeout(() => {
      for (const prize of result.rewards) MISSION_REWARDS[prize.type](prize.amount);
      const text = `任務完成！${rewardText(reward)}${daily ? `　今日加碼 ${rewardText(daily)}` : ''}`;
      ui.notice(text);
      ui.announce(text);
      audio.jackpot();
      winHaptic();
    }, MISSION_REWARD_DELAY_MS);
  }
  ui.setMission(missions);
}

// One entry per reel symbol, keyed the same as GAME.slotOutcomes. A new slot event is a config
// entry, a handler here, and nothing else - the reels and the chest are already symbol-agnostic.
const CHEST_PRIZES = {
  '7': awardJackpot,
  bag: awardCoinRain,
  quake: awardQuake,
  gild: awardGild,
};

// Chests dropped on the same turn - two thresholds crossed by one payout, or a batch held through
// a pile settle - are announced together, once.
let chestNotice = { count: 0, timer: 0 };
function noteChestDrop() {
  trackMission({ type: 'chest' });
  chestNotice.count += 1;
  if (chestNotice.timer) return;
  chestNotice.timer = window.setTimeout(() => {
    const { count } = chestNotice;
    chestNotice = { count: 0, timer: 0 };
    ui.notice(count > 1 ? `寶箱出現 ×${count}！` : '寶箱出現！');
    ui.announce(count > 1 ? `${count} 個寶箱掉進機台，把它推落就能轉拉霸` : '寶箱掉進機台，把它推落就能轉拉霸');
    audio.chestDrop();
    thudHaptic();
  }, 0);
}

// win is the slotWin result - the symbol three reels showed, or null. A miss still gets an
// announcement, because the player watched a chest cross the whole machine and silence reads as
// a bug.
function awardChestPrize(win) {
  trackMission({ type: 'open' });
  const prize = win && CHEST_PRIZES[win];
  if (!prize) {
    ui.announce('寶箱拉霸沒有對齊，這次沒有中獎');
    audio.error();
    return;
  }
  prize();
}

function flushPayout() {
  if (!payout) return;
  const { coins, elapsed } = payout;
  payout = null;
  const result = calculateReward(coins, state.combo, elapsed - state.lastScoreAt);
  const premium = coins.some((coin) => coin.isPremium);
  const scoreBefore = state.score;
  state.combo = result.combo;
  state.lastScoreAt = elapsed;
  state.score += result.total;
  state.credits += result.base;
  state.bestScore = Math.max(state.bestScore, state.score);

  ui.reward({ ...result, premium });
  ui.announce(`掉落 ${coins.length} 枚，獲得 ${result.total} 分`);
  if (result.bonus > 0) audio.jackpot();
  else audio.payout(premium);
  if (result.bonus > 0) thudHaptic();
  else tapHaptic();

  for (let due = chestsDue(scoreBefore, state.score); due > 0; due -= 1) game?.dropChest(awardChestPrize);

  trackMission({
    type: 'payout',
    score: result.total,
    premium: coins.filter((coin) => coin.isPremium).length,
    combo: result.combo,
  });
  // Only the best score can change here, and localStorage writes are synchronous - during a
  // payout run this is the one thing in the frame that touches disk.
  if (state.bestScore > progress.bestScore) {
    progress.bestScore = state.bestScore;
    persist();
  }
  renderState();
}

// The first tap arms reset and the second, inside RESET_CONFIRM_MS, goes through.
let resetArmedAt = -Infinity;
let resetDisarm = 0;
function disarmReset() {
  window.clearTimeout(resetDisarm);
  resetArmedAt = -Infinity;
  ui.armReset(false);
}
function tapReset() {
  const now = performance.now();
  if (resetConfirmed(resetArmedAt, now)) {
    disarmReset();
    resetSession();
    return;
  }
  resetArmedAt = now;
  ui.armReset(true);
  // A late disarm from the last arming must not cut this one short.
  window.clearTimeout(resetDisarm);
  resetDisarm = window.setTimeout(disarmReset, RESET_CONFIRM_MS);
}

function resetSession() {
  stopAuto();
  // A payout still in the batch window belongs to the session being thrown away.
  clearPayout();
  state.score = 0;
  state.credits = GAME.startingCredits;
  state.combo = 0;
  state.lastScoreAt = -Infinity;
  game?.resetPile();
  ui.announce('遊戲已重新開始');
  renderState();
  elements.gameCanvas.focus();
}

function showOnboarding() {
  stopAuto();
  game?.stop();
  if (!elements.onboarding.open) elements.onboarding.showModal();
}

function closeOnboarding() {
  progress.hasSeenOnboarding = true;
  persist();
  elements.onboarding.close();
  // The start tap is a user gesture: unlock audio and fetch the samples now, so the first coin
  // already has its recorded sound instead of the synthesised fallback.
  audio.ensureContext();
  game?.start();
  elements.gameCanvas.focus();
}

function bindUI() {
  const updateHdriRotation = (save = false) => {
    progress.hdriHorizontal = Number(elements.hdriHorizontal.value);
    progress.hdriVertical = Number(elements.hdriVertical.value);
    game?.setEnvironmentRotation(progress.hdriHorizontal, progress.hdriVertical);
    ui.setHdriRotation(progress.hdriHorizontal, progress.hdriVertical);
    if (save) persist();
  };

  for (const { id, key, digits, resize } of TUNING_CONTROLS) {
    const input = elements[id];
    const readout = elements[`${id}Value`];
    // Thickness resizes collision shapes and reseeds the pile, so it waits for release;
    // every other knob is safe to apply on each drag frame.
    const apply = (event) => {
      const value = Number(input.value);
      readout.value = value.toFixed(digits);
      if (resize && event.type === 'input') return;
      game?.setPhysics({ [key]: value });
      progress.tuning = { ...progress.tuning, [key]: value };
      if (event.type === 'change') persist();
    };
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
  }

  // Both events do the same work; only the release rebuilds the pile. Dragging leaves the coins
  // where they were - a pinched or floating coin during the drag is fine and self-corrects - but
  // the machine's collision always matches what is on screen, even mid-drag.
  for (const { id, key } of GEOMETRY_CONTROLS) {
    const input = elements[id];
    const applyGeometry = (event) => {
      if (!game) return;
      const geometry = game.setMachineGeometry(
        { [key]: Number(input.value) },
        { reseed: event.type === 'change' },
      );
      progress.geometry = { ...progress.geometry, [key]: geometry[key] };
      if (event.type !== 'change') {
        elements[`${id}Value`].value = Number(geometry[key]).toFixed(2);
        return;
      }
      // Only on release: the panel shows what the machine took, which the clamps can change.
      ui.setGeometry(geometry);
      persist();
    };
    input.addEventListener('input', applyGeometry);
    input.addEventListener('change', applyGeometry);
  }

  // Bonus-stage cheats. Deliberately not persisted: a forced slot result surviving a reload is
  // a bug report waiting to happen. The query string in game/cheats.js is the sticky version.
  ui.initCheats(CHEATS.slot);
  elements.cheatSlot.addEventListener('change', () => {
    CHEATS.slot = elements.cheatSlot.value || null;
    const option = elements.cheatSlot.selectedOptions[0];
    ui.announce(`拉霸結果：${option.textContent}`);
  });
  elements.cheatDrop.addEventListener('click', () => {
    CHEATS.drop(1);
    ui.announce('已投入一個測試寶箱，推過支付口才會開獎');
  });
  elements.cheatSpin.addEventListener('click', () => CHEATS.spin());

  elements.tuneGeometryReset.addEventListener('click', () => {
    if (!game) return;
    game.setMachineGeometry(MACHINE_GEOMETRY_DEFAULTS, { reseed: true });
    progress.geometry = {};
    ui.setGeometry(game.geometry);
    persist();
    ui.announce('機台幾何已回到預設值');
  });

  elements.tunePhysicsReset.addEventListener('click', () => {
    progress.tuning = {};
    game?.setPhysics({ ...TUNING_DEFAULTS, solverIterations: quality.solverIterations });
    if (game) ui.setTuning(game.tuning);
    persist();
    ui.announce('物理參數已回到預設值');
  });

  elements.dropButton.addEventListener('click', attemptDrop);
  elements.autoButton.addEventListener('click', toggleAuto);
  elements.soundButton.addEventListener('click', () => {
    audio.setEnabled(!audio.enabled);
    ui.setSound(audio.enabled);
    persist();
    ui.announce(audio.enabled ? '音效已開啟' : '音效已關閉');
  });
  elements.helpButton.addEventListener('click', showOnboarding);
  elements.startButton.addEventListener('click', closeOnboarding);
  elements.resetButton.addEventListener('click', tapReset);
  elements.retryButton.addEventListener('click', () => window.location.reload());
  elements.tuneToggle.addEventListener('click', () => {
    ui.setTunePanel(elements.tunePanel.hidden);
  });
  elements.tuneClose.addEventListener('click', () => {
    ui.setTunePanel(false);
    elements.tuneToggle.focus();
  });
  elements.hdriHorizontal.addEventListener('input', () => updateHdriRotation());
  elements.hdriHorizontal.addEventListener('change', () => updateHdriRotation(true));
  elements.hdriVertical.addEventListener('input', () => updateHdriRotation());
  elements.hdriVertical.addEventListener('change', () => updateHdriRotation(true));
  elements.hdriReset.addEventListener('click', () => {
    elements.hdriHorizontal.value = 0;
    elements.hdriVertical.value = 0;
    updateHdriRotation(true);
  });
  elements.onboarding.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeOnboarding();
  });
  elements.gameCanvas.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (!event.repeat) attemptDrop();
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      if (!event.repeat) toggleAuto();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!game || elements.onboarding.open) return;
    // iOS may end a backgrounded app without warning: this is the last sure moment to save the
    // mission progress, which a payout batch does not write.
    if (document.hidden) { persist(); game.stop(); }
    else game.start();
  });
  window.addEventListener('beforeunload', () => game?.destroy(), { once: true });
}

async function boot() {
  bindUI();
  renderState();
  try {
    game = await new CoinPusher(elements.gameCanvas, quality, {
      onScore: handleScore,
      onBoardHit: (kind, strength) => audio.boardHit(kind, strength),
      onStandUp: () => audio.powerOn(),
      // The last reel's lock is the prize itself, which brings its own sound and haptic.
      onReelStop: (index, last) => {
        audio.reelStop(index);
        if (!last) tapHaptic();
      },
      onReelTick: () => audio.reelTick(),
      onChestDrop: noteChestDrop,
      onError: (message) => ui.error(message),
    }).init();
    if (hingeParam !== null) game.setHingeAngle(Number(hingeParam));
    watchHinge((state) => {
      if (!hasHinge(state)) return;
      useFoldLayout();
      // A hinge with no angle yet reads as flat.
      game?.setHingeAngle(state.angle ?? 180);
    });
    // Dev-only handle so motion can be measured from the console. Stripped from the build.
    if (import.meta.env.DEV) window.__game = game;
    // Dev builds only: frame rate, physics time (mean / worst over half a second) and coins in play,
    // for checking the bed's coin count against a real phone.
    if (import.meta.env.DEV) {
      // A tight loop that a JIT finishes in a few ms and an interpreter (Lockdown Mode) in hundreds.
      const loopStart = performance.now();
      let sink = 0;
      for (let i = 0; i < 5e6; i += 1) sink = (sink + i * 7) % 1000003;
      const loopMs = performance.now() - loopStart;
      const perfLabel = document.createElement('output');
      perfLabel.className = 'perf-overlay';
      document.body.append(perfLabel);
      setInterval(() => {
        const perf = game.perf;
        if (perf) perfLabel.textContent = `${perf.fps.toFixed(0)} fps · physics ${perf.physicsMs.toFixed(1)} / ${perf.physicsMaxMs.toFixed(1)} ms · render ${perf.renderMs.toFixed(1)} ms · ${perf.coins} coins · dpr ${perf.pixelRatio} · ${perf.build} · js ${loopMs.toFixed(0)} ms${sink < 0 ? '' : ''}`;
      }, 500);
    }
    game.setEnvironmentRotation(progress.hdriHorizontal, progress.hdriVertical);
    ui.setHdriRotation(progress.hdriHorizontal, progress.hdriVertical);
    if (Object.keys(progress.tuning).length > 0) game.setPhysics(progress.tuning);
    ui.setTuning(game.tuning);
    ui.setGeometry(game.geometry);
    // Console handle for the bonus stage - see game/cheats.js for the query string equivalents.
    CHEATS.drop = (count = 1) => {
      for (let index = 0; index < count; index += 1) game?.dropChest(awardChestPrize);
    };
    CHEATS.spin = () => game?.spinSlot(awardChestPrize);
    if (import.meta.env.DEV) window.cheats = CHEATS;
    if (CHEATS.chest > 0) CHEATS.drop(CHEATS.chest);
    state.ready = true;
    ui.ready();
    renderState();
    if (CHEATS.bench) {
      game.start();
      toggleAuto();
    } else if (progress.hasSeenOnboarding) {
      game.start();
      elements.gameCanvas.focus();
    } else {
      showOnboarding();
    }
  } catch (error) {
    state.ready = false;
    ui.error(error instanceof Error ? error.message : '未知的啟動錯誤，請重新載入。');
    renderState();
  }
}

boot();
