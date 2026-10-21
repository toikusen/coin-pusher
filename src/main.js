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
import { GameAudio } from './audio.js';
import { loadProgress, saveProgress } from './storage.js';
import { collectUI, GameUI, GEOMETRY_CONTROLS, TUNING_CONTROLS } from './ui.js';

const elements = collectUI();
const ui = new GameUI(elements);
const quality = getQualityProfile();
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
progress.geometry = pickGeometry(applyMachineGeometry(progress.geometry));
// Store only the five knobs, never the derived edges: saving the derivations would let a stale
// entry disagree with what machineGeometryFor produces today.
function pickGeometry(geometry) {
  return Object.fromEntries(GEOMETRY_CONTROLS.map(({ key }) => [key, geometry[key]]));
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
  missionComplete: false,
};

let game = null;
let autoTimer = 0;
let aimTimer = 0;
let aim = 0;

function persist() {
  saveProgress({
    bestScore: state.bestScore,
    soundEnabled: audio.enabled,
    hasSeenOnboarding: progress.hasSeenOnboarding,
    hdriHorizontal: progress.hdriHorizontal,
    hdriVertical: progress.hdriVertical,
    tuning: progress.tuning,
    geometry: progress.geometry,
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
  audio.drop();
  navigator.vibrate?.(12);
  renderState();
}

function setAim(nextAim) {
  aim = Math.min(1, Math.max(-1, Number.isFinite(nextAim) ? nextAim : 0));
  game?.setLauncherAim(aim);
  ui.setAim(aim);
}

function nudgeAim(direction, amount = 0.055) {
  if (!state.ready) return;
  setAim(aim + Math.sign(direction) * amount);
}

function stopAimMove() {
  window.clearInterval(aimTimer);
  aimTimer = 0;
}

function beginAimMove(direction) {
  stopAimMove();
  nudgeAim(direction, 0.09);
  aimTimer = window.setInterval(() => nudgeAim(direction), 45);
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
  // Sweep a predictable pattern across the tray so auto-play visibly uses the same launcher.
  const autoAims = [-0.72, -0.24, 0.24, 0.72, 0.24, -0.24];
  let autoAim = 0;
  const autoDrop = () => {
    setAim(autoAims[autoAim % autoAims.length]);
    autoAim += 1;
    attemptDrop();
  };
  autoDrop();
  autoTimer = window.setInterval(() => {
    if (!document.hidden && !elements.onboarding.open) autoDrop();
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
  navigator.vibrate?.([30, 40, 60]);
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
  navigator.vibrate?.([20, 30, 20, 40]);
}

// Seismographs. Like the money bag, the prize is a changed pile rather than points: the shake
// walks coins over the lip and they pay through the normal payout loop.
function awardQuake() {
  game?.shakeTable(GAME.quakeSeconds);
  // No reward panel: the prize is not a number, and the coins it shakes over the lip raise their
  // own '+N' a second later. A '+0' popup on a jackpot reads as a bug.
  ui.announce('地震大獎！檯面劇烈震動，硬幣被震落');
  audio.jackpot();
  navigator.vibrate?.([60, 30, 60, 30, 120]);
}

// Gilded coins. The only prize that multiplies what the player has already built instead of adding
// to it: a share of the plain coins on the machine turn premium, so it pays nothing on an empty
// machine, rewards a hoarded pile, and like the bag and the quake it only cashes out once those
// coins are pushed off.
function awardGild() {
  const coins = game?.gildCoins(GAME.gildRatio) ?? 0;
  if (coins === 0) {
    ui.announce('鍍金大獎！但檯面上沒有普通硬幣可以鍍');
    audio.error();
    return;
  }
  // Same convention as the money bag: the popup counts coins, not points. The points arrive later,
  // as those coins are pushed off and pay premiumValue instead of regularValue.
  ui.reward({ total: coins, combo: state.combo, premium: true, bonus: 0, jackpot: `鍍金 BONUS ×${coins} 枚` });
  ui.announce(`鍍金大獎！檯面上 ${coins} 枚硬幣變成 ${GAME.premiumValue} 分`);
  audio.jackpot();
  navigator.vibrate?.([20, 40, 20, 40, 20]);
}

// One entry per reel symbol, keyed the same as GAME.slotOutcomes. A new slot event is a config
// entry, a handler here, and nothing else - the reels and the chest are already symbol-agnostic.
const CHEST_PRIZES = {
  '7': awardJackpot,
  bag: awardCoinRain,
  quake: awardQuake,
  gild: awardGild,
};

// win is the slotWin result - the symbol three reels showed, or null. A miss still gets an
// announcement, because the player watched a chest cross the whole machine and silence reads as
// a bug.
function awardChestPrize(win) {
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
  ui.announce(`掉落 ${coins.length} 枚，獲得 ${result.total} 分，剩餘 ${state.credits} 枚硬幣`);
  if (result.bonus > 0) audio.jackpot();
  else audio.payout(premium);
  navigator.vibrate?.(result.bonus > 0 ? [25, 35, 45] : 20);

  for (let due = chestsDue(scoreBefore, state.score); due > 0; due -= 1) game?.dropChest(awardChestPrize);

  if (!state.missionComplete && state.score >= GAME.missionTarget) {
    state.missionComplete = true;
    ui.missionComplete();
    audio.jackpot();
  }
  // Only the best score can change here, and localStorage writes are synchronous - during a
  // payout run this is the one thing in the frame that touches disk.
  if (state.bestScore > progress.bestScore) {
    progress.bestScore = state.bestScore;
    persist();
  }
  renderState();
}

function resetSession() {
  stopAuto();
  // A payout still in the batch window belongs to the session being thrown away.
  clearPayout();
  state.score = 0;
  state.credits = GAME.startingCredits;
  state.combo = 0;
  state.lastScoreAt = -Infinity;
  state.missionComplete = false;
  game?.resetPile();
  ui.resetMission();
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
      progress.geometry = pickGeometry(geometry);
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
    progress.geometry = pickGeometry(game.setMachineGeometry(MACHINE_GEOMETRY_DEFAULTS, { reseed: true }));
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

  for (const [direction, button] of [[-1, elements.aimLeft], [1, elements.aimRight]]) {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      beginAimMove(direction);
    });
    button.addEventListener('pointerup', stopAimMove);
    button.addEventListener('pointerleave', stopAimMove);
    button.addEventListener('pointercancel', stopAimMove);
    // Keyboard activation dispatches click without a pointerdown.
    button.addEventListener('click', (event) => {
      if (event.detail === 0) nudgeAim(direction, 0.09);
    });
  }
  elements.aimSlider.addEventListener('input', () => setAim(Number(elements.aimSlider.value) / 100));
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
  elements.resetButton.addEventListener('click', resetSession);
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
  // Arrow/A-D repeats provide continuous travel. F/Space fires from the current reticle.
  elements.gameCanvas.addEventListener('keydown', (event) => {
    const direction = { ArrowLeft: -1, a: -1, A: -1, ArrowRight: 1, d: 1, D: 1 }[event.key];
    if (direction) {
      event.preventDefault();
      nudgeAim(direction, event.repeat ? 0.055 : 0.09);
    } else if (event.key === ' ' || event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (!event.repeat) attemptDrop();
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      if (!event.repeat) toggleAuto();
    }
  });
  window.addEventListener('blur', stopAimMove);
  document.addEventListener('visibilitychange', () => {
    stopAimMove();
    if (!game || elements.onboarding.open) return;
    if (document.hidden) game.stop();
    else game.start();
  });
  window.addEventListener('beforeunload', () => game?.destroy(), { once: true });
}

async function boot() {
  bindUI();
  setAim(0);
  renderState();
  try {
    game = await new CoinPusher(elements.gameCanvas, quality, {
      onAimChange: setAim,
      onScore: handleScore,
      onError: (message) => ui.error(message),
    }).init();
    game.setLauncherAim(aim);
    // Dev-only handle so motion can be measured from the console. Stripped from the build.
    if (import.meta.env.DEV) window.__game = game;
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
    window.cheats = CHEATS;
    if (CHEATS.chest > 0) CHEATS.drop(CHEATS.chest);
    state.ready = true;
    ui.ready();
    renderState();
    if (progress.hasSeenOnboarding) {
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
